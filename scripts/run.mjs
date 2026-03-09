#!/usr/bin/env node

/**
 * clip-skill — full pipeline runner
 *
 * Modes:
 *   clip  (default) — Upload, transcribe, detect deletions, apply edits.
 *   quote           — Upload, transcribe, extract gold quotes, create quote audio.
 *
 * Usage:
 *   node scripts/run.mjs --file /path/to/audio.mp3
 *   node scripts/run.mjs --file audio.mp3 --instruction "把前面讲吃饭的部分去掉"
 *   node scripts/run.mjs --file audio.mp3 --instruction "只保留10分钟到18分钟" --start 600 --end 1080
 *   node scripts/run.mjs --file audio.mp3 --mode quote --instruction "提取情绪最强的金句"
 *
 * Required env:
 *   CLIP_SKILL_TOKEN          Personal Access Token from podaha.com/tokens
 *
 * Optional env:
 *   CLIP_SKILL_BACKEND_URL    Defaults to https://api.podaha.com
 *   CLIP_SKILL_LANGUAGE       Defaults to zh (overridden by --language flag)
 */

import { readFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
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
  const args = {
    file: null,
    language: null,
    instruction: null,
    mode: 'clip',   // 'clip' | 'quote'
    start: null,    // seconds (number), for time-range cutting
    end: null,      // seconds (number), for time-range cutting
    help: false,
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--file')        args.file        = argv[++i];
    else if (a === '--language')    args.language    = argv[++i];
    else if (a === '--instruction') args.instruction = argv[++i];
    else if (a === '--mode')        args.mode        = argv[++i];
    else if (a === '--start')       args.start       = parseFloat(argv[++i]);
    else if (a === '--end')         args.end         = parseFloat(argv[++i]);
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
    console.error('[clip-skill]   4. Add it to your .env:  CLIP_SKILL_TOKEN=pat_...');
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

function printResult({ backendUrl, audioId, label = 'DONE' }) {
  const platformBase = backendUrl.includes('localhost') ? backendUrl : 'https://podaha.com';
  console.log(`\n[clip-skill] ✓ ${label}`);
  console.log('[clip-skill] audioId:', audioId);
  console.log('[clip-skill] view on platform:', `${platformBase}/audio/${audioId}`);
  console.log('[clip-skill] platform API:', `${backendUrl}/api/audio/${audioId}`);
  console.log('[clip-skill] stream:', `${backendUrl}/api/audio/${audioId}/stream`);
}

// ── Transcribe (shared step) ──────────────────────────────────────────────────

async function transcribe({ backendUrl, token, audioId, language }) {
  console.log('[clip-skill] starting transcription...');
  await httpJson(`${backendUrl}/api/editing/transcribe`, {
    method: 'POST',
    token,
    body: { audioId, language },
  });

  const status = await waitJob({
    name: 'transcription',
    poll: () => httpJson(`${backendUrl}/api/editing/transcription/${audioId}/status`, { token }),
    isDone: (s) => s?.status === 'succeeded' || s?.status === 'failed',
  });

  if (status.status !== 'succeeded') {
    const reason = status.error || status.message || 'unknown error';
    throw new Error(`transcription failed: ${reason}`);
  }
  return status;
}

// ── Mode: clip ────────────────────────────────────────────────────────────────
// Detects and deletes unwanted segments.
// Supports:
//   - Auto-detect fillers/pauses (no instruction)
//   - Instruction-based: "把讲吃饭的部分去掉" (--instruction)
//   - Time-range cutting: --start 0 --end 180 deletes the first 3 minutes

async function runClip({ backendUrl, token, audioId, instruction, start, end }) {
  let deletedSegmentIds = [];

  // Time-range mode: fetch transcription, filter segments by time
  if (start != null || end != null) {
    console.log(`[clip-skill] time-range cut: removing segments outside [${start ?? 0}s – ${end ?? '∞'}s]`);
    const transcription = await httpJson(
      `${backendUrl}/api/editing/transcription/${audioId}`,
      { token }
    );
    const segments = transcription?.transcription?.segments || transcription?.segments || [];

    if (segments.length === 0) {
      throw new Error('No transcription segments found for time-range cut');
    }

    const keepStart = start ?? 0;
    const keepEnd   = end   ?? Infinity;

    // Segments that fall entirely outside [keepStart, keepEnd] get deleted
    deletedSegmentIds = segments
      .filter(s => s.end <= keepStart || s.start >= keepEnd)
      .map(s => s.id);

    console.log(`[clip-skill] found ${deletedSegmentIds.length} segment(s) outside time range`);
  } else {
    // Instruction-based or auto deletion detection
    if (instruction) {
      console.log(`[clip-skill] instruction: "${instruction}"`);
    } else {
      console.log('[clip-skill] detecting deletion segments (auto mode)...');
    }

    await httpJson(`${backendUrl}/api/editing/detect-deletions`, {
      method: 'POST',
      token,
      body: {
        audioId,
        ...(instruction ? { customPrompt: instruction } : {}),
      },
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

    deletedSegmentIds = deletionStatus?.result?.segmentIds || [];
    console.log(`[clip-skill] found ${deletedSegmentIds.length} segment(s) to remove`);
  }

  // Apply edits
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
}

// ── Mode: quote ───────────────────────────────────────────────────────────────
// Extracts gold-quote segments and creates a concatenated highlight audio.

async function runQuote({ backendUrl, token, audioId, instruction }) {
  if (instruction) {
    console.log(`[clip-skill] quote instruction: "${instruction}"`);
  }

  // 1) Extract quotes
  console.log('[clip-skill] extracting quotes...');
  await httpJson(`${backendUrl}/api/editing/extract-quotes`, {
    method: 'POST',
    token,
    body: {
      audioId,
      ...(instruction ? { customPrompt: instruction } : {}),
    },
  });

  const quoteStatus = await waitJob({
    name: 'extract-quotes',
    poll: () => httpJson(`${backendUrl}/api/editing/extract-quotes/${audioId}/status`, { token }),
    isDone: (s) => s?.status === 'succeeded' || s?.status === 'failed',
  });

  if (quoteStatus.status !== 'succeeded') {
    const reason = quoteStatus.error || quoteStatus.message || 'unknown error';
    throw new Error(`extract-quotes failed: ${reason}`);
  }

  const quotes = quoteStatus?.result?.quotes || [];
  if (quotes.length === 0) {
    console.log('[clip-skill] no quotes found — nothing to create');
    return;
  }

  console.log(`[clip-skill] found ${quotes.length} quote(s):`);
  quotes.forEach((q, i) => {
    const dur = ((q.endTime ?? q.end_time ?? 0) - (q.startTime ?? q.start_time ?? 0)).toFixed(1);
    console.log(`  [${i + 1}] (${dur}s) ${q.text?.slice(0, 60)}${q.text?.length > 60 ? '…' : ''}`);
  });

  // 2) Create highlight audio from all quotes
  console.log('[clip-skill] creating highlight audio...');
  const quoteIds = quotes.map(q => q.id);

  await httpJson(`${backendUrl}/api/editing/create-intro`, {
    method: 'POST',
    token,
    body: { audioId, quoteIds },
  });

  const introStatus = await waitJob({
    name: 'create-intro',
    poll: () => httpJson(`${backendUrl}/api/editing/create-intro/${audioId}/status`, { token }),
    isDone: (s) => s?.status === 'succeeded' || s?.status === 'failed' || s?.status === 'idle',
    timeoutMs: 20 * 60 * 1000,
  });

  if (introStatus.status === 'failed') {
    const reason = introStatus.error || introStatus.message || 'unknown error';
    throw new Error(`create-intro failed: ${reason}`);
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const args = parseArgs(process.argv);

  if (args.help || !args.file) {
    console.log('Usage: node scripts/run.mjs --file <path> [options]');
    console.log('');
    console.log('Required:');
    console.log('  --file <path>             Audio or video file to process');
    console.log('');
    console.log('Optional:');
    console.log('  --instruction "<text>"    Natural-language editing instruction (Chinese or English)');
    console.log('  --mode clip|quote         clip = delete segments (default); quote = extract highlights');
    console.log('  --start <seconds>         Keep content starting from this time (for time-range cut)');
    console.log('  --end <seconds>           Keep content up to this time (for time-range cut)');
    console.log('  --language <lang>         Transcription language, default: zh');
    console.log('');
    console.log('Examples:');
    console.log('  node scripts/run.mjs --file podcast.mp3');
    console.log('  node scripts/run.mjs --file podcast.mp3 --instruction "把前面讲吃饭的部分去掉"');
    console.log('  node scripts/run.mjs --file podcast.mp3 --start 600 --end 1080   # keep 10–18 min');
    console.log('  node scripts/run.mjs --file podcast.mp3 --mode quote --instruction "提取情绪最强的金句"');
    console.log('');
    console.log('Auth:');
    console.log('  Set CLIP_SKILL_TOKEN in .env — get one at https://podaha.com/tokens');
    process.exit(args.help ? 0 : 1);
  }

  const token      = requireEnv('CLIP_SKILL_TOKEN');
  const backendUrl = (process.env.CLIP_SKILL_BACKEND_URL || 'https://api.podaha.com').replace(/\/$/, '');
  const language   = args.language || process.env.CLIP_SKILL_LANGUAGE || 'zh';
  const mode       = args.mode || 'clip';

  if (!['clip', 'quote'].includes(mode)) {
    console.error(`[clip-skill] ERROR: unknown --mode "${mode}". Use "clip" or "quote".`);
    process.exit(1);
  }

  console.log('[clip-skill] backend:', backendUrl);
  console.log('[clip-skill] mode:', mode);
  console.log('[clip-skill] language:', language);

  // 1) Upload
  console.log('[clip-skill] uploading:', args.file);
  const { audioId } = await uploadFile({ backendUrl, token, filePath: args.file });
  console.log('[clip-skill] uploaded → audioId:', audioId);

  // 2) Transcribe
  await transcribe({ backendUrl, token, audioId, language });

  // 3) Mode-specific pipeline
  if (mode === 'quote') {
    await runQuote({ backendUrl, token, audioId, instruction: args.instruction });
  } else {
    await runClip({ backendUrl, token, audioId, instruction: args.instruction, start: args.start, end: args.end });
  }

  // 4) Done
  printResult({ backendUrl, audioId });
}

main().catch((err) => {
  console.error('\n[clip-skill] ERROR:', err?.message || err);
  process.exit(1);
});
