# Local Whisper dictation

LearnHarness can dictate with a self-hosted Whisper server instead of Deepgram. Deepgram stays the default; pick the engine under **Settings → Providers → Dictation → Engine**.

Any server exposing the OpenAI-compatible `POST /v1/audio/transcriptions` works. This folder ships a recipe for [speaches](https://speaches.ai/) (faster-whisper) in Docker.

## How it works

Dictation already inserts the transcript once, when you stop. So the Whisper engine is batch, not streaming:

1. **Start**: the app checks that `WHISPER_URL` is set and the server answers. It does this while the mic is opening, so a stopped container fails before you speak.
2. **Recording**: audio stays in the window, up to about 10 minutes (the cap stops the run automatically). The meter works as usual.
3. **Stop**: one WAV goes to the app's own `/api/stt/transcribe`, which forwards it to `WHISPER_URL`. The text lands in the input. Nothing leaves your machine.

A run that never gets louder than the meter's floor is not sent, because Whisper tends to invent text ("Thank you for watching.") on silence.

## Setup

1. **Start the server** from this folder (`docker/whisper/`). NVIDIA GPU; on Windows this needs Docker Desktop with the WSL2 backend:

   ```sh
   cd docker/whisper
   docker compose up -d
   ```

   CPU only:

   ```sh
   docker compose -f compose.yaml -f compose.cpu.yaml up -d
   ```

   From the repo root instead, pass the full paths: `docker compose -f docker/whisper/compose.yaml up -d`.

2. **Download the model** once (it lands in the `hf-hub-cache` volume). The default model is `Systran/faster-whisper-large-v3`:

   ```sh
   curl -X POST http://localhost:8000/v1/models/Systran/faster-whisper-large-v3
   ```

   Run this from any terminal on the host while the container is up. In Windows PowerShell type `curl.exe`, not `curl`, which is an alias for a different command there. The download is about 3 GB, and the call returns when it finishes (`Model '…' downloaded`, or `already exists`). `curl http://localhost:8000/v1/models` lists what is installed. If you have [uv](https://docs.astral.sh/uv/), `uvx speaches-cli model download <id>` does the same thing.

3. **Point LearnHarness at it**: under **Settings → Providers → Dictation**, set **Whisper (local)** to `http://localhost:8000` and switch **Engine** to **Whisper (local)**. In dev you can set `WHISPER_URL=http://localhost:8000` in `.env.local` instead.

4. **Check it**:

   ```sh
   curl http://localhost:8000/v1/models
   ```

## Auto-start with the desktop app

When the dictation engine is **Whisper (local)** and `WHISPER_URL` points at this machine (`localhost`, `127.0.0.1` or `::1`), the desktop app brings the server up when it opens:

1. If the server already answers, it does nothing.
2. If Docker isn't running, it starts Docker Desktop (`docker desktop start`).
3. It runs `docker start learnharness-whisper`.

This runs in the background and never delays the app opening. The result is written to `logs/main.log` in the app's user-data folder (on Windows, `%APPDATA%\LearnHarness\logs\main.log`); search for `whisper:`.

The app doesn't ship the compose file, so you still need to run `docker compose up -d` here **once** to create the container. After that, opening the app is enough. The container keeps running when you quit the app, so the next open is instant. Stop it with `docker stop learnharness-whisper` if you want the GPU memory back.

## Choosing a model

`WHISPER_MODEL` overrides the model ID. Put it in `.env.local` in dev, or in `auth.json` next to `WHISPER_URL` in the desktop app. Download whichever model you choose first.

| Model | Notes |
| --- | --- |
| `Systran/faster-whisper-large-v3` | Default. Best accuracy; ~3–4 GB VRAM in float16. |
| `Systran/faster-whisper-medium` | Lighter GPUs. |
| `Systran/faster-whisper-small` | CPU-friendly. |
| `Systran/faster-distil-whisper-small.en` | English only, fast on CPU. |

To use OpenAI's hosted Whisper or another OpenAI-compatible host instead, set `WHISPER_URL` to its base URL and `WHISPER_MODEL` to its model ID. Hosted APIs that need an API key aren't supported yet; the proxy sends no `Authorization` header.

## Troubleshooting

| Message | Cause |
| --- | --- |
| *Dictation needs a Whisper server URL* | `WHISPER_URL` isn't set. Clicking the message opens the settings row. |
| *Whisper server unreachable at …* | The container isn't running or the port is wrong. Check `docker ps`. |
| *Whisper model "…" not found on the server* | Run step 2 for that model ID. |
| *Whisper transcription timed out* | The server took more than 120 s. Use a smaller model or a GPU. |
