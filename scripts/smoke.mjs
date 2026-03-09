#!/usr/bin/env node

/**
 * clip-skill — smoke test
 *
 * Verifies that your token and backend connection are working.
 *
 * Usage:
 *   node scripts/smoke.mjs
 */

import { existsSync, readFileSync } from 'node:fs';

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

function requireEnv(name) {
  const v = process.env[name];
  if (!v) {
    console.error(`[smoke] ERROR: ${name} is not set.`);
    console.error('[smoke] Copy .env.example → .env and fill in your PodAha token.');
    console.error('[smoke] Get a token at: https://podaha.com/tokens');
    process.exit(1);
  }
  return v;
}

async function httpJson(url, { method = 'GET', token } = {}) {
  const headers = {
    Accept: 'application/json',
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
  const res = await fetch(url, { method, headers });
  const text = await res.text();
  let json;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = { raw: text };
  }
  if (!res.ok) {
    const msg = json?.error || json?.message || `HTTP ${res.status}`;
    throw new Error(`${method} ${url} → ${msg}`);
  }
  return json;
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const token = requireEnv('CLIP_SKILL_TOKEN');
  const backendUrl = (process.env.CLIP_SKILL_BACKEND_URL || 'https://api.podaha.com').replace(/\/$/, '');

  console.log('[smoke] backend:', backendUrl);

  // 1) Check identity
  let email = '(unknown)';
  try {
    const me = await httpJson(`${backendUrl}/api/auth/me`, { token });
    email = me?.user?.email || me?.email || email;
    console.log(`[smoke] /api/auth/me ok — email: ${email}`);
  } catch (err) {
    console.warn(`[smoke] /api/auth/me not available (${err.message}); continuing`);
  }

  // 2) Check audio list
  const list = await httpJson(`${backendUrl}/api/audio`, { token });
  if (!list || !Array.isArray(list.audios)) {
    throw new Error('Unexpected response from /api/audio — expected { audios: [...] }');
  }
  console.log(`[smoke] /api/audio ok, items: ${list.audios.length}`);

  console.log('[smoke] All checks passed ✓');
}

main().catch((err) => {
  console.error('[smoke] ERROR:', err?.message || err);
  process.exit(1);
});
