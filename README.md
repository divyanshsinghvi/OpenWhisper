# Listen - Voice-to-Text App

A multi-platform voice-to-text app with intelligent model routing, allowing you to speak instead of typing.

## Features

- 🎙️ **System-wide voice recording** (Desktop) / **One-tap recording** (Mobile)
- 🤖 **Multiple SOTA STT models** with automatic selection:
  - **Parakeet TDT v3** (20-110x real-time on consumer HW, 6.32% WER)
  - **Moonshine v2** (5-44x faster than equivalent Whisper models, streaming support)
  - **Distil-Whisper** (6x faster than Whisper Large v3, excellent accuracy)
  - Faster-Whisper, Whisper.cpp, Python Whisper
- 🧠 **Intelligent model routing** - Auto-selects best model for your needs
- 📋 Automatic clipboard copy
- 🪟 Always-on-top overlay (Desktop)
- 📱 **Native iOS (Swift + WhisperKit)** and **Android (Kotlin + TFLite)** apps
- 🔒 **100% offline** - All processing on-device, no cloud services
- ⚡ Ultra-fast transcription 

## Setup

1. Install dependencies:
```bash
npm install
```

2. Install an STT model (choose one or more):

   | Model | Install | Best for |
   |-------|---------|----------|
   | **Parakeet TDT v3** | `./install-parakeet.sh` | Fastest, 25 languages |
   | **Moonshine v2** | `./install-moonshine.sh` | Mobile/edge, streaming |
   | **Distil-Whisper** | `./install-distil-whisper.sh` | English accuracy |
   | **Faster-Whisper** | `pip install faster-whisper` | Good all-rounder |
   | **whisper.cpp** | `./setup-whisper.sh` | Low-level C++ |
   | **Python Whisper** | `./install-python-whisper.sh` | Fallback |
   | **Canary Qwen 2.5B** | `./install-canary.sh` | Max accuracy |

   > The app auto-selects the fastest available model. Install multiple for automatic fallback. See [MODEL_COMPARISON.md](./MODEL_COMPARISON.md) for benchmarks.

3. Build and run:
```bash
npm run build
npm start
```

Or run in development mode:
```bash
npm run dev
```

## Usage

1. Press `Ctrl+Shift+Space` to activate the overlay
2. Speak your text
3. Press `Ctrl+Shift+Space` again to stop recording
4. The transcribed text will be automatically copied to clipboard
5. Paste (Ctrl+V) in any application

## Keyboard Shortcuts

- `Ctrl+Shift+Space` - Start/Stop recording
- `Esc` - Cancel recording and close overlay

## Model Selection & Routing

Listen uses an **intelligent routing system** that automatically selects the best available model based on your requirements.

**Recommended Models:**
- **Desktop (Speed)**: Parakeet TDT v3 (fastest, 25 languages)
- **Desktop (English accuracy)**: Distil-Whisper (6x faster than Whisper Large v3)
- **Desktop (Multilingual)**: Moonshine v2 Base (streaming, good accuracy)
- **Mobile (iOS/Android)**: Moonshine v2 Tiny (ultra-fast, ~34MB)

See [MODEL_COMPARISON.md](./MODEL_COMPARISON.md) for detailed benchmarks and comparisons.

## Platform Support

- ✅ **macOS** (Desktop - Electron, requires `brew install sox`)
- ✅ **Linux** (Desktop - Electron)
- ✅ **Windows** (Desktop - Initial support)
- ✅ **iOS 16+** (Native Swift app) - See [mobile/ios/README.md](./mobile/ios/README.md)
- ✅ **Android 7+** (Native Kotlin app) - See [mobile/android/README.md](./mobile/android/README.md)

## Project Structure

```
listen/
├── src/                    # TypeScript source code
│   ├── models/            # STT model implementations
│   ├── assets/            # UI (HTML/CSS)
│   └── main.ts            # Electron entry point
├── scripts/               # Python utility scripts
│   └── record_audio_windows.py
├── docs/                  # Documentation
└── mobile/                # Native iOS & Android apps
```

See [ARCHITECTURE.md](./docs/ARCHITECTURE.md#file-structure) for complete structure.

## Documentation

- [Architecture Overview](./docs/ARCHITECTURE.md) - System design and modular architecture
- [Model Comparison](./MODEL_COMPARISON.md) - Detailed STT model benchmarks
- [Quick Start Guide](./QUICKSTART.md) - Get up and running in 5 minutes
- [iOS README](./mobile/ios/README.md) - iOS app documentation
- [Android README](./mobile/android/README.md) - Android app documentation

## Requirements

- Node.js 18+
- At least one STT model installed (see setup above)
- Audio recording:
  - **macOS**: `sox` (`brew install sox`)
  - **Linux**: `arecord` (ALSA) or `sox`
  - **Windows**: PyAudioWPatch (installed automatically)

## License

MIT
