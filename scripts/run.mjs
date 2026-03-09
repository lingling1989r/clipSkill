#!/usr/bin/env node

/**
 * clip-skill — full pipeline runner
 *
 * Uploads an audio/video file to PodAha, transcribes it, detects deletion
 * segments, applies edits, and prints a link to view the result.
 *
 * Usage:
 *   node scripts/run.mjs --file /path/to/audio.mp3 [--language zh]
 *
 * Required env:
 *   CLIP_SKILL_TOKEN          Personal Access Token from podaha.com/tokens
 *
 * Optional env:
 *   CLIP_SKILL_BACKEND_URL    Defaults to https://api.podaha.com
 *   CLIP_SKILL_LANGUAGE       Defaults to zh (overridden by --language flag)
 */

import { readFile } from 'node:fs/promises';
import { createReadStream, existsSync, readFileSync } from 'node:fs';
import { basename } from 'node:path';

// ── Load .env ─────────────────────────────────────────────────────────────────

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

// ── Helpers ───────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const args = { file: null, language: null, help: false };
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
  if (!v) {
    console.error(`\n[clip-skill] ERROR: ${name} is not set.`);
    console.error('[clip-skill] You need a PodAha Personal Access Token.');
    console.error('[clip-skill] Steps:');
    console.error('[clip-skill]   1. Register at https://podaha.com (free)');
    console.error('[clip-skill]   2. Go to Settings → API Tokens');
    console.error('[clip-skill]   3. Click "Create Token" and copy it');
    console.error('[clip-skill]   4. Add it to your .env file:');
    console.error('[clip-skill]        cp .env.example .env');
    console.error('[clip-skill]        # then set CLIP_SKILL_TOKEN=pat_...');
    process.exit(1);
  }
  return v;
}

async function sleep(ms) {
  await new Promise((r) => setTimeout(r, ms));
}

async function httpJson(url, { method = 'GET', token, body } = {}) {
  const headers = {
    Accept: 'application/json',
    ...(body ? { 'Content-Type': 'application/json' } : {}),
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
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
  const fd = new FormData();
  fd.set('audio', new Blob([await readFile(filePath)]), basename(filePath));

  const res = await fetch(`${backendUrl}/api/audio/upload`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
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

async function waitJob({ name, poll, isDone, intervalMs = 2000, timeoutMs = 10 * 60 * 1000 }) {
  const start = Date.now();
  process.stdout.write(`[clip-skill] waiting for ${name}`);
  while (true) {
    await sleep(intervalMs);
    process.stdout.write('.');
    const s = await poll();
    if (isDone(s)) {
      process.stdout.write(' done\n');
      return s;
    }
    if (Date.now() - start > timeoutMs) {
      process.stdout.write('\n');
      throw new Error(`${name} timed out after ${Math.round(timeoutMs / 1000)}s`);
    }
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const args = parseArgs(process.argv);

  if (args.help || !args.file) {
    console.log('Usage: node scripts/run.mjs --file /path/to/audio.mp3 [--language zh]');
    console.log('');
    console.log('Required:');
    console.log('  --file <path>       Audio or video file to process');
    console.log('');
    console.log('Optional:');
    console.log('  --language <lang>   Transcription language (default: zh)');
    console.log('');
    console.log('Auth:');
    console.log('  Set CLIP_SKILL_TOKEN in .env (copy from .env.example)');
    console.log('  Get a token at: https://podaha.com/tokens');
    process.exit(args.help ? 0 : 1);
  }

  const token = requireEnv('CLIP_SKILL_TOKEN');
  const backendUrl = (process.env.CLIP_SKILL_BACKEND_URL || 'https://api.podaha.com').replace(/\/$/, '');
  const language = args.language || process.env.CLIP_SKILL_LANGUAGE || 'zh';

  console.log('[clip-skill] backend:', backendUrl);
  console.log('[clip-skill] language:', language);

  // 1) Upload
  console.log('[clip-skill] uploading:', args.file);
  const { audioId } = await uploadFile({ backendUrl, token, filePath: args.file });
  console.log('[clip-skill] uploaded → audioId:', audioId);

  // 2) Transcribe
  console.log('[clip-skill] starting transcription...');
  await httpJson(`${backendUrl}/api/editing/transcribe`, {
    method: 'POST',
    token,
    body: { audioId, language },
  });

  const transcriptionStatus = await waitJob({
    name: 'transcription',
    poll: () => httpJson(`${backendUrl}/api/editing/transcription/${audioId}/status`, { token }),
    isDone: (s) => s?.status === 'succeeded' || s?.status === 'failed',
  });

  if (transcriptionStatus.status !== 'succeeded') {
    const reason = transcriptionStatus.error || transcriptionStatus.message || 'unknown error';
    throw new Error(`transcription failed: ${reason}`);
  }

  // 3) Detect deletions
  console.log('[clip-skill] detecting deletion segments...');
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
    const reason = deletionStatus.error || deletionStatus.message || 'unknown error';
    throw new Error(`detect-deletions failed: ${reason}`);
  }

  const deletedSegmentIds = deletionStatus?.result?.segmentIds || [];
  console.log(`[clip-skill] found ${deletedSegmentIds.length} segment(s) to remove`);

  // 4) Apply edits
  if (deletedSegmentIds.length === 0) {
    console.log('[clip-skill] no segments to delete — skipping apply-edits');
  } else {
    console.log('[clip-skill] applying edits...');
    await httpJson(`${backendUrl}/api/editing/apply-edits`, {
      method: 'POST',
      token,
      body: { audioId, deletedSegmentIds },
    });

    const applyStatus = await waitJob({
      name: 'apply-edits',
      poll: () => httpJson(`${backendUrl}/api/editing/apply-edits/${audioId}/status`, { token }),
      isDone: (s) => s?.status === 'succeeded' || s?.status === 'failed' || s?.status === 'idle',
      timeoutMs: 20 * 60 * 1000,
    });

    if (applyStatus.status === 'failed') {
      const reason = applyStatus.error || applyStatus.message || 'unknown error';
      throw new Error(`apply-edits failed: ${reason}`);
    }
  }

  // 5) Print result
  const platformBase = backendUrl.includes('localhost')
    ? `${backendUrl}`
    : 'https://podaha.com';

  console.log('\n[clip-skill] ✓ DONE');
  console.log('[clip-skill] audioId:', audioId);
  console.log('[clip-skill] view on platform:', `${platformBase}/audio/${audioId}`);
  console.log('[clip-skill] platform API:', `${backendUrl}/api/audio/${audioId}`);
  console.log('[clip-skill] stream:', `${backendUrl}/api/audio/${audioId}/stream`);
}

main().catch((err) => {
  console.error('\n[clip-skill] ERROR:', err?.message || err);
  process.exit(1);
});
