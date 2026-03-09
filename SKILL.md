---
name: audio-clip-and-publish
description: |
  Upload an audio file, auto-detect deletions, apply edits, and publish the edited result to your account (viewable in the platform).

  This skill calls your existing backend APIs and uses a bearer token to bind the run to a platform account.
Keywords:
  - audio
  - podcast
  - editing
  - transcription
  - oss
license: MIT
allowed-tools:
  - Bash
metadata:
  clawdbot:
    requires:
      bins:
        - node
---

## What it does

1. Upload an audio file to the platform (server upload).
2. Start transcription, poll until finished.
3. Run deletion detection, poll until finished.
4. Apply edits, poll if FC async mode is used.
5. Output an `audioId` you can open on the platform.

## Auth / account binding

Configure your token (recommended):

1. Copy `audio-skill/.env.example` to `audio-skill/.env`
2. Set:
   - `AUDIO_SKILL_TOKEN` (required)
   - `AUDIO_SKILL_BACKEND_URL` (optional, default `http://localhost:3001`)

Environment variables are also supported and override `.env`.

## Run

- `node audio-skill/scripts/run.mjs --file /path/to/audio.mp3`

## How transcription works

- The skill uploads audio to your platform account first.
- The transcription step is executed by the backend with local Whisper.
- The backend server must have both `whisper` and `ffmpeg` available in `PATH`.
- If Whisper is missing, the backend now returns a clear install hint instead of a vague failure.

## Install Whisper on the server

macOS:

- `brew install ffmpeg`
- `python3 -m pip install -U openai-whisper`

Ubuntu / Debian:

- `sudo apt-get update && sudo apt-get install -y ffmpeg python3 python3-pip`
- `python3 -m pip install -U openai-whisper`

After installation, verify:

- `whisper --help`
- `ffmpeg -version`

## Test flow

1. Smoke test token and backend connectivity:
   - `node audio-skill/scripts/smoke.mjs`
2. Full end-to-end test with an audio file:
   - `node audio-skill/scripts/run.mjs --file /path/to/audio.mp3 --language zh`
3. If transcription stays at `Preparing transcription...`, inspect backend logs first because that means upload/auth succeeded and the job is stuck in backend transcription execution.

Notes:
- This uses `/api/audio/upload` (multipart form) for upload.
- For OSS direct-upload flows you can extend later; current version prioritizes the simplest end-to-end path.
