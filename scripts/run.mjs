#!/usr/bin/env node

/**
 * clip-skill — full pipeline runner with session state
 *
 * Modes:
 *   clip  (default) — Upload, transcribe, detect deletions, apply edits.
 *   quote           — Upload, transcribe, extract gold quotes, create quote audio.
 *
 * Session state (.session.json) persists audioIds across runs so the bot can
 * do multi-turn editing without re-uploading or re-transcribing.
 *
 * Usage:
 *   # First time: upload and process
 *   node scripts/run.mjs --file audio.mp3
 *   node scripts/run.mjs --file audio.mp3 --instruction "把前面讲吃饭的部分去掉"
 *
 *   # Follow-up on SAME audio (no re-upload, no re-transcribe)
 *   node scripts/run.mjs --audio-id <id> --mode quote
 *   node scripts/run.mjs --audio-id <id> --instruction "再把开头也去掉"
 *
 *   # Use the LAST uploaded audio automatically
 *   node scripts/run.mjs --last --instruction "把口头禅也去掉"
 *
 *   # List recent sessions (so bot can pick the right one)
 *   node scripts/run.mjs --list
 *
 *   # Time-range cutting
 *   node scripts/run.mjs --last --start 600 --end 1080
 *
 * Required env:
 *   CLIP_SKILL_TOKEN          Personal Access Token from podaha.com/tokens
 *
 * Optional env:
 *   CLIP_SKILL_BACKEND_URL    Defaults to https://api.podaha.com
 *   CLIP_SKILL_LANGUAGE       Defaults to zh
 */

import { readFile, writeFile, unlink } from 'node:fs/promises';
import { existsSync, readFileSync, createWriteStream } from 'node:fs';
import { basename, resolve, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SESSION_FILE = resolve(__dirname, '.session.json');
const MAX_SESSIONS = 10;

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
    ) value = value.slice(1, -1);
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

loadDotEnv();

// ── Session state ─────────────────────────────────────────────────────────────

function loadSessions() {
  try {
    if (!existsSync(SESSION_FILE)) return [];
    return JSON.parse(readFileSync(SESSION_FILE, 'utf8'));
  } catch {
    return [];
  }
}

async function saveSession(entry) {
  const sessions = loadSessions();
  // Replace existing entry for same audioId, or prepend new one
  const filtered = sessions.filter(s => s.audioId !== entry.audioId);
  const updated = [entry, ...filtered].slice(0, MAX_SESSIONS);
  await writeFile(SESSION_FILE, JSON.stringify(updated, null, 2));
}

function printSessions() {
  const sessions = loadSessions();
  if (sessions.length === 0) {
    console.log('[clip-skill] No sessions yet. Upload a file first.');
    return;
  }
  console.log('[clip-skill] Recent sessions (newest first):');
  console.log('');
  sessions.forEach((s, i) => {
    const when = new Date(s.uploadedAt).toLocaleString('zh-CN', { hour12: false });
    const dur  = s.duration ? ` ${Math.round(s.duration)}s` : '';
    const tag  = i === 0 ? ' ← last' : '';
    console.log(`  [${i + 1}] ${s.originalName}${dur}${tag}`);
    console.log(`       audioId: ${s.audioId}`);
    console.log(`       上传于:   ${when}`);
    console.log('');
  });
  console.log('  用 --audio-id <audioId> 继续操作某个音频');
  console.log('  用 --last 自动使用最近一个');
}

// ── Arg parsing ───────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const args = {
    file: null,
    url: null,        // download from HTTP URL (e.g. Feishu file link)
    urlToken: null,   // Bearer token for authenticated URLs (e.g. Feishu access token)
    audioId: null,    // operate on existing audio, skip upload
    last: false,      // use last session's audioId
    list: false,      // print sessions and exit
    language: null,
    instruction: null,
    mode: 'clip',
    start: null,
    end: null,
    help: false,
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if      (a === '--file')        args.file        = argv[++i];
    else if (a === '--url')         args.url         = argv[++i];
    else if (a === '--url-token')   args.urlToken    = argv[++i];
    else if (a === '--audio-id')    args.audioId     = argv[++i];
    else if (a === '--last')        args.last        = true;
    else if (a === '--list')        args.list        = true;
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
    console.error('[clip-skill]   1. Register at https://podaha.com (free)');
    console.error('[clip-skill]   2. Settings → API Tokens → Create Token');
    console.error('[clip-skill]   3. cp .env.example .env  →  set CLIP_SKILL_TOKEN=pat_...');
    process.exit(1);
  }
  return v;
}

// ── HTTP ──────────────────────────────────────────────────────────────────────

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
  try { json = text ? JSON.parse(text) : null; }
  catch { json = { raw: text }; }
  if (!res.ok) {
    const msg     = json?.error || json?.message || `HTTP ${res.status}`;
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
    const msg     = json?.error || json?.message || `HTTP ${res.status}`;
    const details = json?.details ? ` | ${json.details}` : '';
    throw new Error(`upload failed: ${msg}${details}`);
  }
  const audioId = json?.audio?.id;
  if (!audioId) throw new Error('upload succeeded but audioId missing in response');
  return { audioId, audio: json.audio };
}

// ── URL download (for large files e.g. Feishu) ───────────────────────────────

async function downloadFromUrl(url, { token } = {}) {
  const headers = token ? { Authorization: `Bearer ${token}` } : {};
  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error(`download failed: HTTP ${res.status} ${url}`);

  // Derive filename from Content-Disposition header or URL path
  const cd             = res.headers.get('content-disposition') || '';
  const nameFromHeader = cd.match(/filename\*?=(?:UTF-8'')?["']?([^"';\r\n]+)/i)?.[1]?.trim();
  const nameFromUrl    = decodeURIComponent(url.split('?')[0].split('/').pop() || '');
  const fileName       = nameFromHeader || nameFromUrl || `audio-${Date.now()}.mp3`;

  const totalBytes = parseInt(res.headers.get('content-length') || '0', 10);
  const tmpPath    = resolve(tmpdir(), `clipskill-${Date.now()}-${fileName}`);
  const fileStream = createWriteStream(tmpPath);

  let downloaded = 0;
  process.stdout.write(`[clip-skill] downloading ${fileName}`);
  if (totalBytes > 0) process.stdout.write(` (${(totalBytes / 1024 / 1024).toFixed(1)}MB)`);
  process.stdout.write('\n');

  // Stream response body chunk-by-chunk into temp file (no full-memory load)
  const reader = res.body.getReader();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    await new Promise((ok, fail) => fileStream.write(value, e => e ? fail(e) : ok()));
    downloaded += value.length;
    if (totalBytes > 0) {
      const pct = Math.round(downloaded / totalBytes * 100);
      const mb  = (downloaded / 1024 / 1024).toFixed(1);
      process.stdout.write(`\r[clip-skill] downloading... ${pct}% (${mb}MB)   `);
    } else {
      process.stdout.write('.');
    }
  }
  await new Promise((ok, fail) => fileStream.end(e => e ? fail(e) : ok()));
  process.stdout.write('\r[clip-skill] download complete                          \n');

  return { localPath: tmpPath, fileName };
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

function printResult({ backendUrl, audioId }) {
  const platformBase = backendUrl.includes('localhost') ? backendUrl : 'https://podaha.com';
  console.log('\n[clip-skill] ✓ DONE');
  console.log('[clip-skill] audioId:', audioId);
  console.log('[clip-skill] 查看结果:', `${platformBase}/audio/${audioId}`);
  console.log('[clip-skill] 继续编辑: node scripts/run.mjs --audio-id', audioId, '--instruction "..."');
}

// ── Transcribe ────────────────────────────────────────────────────────────────

async function ensureTranscription({ backendUrl, token, audioId, language }) {
  // Check if transcription already exists
  const status = await httpJson(
    `${backendUrl}/api/editing/transcription/${audioId}/status`,
    { token }
  ).catch(() => null);

  if (status?.status === 'succeeded') {
    console.log('[clip-skill] transcription already exists, skipping');
    return;
  }

  console.log('[clip-skill] starting transcription...');
  await httpJson(`${backendUrl}/api/editing/transcribe`, {
    method: 'POST',
    token,
    body: { audioId, language },
  });

  const result = await waitJob({
    name: 'transcription',
    poll: () => httpJson(`${backendUrl}/api/editing/transcription/${audioId}/status`, { token }),
    isDone: (s) => s?.status === 'succeeded' || s?.status === 'failed',
  });

  if (result.status !== 'succeeded') {
    throw new Error(`transcription failed: ${result.error || result.message || 'unknown'}`);
  }
}

// ── Mode: clip ────────────────────────────────────────────────────────────────

async function runClip({ backendUrl, token, audioId, instruction, start, end }) {
  let deletedSegmentIds = [];

  if (start != null || end != null) {
    console.log(`[clip-skill] time-range cut: keeping [${start ?? 0}s – ${end ?? '∞'}s]`);
    const transcription = await httpJson(
      `${backendUrl}/api/editing/transcription/${audioId}`,
      { token }
    );
    const segments = transcription?.transcription?.segments || transcription?.segments || [];
    if (segments.length === 0) throw new Error('No transcription segments found for time-range cut');

    const keepStart = start ?? 0;
    const keepEnd   = end   ?? Infinity;
    deletedSegmentIds = segments
      .filter(s => s.end <= keepStart || s.start >= keepEnd)
      .map(s => s.id);

    console.log(`[clip-skill] found ${deletedSegmentIds.length} segment(s) outside time range`);
  } else {
    if (instruction) {
      console.log(`[clip-skill] instruction: "${instruction}"`);
    } else {
      console.log('[clip-skill] detecting deletion segments (auto mode)...');
    }

    await httpJson(`${backendUrl}/api/editing/detect-deletions`, {
      method: 'POST',
      token,
      body: { audioId, ...(instruction ? { customPrompt: instruction } : {}) },
    });

    const deletionStatus = await waitJob({
      name: 'detect-deletions',
      poll: () => httpJson(`${backendUrl}/api/editing/detect-deletions/${audioId}/status`, { token }),
      isDone: (s) => s?.status === 'succeeded' || s?.status === 'failed',
    });

    if (deletionStatus.status !== 'succeeded') {
      throw new Error(`detect-deletions failed: ${deletionStatus.error || deletionStatus.message || 'unknown'}`);
    }

    deletedSegmentIds = deletionStatus?.result?.segmentIds || [];
    console.log(`[clip-skill] found ${deletedSegmentIds.length} segment(s) to remove`);
  }

  if (deletedSegmentIds.length === 0) {
    console.log('[clip-skill] no segments to delete — skipping apply-edits');
    return;
  }

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
    throw new Error(`apply-edits failed: ${applyStatus.error || applyStatus.message || 'unknown'}`);
  }
}

// ── Mode: quote ───────────────────────────────────────────────────────────────

async function runQuote({ backendUrl, token, audioId, instruction }) {
  if (instruction) console.log(`[clip-skill] quote instruction: "${instruction}"`);

  console.log('[clip-skill] extracting quotes...');
  await httpJson(`${backendUrl}/api/editing/extract-quotes`, {
    method: 'POST',
    token,
    body: { audioId, ...(instruction ? { customPrompt: instruction } : {}) },
  });

  const quoteStatus = await waitJob({
    name: 'extract-quotes',
    poll: () => httpJson(`${backendUrl}/api/editing/extract-quotes/${audioId}/status`, { token }),
    isDone: (s) => s?.status === 'succeeded' || s?.status === 'failed',
  });

  if (quoteStatus.status !== 'succeeded') {
    throw new Error(`extract-quotes failed: ${quoteStatus.error || quoteStatus.message || 'unknown'}`);
  }

  const quotes = quoteStatus?.result?.quotes || [];
  if (quotes.length === 0) {
    console.log('[clip-skill] no quotes found — nothing to create');
    return;
  }

  console.log(`[clip-skill] found ${quotes.length} quote(s):`);
  quotes.forEach((q, i) => {
    const dur = ((q.endTime ?? 0) - (q.startTime ?? 0)).toFixed(1);
    console.log(`  [${i + 1}] (${dur}s) ${q.text?.slice(0, 60)}${q.text?.length > 60 ? '…' : ''}`);
  });

  console.log('[clip-skill] creating highlight audio...');
  await httpJson(`${backendUrl}/api/editing/create-intro`, {
    method: 'POST',
    token,
    body: { audioId, quoteIds: quotes.map(q => q.id) },
  });

  const introStatus = await waitJob({
    name: 'create-intro',
    poll: () => httpJson(`${backendUrl}/api/editing/create-intro/${audioId}/status`, { token }),
    isDone: (s) => s?.status === 'succeeded' || s?.status === 'failed' || s?.status === 'idle',
    timeoutMs: 20 * 60 * 1000,
  });

  if (introStatus.status === 'failed') {
    throw new Error(`create-intro failed: ${introStatus.error || introStatus.message || 'unknown'}`);
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const args = parseArgs(process.argv);

  if (args.list) { printSessions(); return; }

  if (args.help) {
    console.log('Usage: node scripts/run.mjs [source] [options]');
    console.log('');
    console.log('Source (pick one):');
    console.log('  --file <path>             Upload a new audio/video file (local path)');
    console.log('  --url <url>               Download from URL then upload (e.g. Feishu file link)');
    console.log('  --url-token <token>       Bearer token for authenticated URLs (e.g. Feishu access token)');
    console.log('  --audio-id <id>           Operate on an already-uploaded audio (no re-upload)');
    console.log('  --last                    Use the last uploaded audio automatically');
    console.log('  --list                    List recent sessions and exit');
    console.log('');
    console.log('Options:');
    console.log('  --instruction "<text>"    Natural-language editing instruction');
    console.log('  --mode clip|quote         clip = delete segments (default); quote = extract highlights');
    console.log('  --start <seconds>         Keep content from this time onward');
    console.log('  --end <seconds>           Keep content up to this time');
    console.log('  --language <lang>         Transcription language, default: zh');
    console.log('');
    console.log('Examples:');
    console.log('  node scripts/run.mjs --file podcast.mp3');
    console.log('  node scripts/run.mjs --url "https://..." --instruction "把口头禅去掉"');
    console.log('  node scripts/run.mjs --url "https://..." --url-token <feishu_token>');
    console.log('  node scripts/run.mjs --last --instruction "再把金句也提一下"');
    console.log('  node scripts/run.mjs --audio-id abc-123 --mode quote');
    console.log('  node scripts/run.mjs --last --start 600 --end 1080');
    console.log('  node scripts/run.mjs --list');
    process.exit(0);
  }

  const token      = requireEnv('CLIP_SKILL_TOKEN');
  const backendUrl = (process.env.CLIP_SKILL_BACKEND_URL || 'https://api.podaha.com').replace(/\/$/, '');
  const language   = args.language || process.env.CLIP_SKILL_LANGUAGE || 'zh';
  const mode       = args.mode || 'clip';

  if (!['clip', 'quote'].includes(mode)) {
    console.error(`[clip-skill] ERROR: unknown --mode "${mode}". Use "clip" or "quote".`);
    process.exit(1);
  }

  // ── Resolve audioId ──────────────────────────────────────────────────────

  let audioId;
  let skipUpload = false;

  if (args.last) {
    const sessions = loadSessions();
    if (sessions.length === 0) {
      console.error('[clip-skill] ERROR: no previous sessions found. Use --file to upload first.');
      process.exit(1);
    }
    audioId    = sessions[0].audioId;
    skipUpload = true;
    console.log(`[clip-skill] using last session: ${sessions[0].originalName} (${audioId})`);

  } else if (args.audioId) {
    audioId    = args.audioId;
    skipUpload = true;
    console.log(`[clip-skill] using existing audio: ${audioId}`);

  } else if (args.url) {
    // URL download path — handled below in upload section
  } else if (args.file) {
    // normal upload path
  } else {
    console.error('[clip-skill] ERROR: specify --file, --url, --audio-id, --last, or --list.');
    console.error('             Run with --help for usage.');
    process.exit(1);
  }

  console.log('[clip-skill] backend:', backendUrl);
  console.log('[clip-skill] mode:', mode);

  // ── Upload (if needed) ───────────────────────────────────────────────────

  if (!skipUpload) {
    let localPath   = args.file;
    let tmpToClean  = null;
    let displayName = args.file ? basename(args.file) : null;

    if (args.url) {
      console.log('[clip-skill] fetching from URL:', args.url);
      const { localPath: dl, fileName } = await downloadFromUrl(args.url, { token: args.urlToken });
      localPath   = dl;
      tmpToClean  = dl;
      displayName = fileName;
    }

    console.log('[clip-skill] uploading:', displayName || localPath);
    const { audioId: newId, audio } = await uploadFile({ backendUrl, token, filePath: localPath });
    audioId = newId;
    console.log('[clip-skill] uploaded → audioId:', audioId);

    // Clean up temp file after upload
    if (tmpToClean) await unlink(tmpToClean).catch(() => {});

    // Persist session
    await saveSession({
      audioId,
      originalName: audio?.originalName || displayName || basename(localPath),
      duration:     audio?.duration     || null,
      uploadedAt:   new Date().toISOString(),
    });
    console.log('[clip-skill] session saved (use --last or --audio-id', audioId, 'to continue)');
  }

  // ── Transcribe (skip if already done) ────────────────────────────────────

  await ensureTranscription({ backendUrl, token, audioId, language });

  // ── Edit ─────────────────────────────────────────────────────────────────

  if (mode === 'quote') {
    await runQuote({ backendUrl, token, audioId, instruction: args.instruction });
  } else {
    await runClip({ backendUrl, token, audioId, instruction: args.instruction, start: args.start, end: args.end });
  }

  printResult({ backendUrl, audioId });
}

main().catch((err) => {
  console.error('\n[clip-skill] ERROR:', err?.message || err);
  process.exit(1);
});
