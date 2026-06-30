# OpenWhisper

System-wide voice dictation. Press a key, speak, watch your words appear in any textbox.
100% offline.

![Hero](./docs/media/hero.png)

## Demo

https://github.com/user-attachments/assets/replace-with-your-upload

> Or drop a `.mp4`/`.gif` at `docs/media/demo.mp4` and reference it here.

![Dictation in action](./docs/media/demo.gif)

## Quick start

```bash
# macOS audio capture
brew install sox

# Linux audio capture
sudo apt-get install sox alsa-utils

# Optional Linux pyautogui backend. Skip if you do not have sudo;
# the installer also adds a pynput keyboard fallback in the virtualenv.
sudo apt-get install python3-tk python3-dev

# Linux: point Electron/keyboard automation at the active X display if DISPLAY is unset
export DISPLAY=$(ls /tmp/.X11-unix/ | sed 's/X/:/' | head -n 1)

npm install
./install-nemotron.sh         # python deps + ONNX model (~630 MB)
npm run build
OPENWHISPER_TRANSCRIPTION_ENGINE=nemotron-streaming npm start
```

Press `Ctrl+Shift+Space` (or `Cmd+Shift+Space` on macOS) → speak → text streams into your focused textbox.

## Linux package setup

The AppImage and `.deb` include the Electron app, helper scripts, and Nemotron
model files. On first launch, if Python speech packages are missing, Listen
shows an in-app setup screen that creates a private virtual environment under
the app data directory and installs the required Python packages there. This
does not require sudo.

## How it works

A long-lived Python process owns the microphone and runs a streaming ASR model
via [sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx). Partials are emitted
over stdio as you speak and typed into whatever app has focus.

![Architecture](./docs/media/architecture.png)

## Engines

| Engine | Model | Latency | Notes |
|---|---|---|---|
| `nemotron-streaming` *(recommended)* | NVIDIA Nemotron Speech Streaming En 0.6B (ONNX, int8) | ~100 ms | True streaming. Auto-downloaded. |
| `elevenlabs-v2` | ElevenLabs Scribe v2 realtime | network-dependent | Cloud transcription. Requires `ELEVENLABS_API_KEY`. |
| `cartesia-ink2` | Cartesia Ink 2 realtime | network-dependent | Cloud transcription. Requires `CARTESIA_API_KEY`. |
| `moonshine` | Moonshine v2 | ~150 ms | Multilingual fallback. |
| `parakeet-streaming` | Parakeet TDT v3 | bursty | Not natively streaming; left for batch use. |

Switch engines via `OPENWHISPER_TRANSCRIPTION_ENGINE` or in Settings. Local
development also loads `.env` automatically; shell environment variables take
precedence over `.env`.

ElevenLabs Scribe v2 realtime:

```bash
ELEVENLABS_API_KEY=... OPENWHISPER_TRANSCRIPTION_ENGINE=elevenlabs-v2 npm start
```

Cartesia Ink 2 realtime:

```bash
CARTESIA_API_KEY=... OPENWHISPER_TRANSCRIPTION_ENGINE=cartesia-ink2 npm start
```

Cloud engines pause their provider WebSocket after 3 seconds of local silence to
avoid accidental long-running billable sessions. Local VAD keeps listening and
automatically reconnects the cloud stream when you speak again. Listen uses
local WebRTC VAD first and falls back to RMS volume detection if the native VAD
module is unavailable. Tune or disable it with:

```bash
OPENWHISPER_AUTO_STOP_SILENCE_MS=3000
OPENWHISPER_VAD_MODE=webrtc
OPENWHISPER_WEBRTC_VAD_AGGRESSIVENESS=2
OPENWHISPER_WEBRTC_VAD_MIN_SPEECH_RATIO=0.5
OPENWHISPER_VAD_RMS_THRESHOLD=500
OPENWHISPER_VAD_DEBUG=1
```

Set `OPENWHISPER_AUTO_STOP_SILENCE_MS=0` to disable cloud pausing, or
`OPENWHISPER_VAD_MODE=rms` to force the fallback RMS detector. Use
`OPENWHISPER_VAD_DEBUG=1` to print once-per-second speech/silence diagnostics.

Listen also keeps a local estimate of cumulative cloud STT audio duration and
raises a desktop notification after 5 minutes by default:

```bash
OPENWHISPER_CLOUD_USAGE_ALERT_MS=300000
```

Set `OPENWHISPER_CLOUD_USAGE_ALERT_MS=0` to disable usage alerts. The ledger is
stored locally in the app data directory and is an estimate based on recording
duration, not a provider invoice readout.

Cloud STT pricing snapshot:

| Provider | Model | Listed unit | Approx included STT |
|---|---|---:|---:|
| ElevenLabs | Scribe v2 | 330 credits/min | Free: ~30 min/month; Starter $6: ~1.5 h/month |
| Cartesia | Ink 2 | plan-included STT hours | Free: ~1 h 51 min/month; Pro $5: ~9 h 16 min/month |

Cartesia is substantially cheaper for STT on listed plan-included usage. Check
the vendor pricing pages before relying on these numbers for production:
[ElevenLabs pricing](https://elevenlabs.io/pricing) and
[Cartesia pricing](https://www.cartesia.ai/pricing).

## Adding media

Drop assets into `docs/media/`:

- `hero.png` — header screenshot
- `demo.gif` or `demo.mp4` — short recording of dictation in action
- `architecture.png` — optional diagram

GitHub also lets you drag a video into the issue/PR composer to get a
`user-attachments` URL — paste that under **Demo**.

## License

MIT
