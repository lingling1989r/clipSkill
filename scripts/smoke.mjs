#!/usr/bin/env node

// Minimal smoke check that auth + basic APIs work.
// Requires:
// - AUDIO_SKILL_TOKEN
// - AUDIO_SKILL_BACKEND_URL (optional)

import { existsSync, readFileSync } from 'node:fs';

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

function requireEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env ${name}`);
  return v;
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
    throw new Error(`${method} ${url} failed: ${msg}`);
  }

  return json;
}

async function main() {
  const token = requireEnv('AUDIO_SKILL_TOKEN');
  const backendUrl = process.env.AUDIO_SKILL_BACKEND_URL || 'http://localhost:3001';

  const me = await httpJson(`${backendUrl}/api/auth/me`, { token }).catch(() => null);
  if (me) {
    console.log('[smoke] /api/auth/me ok');
  } else {
    console.log('[smoke] /api/auth/me not available or unauthorized; continuing');
  }

  const list = await httpJson(`${backendUrl}/api/audio`, { token });
  const total = Array.isArray(list?.audios) ? list.audios.length : 0;
  console.log('[smoke] /api/audio ok, items:', total);
}

main().catch((err) => {
  console.error('[smoke] ERROR:', err?.message || err);
  process.exit(1);
});
