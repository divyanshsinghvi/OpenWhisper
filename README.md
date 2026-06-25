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
| `moonshine` | Moonshine v2 | ~150 ms | Multilingual fallback. |
| `parakeet-streaming` | Parakeet TDT v3 | bursty | Not natively streaming; left for batch use. |

Switch engines via `OPENWHISPER_TRANSCRIPTION_ENGINE` or in Settings.

## Adding media

Drop assets into `docs/media/`:

- `hero.png` — header screenshot
- `demo.gif` or `demo.mp4` — short recording of dictation in action
- `architecture.png` — optional diagram

GitHub also lets you drag a video into the issue/PR composer to get a
`user-attachments` URL — paste that under **Demo**.

## License

MIT
