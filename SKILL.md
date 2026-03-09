---
name: clip-skill
description: |
  Upload an audio or video file to PodAha, auto-detect filler/deletion segments, apply edits, and publish the result to your account for playback.

  Requires a Personal Access Token from podaha.com to bind results to your account.
keywords:
  - audio
  - podcast
  - clip
  - editing
  - transcription
license: MIT
allowed-tools:
  - Bash
metadata:
  clawdbot:
    requires:
      bins:
        - node
    setup:
      - prompt: |
          To use this skill you need a **PodAha Personal Access Token**.

          Steps to get your token:
          1. Register or log in at https://podaha.com
          2. Go to Settings → API Tokens (or visit https://podaha.com/tokens)
          3. Click "Create Token", give it a name (e.g. "clipskill")
          4. Copy the token (starts with `pat_`)

          Then configure it:

          ```bash
          cp .env.example .env
          # Edit .env and set CLIP_SKILL_TOKEN=pat_xxx...
          ```

          Or pass it inline:
          ```bash
          CLIP_SKILL_TOKEN=pat_xxx node scripts/run.mjs --file /path/to/audio.mp3
          ```
---

## What it does

1. Upload an audio or video file to PodAha (server upload).
2. Transcribe the audio (using Whisper on the backend).
3. Detect filler/deletion segments automatically.
4. Apply edits to produce a clean clipped version.
5. Output an `audioId` you can open directly on podaha.com to listen to the result.

## Auth / account binding — **required**

This skill binds each upload to your PodAha account via a Personal Access Token.

**How to get your token:**
1. Register at **https://podaha.com** (free)
2. Go to **Settings → API Tokens**
3. Click **"Create Token"**, copy the token (it starts with `pat_`)

**Configure:**
```bash
cp .env.example .env
# Edit .env:
# CLIP_SKILL_TOKEN=pat_your_token_here
# CLIP_SKILL_BACKEND_URL=https://api.podaha.com  (default, no change needed)
```

Environment variables are also supported and take priority over `.env`.

## Smoke test (verify token + connectivity)

```bash
node scripts/smoke.mjs
```

Expected output:
```
[smoke] /api/auth/me ok — email: you@example.com
[smoke] /api/audio ok, items: 3
[smoke] All checks passed ✓
```

## Run

```bash
node scripts/run.mjs --file /path/to/audio.mp3
```

Options:
| Flag | Default | Description |
|------|---------|-------------|
| `--file` | *(required)* | Path to audio/video file |
| `--language` | `zh` | Transcription language (`zh`, `en`, etc.) |

## View results

After the skill finishes, open the printed URL on podaha.com to play back the clipped audio:

```
[clip-skill] DONE
[clip-skill] audioId: abc-123
[clip-skill] view on platform: https://podaha.com/audio/abc-123
[clip-skill] platform API: https://api.podaha.com/api/audio/abc-123
```

## Install Whisper on the backend server (if self-hosting)

macOS:
```bash
brew install ffmpeg
python3 -m pip install -U openai-whisper
```

Ubuntu / Debian:
```bash
sudo apt-get update && sudo apt-get install -y ffmpeg python3 python3-pip
python3 -m pip install -U openai-whisper
```

Verify:
```bash
whisper --help
ffmpeg -version
```

## Troubleshooting

| Symptom | Cause | Fix |
|---------|-------|-----|
| `Missing env CLIP_SKILL_TOKEN` | Token not set | Copy `.env.example` → `.env` and fill in token |
| `HTTP 401` on upload | Token invalid or revoked | Create a new token at podaha.com/tokens |
| `Preparing transcription...` hangs | Backend Whisper not installed | Install Whisper on the backend server |
| `transcription failed` | Unsupported language or audio | Try `--language en` or check backend logs |
