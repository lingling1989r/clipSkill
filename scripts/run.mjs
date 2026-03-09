#!/usr/bin/env node

import { readFile } from 'node:fs/promises';
import { createReadStream, existsSync, readFileSync } from 'node:fs';
import { basename } from 'node:path';

function loadDotEnv(filePath = new URL('../.env', import.meta.url)) {
  if (!existsSync(filePath)) return;

  const raw = readFileSync(filePath, 'utf8');
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;

    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();

    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    if (process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

loadDotEnv();

function parseArgs(argv) {
  const args = { file: null, language: 'zh' };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--file') args.file = argv[++i];
    else if (a === '--language') args.language = argv[++i];
    else if (a === '--help' || a === '-h') args.help = true;
  }
  return args;
}

function requireEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env ${name}`);
  return v;
}

async function sleep(ms) {
  await new Promise((r) => setTimeout(r, ms));
}

async function httpJson(url, { method = 'GET', token, body } = {}) {
  const headers = {
    'Accept': 'application/json',
    ...(body ? { 'Content-Type': 'application/json' } : {}),
    ...(token ? { 'Authorization': `Bearer ${token}` } : {}),
  };

  const res = await fetch(url, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });

  const text = await res.text();
  let json;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = { raw: text };
  }

  if (!res.ok) {
    const msg = json?.error || json?.message || `HTTP ${res.status}`;
    const details = json?.details ? ` | ${json.details}` : '';
    throw new Error(`${method} ${url} failed: ${msg}${details}`);
  }

  return json;
}

async function uploadFile({ backendUrl, token, filePath }) {
  // Use undici FormData (Node 18+ provides global FormData)
  const fd = new FormData();
  fd.set('audio', new Blob([await readFile(filePath)]), basename(filePath));

  const res = await fetch(`${backendUrl}/api/audio/upload`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      // Do not set Content-Type; fetch will set multipart boundary.
    },
    body: fd,
  });

  const json = await res.json().catch(() => null);
  if (!res.ok) {
    const msg = json?.error || json?.message || `HTTP ${res.status}`;
    const details = json?.details ? ` | ${json.details}` : '';
    throw new Error(`upload failed: ${msg}${details}`);
  }

  const audioId = json?.audio?.id;
  if (!audioId) throw new Error('upload succeeded but audioId missing in response');
  return { audioId, response: json };
}

async function waitJob({ name, poll, isDone, timeoutMs = 10 * 60 * 1000 }) {
  const start = Date.now();
  while (true) {
    const s = await poll();
    if (isDone(s)) return s;
    if (Date.now() - start > timeoutMs) {
      throw new Error(`${name} timed out after ${Math.round(timeoutMs / 1000)}s`);
    }
    await sleep(1000);
  }
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.help || !args.file) {
    console.log('Usage: node audio-skill/scripts/run.mjs --file /path/to/audio.mp3 [--language zh]');
    process.exit(args.help ? 0 : 1);
  }

  const token = requireEnv('AUDIO_SKILL_TOKEN');
  const backendUrl = process.env.AUDIO_SKILL_BACKEND_URL || 'http://localhost:3001';

  console.log('[audio-skill] backendUrl:', backendUrl);

  // 1) upload
  console.log('[audio-skill] uploading:', args.file);
  const { audioId } = await uploadFile({ backendUrl, token, filePath: args.file });
  console.log('[audio-skill] uploaded audioId:', audioId);

  // 2) transcribe (async)
  console.log('[audio-skill] starting transcription...');
  await httpJson(`${backendUrl}/api/editing/transcribe`, {
    method: 'POST',
    token,
    body: { audioId, language: args.language },
  });

  const transcriptionStatus = await waitJob({
    name: 'transcription',
    poll: () => httpJson(`${backendUrl}/api/editing/transcription/${audioId}/status`, { token }),
    isDone: (s) => s?.status === 'succeeded' || s?.status === 'failed',
  });
  if (transcriptionStatus.status !== 'succeeded') {
    throw new Error(`transcription failed: ${transcriptionStatus.error || transcriptionStatus.message || 'unknown'}`);
  }
  console.log('[audio-skill] transcription done');

  // 3) detect deletions
  console.log('[audio-skill] starting deletion detection...');
  await httpJson(`${backendUrl}/api/editing/detect-deletions`, {
    method: 'POST',
    token,
    body: { audioId },
  });

  const deletionStatus = await waitJob({
    name: 'detect-deletions',
    poll: () => httpJson(`${backendUrl}/api/editing/detect-deletions/${audioId}/status`, { token }),
    isDone: (s) => s?.status === 'succeeded' || s?.status === 'failed',
  });
  if (deletionStatus.status !== 'succeeded') {
    throw new Error(`detect-deletions failed: ${deletionStatus.error || deletionStatus.message || 'unknown'}`);
  }

  const deletedSegmentIds = deletionStatus?.result?.segmentIds || [];
  console.log('[audio-skill] deletion detection done, segments:', deletedSegmentIds.length);

  // 4) apply edits (may be sync or async depending on FC mode)
  if (deletedSegmentIds.length === 0) {
    console.log('[audio-skill] no segments to delete; skipping apply-edits');
  } else {
    console.log('[audio-skill] applying edits...');
    const applyRes = await httpJson(`${backendUrl}/api/editing/apply-edits`, {
      method: 'POST',
      token,
      body: { audioId, deletedSegmentIds },
    });

    // In FC mode backend returns 202 and job is tracked by status endpoint.
    // In local mode backend returns 200 with editedAudioPath.
    const applyStatus = await waitJob({
      name: 'apply-edits',
      poll: () => httpJson(`${backendUrl}/api/editing/apply-edits/${audioId}/status`, { token }),
      isDone: (s) => s?.status === 'succeeded' || s?.status === 'failed' || s?.status === 'idle',
      timeoutMs: 20 * 60 * 1000,
    });

    if (applyStatus.status === 'failed') {
      throw new Error(`apply-edits failed: ${applyStatus.error || applyStatus.message || 'unknown'}`);
    }

    console.log('[audio-skill] apply-edits done');
  }

  // 5) show result entrypoint
  console.log('\n[audio-skill] DONE');
  console.log('[audio-skill] audioId:', audioId);
  console.log('[audio-skill] platform API metadata:', `${backendUrl}/api/audio/${audioId}`);
  console.log('[audio-skill] playback (temporary auth bypass):', `${backendUrl}/api/audio/${audioId}/stream`);
}

main().catch((err) => {
  console.error('[audio-skill] ERROR:', err?.message || err);
  process.exit(1);
});
