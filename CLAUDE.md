# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**Listen** is a multi-platform voice-to-text application that provides system-wide speech transcription. It's a WhisperFlow/macOS Dictation clone with intelligent model routing and offline-first architecture.

**Key Features:**
- Desktop overlay app (Electron) for macOS, Windows, Linux
- Native iOS (Swift + WhisperKit) and Android (Kotlin + TFLite) apps
- 100% offline - all processing on-device with local STT models
- Intelligent model routing - auto-selects best model based on speed/accuracy/language
- Supports 7+ SOTA models (Parakeet TDT, Moonshine, Distil-Whisper, etc.)

**Primary Use Cases:**
1. **Real-time transcription to any textbox**: Press global hotkey, speak, text appears in clipboard
2. **Meeting recording**: Record and transcribe long-form audio (desktop & mobile)

## Build & Development Commands

### Desktop (Electron)

```bash
# Install dependencies
npm install

# Build TypeScript
npm run build

# Start app (production mode)
npm start

# Development mode (auto-rebuild + reload)
npm run dev

# Package for distribution
npm run package
```

### Platform-Specific Requirements

**macOS:**
```bash
brew install sox  # Required for audio recording
npm start
```

**Windows:**
- Run natively on Windows (NOT WSL2 - Electron GUI doesn't work in WSL2)
- Install Node.js, Python 3.8+, Git Bash
- Use Git Bash or PowerShell for scripts

**Linux:**
```bash
sudo apt-get install sox alsa-utils  # For audio recording
npm start
```

**iOS:**
```bash
cd mobile/ios
open Listen.xcodeproj
# Build in Xcode
```

**Android:**
```bash
cd mobile/android
./gradlew build
```

### Model Installation

Install at least one STT model before first use:

```bash
# Fastest model (3,333x real-time with GPU)
./install-parakeet.sh

# Best for mobile/edge devices
./install-moonshine.sh

# Best English accuracy
./install-distil-whisper.sh

# Fallback option
pip install faster-whisper
```

**Model Priority Order** (router checks in this order, uses first available):
1. Parakeet TDT v3 (0.6B, 3,333x RTF with GPU)
2. Canary Qwen (2.5B, 418x RTF, 5.63% WER)
3. Distil-Whisper Small (244M, 6x RTF)
4. Moonshine Base (200M, 5-15x RTF)
5. Faster-Whisper Base (74M, 4x RTF)
6. Moonshine Tiny (40M, ultra-fast)
7. Whisper.cpp Base (74M, 2x RTF)
8. Python Whisper Base (74M, baseline)

## Architecture

### Modular STT Model System

The app uses a **plugin-based architecture** for STT models to enable:
- Easy addition of new models
- Automatic fallback if a model isn't available
- Consistent API across all implementations
- Intelligent routing based on requirements

**Core Components:**

1. **`ModelInterface.ts`** - Abstract base class all models implement:
   ```typescript
   abstract class STTModel {
     abstract isAvailable(): Promise<boolean>;
     abstract transcribe(audioPath, options): Promise<TranscriptionResult>;
     abstract getInfo(): ModelInfo;
     abstract initialize(): Promise<void>;
     abstract cleanup(): Promise<void>;
   }
   ```

2. **`ModelRouter.ts`** - Intelligent routing system:
   - Checks models in priority order (fastest first)
   - Uses **first available model** (doesn't check all)
   - Scores models based on: speed, accuracy, RTF, platform, language
   - Supports routing preferences (priority: speed/accuracy/balance)

3. **Model Implementations** (`src/models/`):
   - `ParakeetModel.ts` - NVIDIA Parakeet TDT (fastest with GPU)
   - `CanaryModel.ts` - NVIDIA Canary (best accuracy)
   - `MoonshineModel.ts` - Moonshine v2 (mobile/edge optimized)
   - `DistilWhisperModel.ts` - Distil-Whisper (English accuracy)
   - `FasterWhisperModel.ts` - Faster-Whisper (Python)
   - `WhisperCppModel.ts` - whisper.cpp (C++ binary)
   - `PythonWhisperModel.ts` - OpenAI Whisper (fallback)

**Model Implementation Pattern:**
- Most models run via Python subprocess (create temp script, execute, parse stdout)
- `whisper.cpp` runs as binary
- Each model checks availability with `python3 -c "import module"` or binary existence
- Models create transcription scripts at runtime in `scripts/` directory

### Data Flow

**Desktop (Electron):**
1. User presses `Ctrl+Shift+Space` → Global hotkey triggers recording
2. `recording.ts` records audio to temp file (`.wav` 16kHz mono)
3. `ModelRouter.selectBestModel()` picks fastest available model
4. Model transcribes audio via subprocess/binary
5. Result copied to clipboard automatically
6. Overlay window displays transcription

**Mobile (iOS/Android):**
1. User taps record button
2. Native audio recorder captures audio
3. On-device model (WhisperKit/TFLite) transcribes
4. Result displayed in history view

### File Structure

```
src/
├── main.ts                   # Electron main process, window management
├── recording.ts              # Audio recording (sox/arecord)
├── transcription-router.ts   # Modular transcription service (uses ModelRouter)
├── transcription.ts          # Legacy monolithic transcription (DEPRECATED)
├── models/
│   ├── ModelInterface.ts     # Abstract base class
│   ├── ModelRouter.ts        # Intelligent routing
│   └── *Model.ts            # 7+ model implementations
├── settings.ts               # Settings persistence
├── statistics.ts             # Usage tracking
├── tray.ts                   # System tray integration
├── voice-commands.ts         # Voice command processor
└── api-server.ts            # REST API server mode

assets/
├── index.html                # Overlay UI
└── settings.html            # Settings interface

mobile/
├── ios/Listen/              # Native iOS app (Swift)
└── android/app/             # Native Android app (Kotlin)
```

## Critical Implementation Details

### 1. Model Selection Algorithm

The router doesn't test all models - it checks in priority order and **stops at the first available**:

```typescript
for (const model of this.models) {
  const available = await model.isAvailable();
  if (available) {
    await model.initialize();
    break; // STOPS HERE - doesn't check remaining models
  }
}
```

This means:
- Installing Parakeet makes it the default (fastest)
- Removing Parakeet falls back to next available
- No need to configure which model to use

### 2. TypeScript Compilation Requirements

- Must have `@types/node` installed for Node.js types
- Models use subprocess, fs, path - need Node type definitions
- If build fails with "Cannot find module 'fs'", run: `npm install --save-dev @types/node`

### 3. Platform-Specific Audio Recording

- **macOS**: Uses `sox` command (`brew install sox`)
- **Linux**: Uses `arecord` (ALSA)
- **Windows**: Uses `sox` or Python script (`record_audio_windows.py`)

### 4. WSL2 Limitations

**Do NOT run Electron app in WSL2** - it has severe GUI limitations:
- X server connection issues even with WSLg
- GPU process crashes
- No system tray integration
- Global hotkeys don't work

**Solution**: Run on native Windows instead. Clone repo to Windows filesystem, install Node/Python there.

If user must use WSL2, create CLI version (no Electron GUI).

### 5. GPU Acceleration

- Parakeet requires CUDA for full 3,333x speed (CPU mode much slower)
- Use default PyTorch: `pip install torch torchaudio` (uses CUDA 12.8)
- Check GPU: `nvidia-smi` and `python -c "import torch; print(torch.cuda.is_available())"`
- Electron GPU crashes: use `--disable-gpu --no-sandbox` flags

## Adding New STT Models

To add a new model:

1. **Create model class** in `src/models/NewModel.ts`:
   ```typescript
   export class NewModel extends STTModel {
     async isAvailable(): Promise<boolean> {
       // Check if model installed (try import or binary exists)
     }
     
     async transcribe(audioPath: string): Promise<TranscriptionResult> {
       // Create Python script or call binary
       // Parse stdout for transcription
       // Return { text, duration, confidence }
     }
     
     getInfo(): ModelInfo {
       return {
         name: 'NewModel',
         type: 'newmodel',
         speed: 'ultra-fast',
         accuracy: 'excellent',
         sizeCategory: 'small',
         languages: ['en', 'multilingual'],
         requiresGPU: false,
         estimatedMemory: '500MB',
         rtfSpeed: 10
       };
     }
     
     async initialize(): Promise<void> {}
     async cleanup(): Promise<void> {}
   }
   ```

2. **Register in ModelRouter** (`src/models/ModelRouter.ts`):
   ```typescript
   this.models = [
     new NewModel(),  // Add in priority order
     new ParakeetModel('v3'),
     // ... rest
   ];
   ```

3. **Create installation script** (`install-newmodel.sh`):
   ```bash
   #!/bin/bash
   pip3 install --user newmodel-package
   ```

4. **Update README.md** with installation instructions

## Testing & Debugging

### Test Model Availability

```bash
# Check if model can be imported
python3 -c "import moonshine; print('✅ Moonshine available')"
python3 -c "import nemo; print('✅ NeMo (Parakeet) available')"

# Test model transcription directly
python3 scripts/transcribe_moonshine.py test.wav tiny
```

### Debug Electron Issues

```bash
# Run with debug output
DEBUG=* npm start

# Disable GPU (fixes crashes)
npm start -- --disable-gpu --no-sandbox

# Check Electron version
npm ls electron
```

### Common Errors

**"Cannot find module 'fs'" during build:**
```bash
npm install --save-dev @types/node
```

**"Missing X server or $DISPLAY" in WSL2:**
- Don't run Electron in WSL2. Run on native Windows/Mac.

**"GPU process exited unexpectedly: exit_code=139":**
```bash
npm start -- --disable-gpu --no-sandbox
```

**"No STT models available":**
```bash
# Install at least one model
./install-moonshine.sh
# Or
pip install faster-whisper
```

## macOS Specific Notes

### Running on macOS

1. **Install dependencies:**
   ```bash
   brew install sox
   brew install node
   pip3 install --user torch torchaudio  # For GPU models
   ```

2. **Install model (required):**
   ```bash
   ./install-moonshine.sh  # Recommended for macOS
   ```

3. **Build and run:**
   ```bash
   npm install
   npm run build
   npm start
   ```

4. **Grant permissions:**
   - Microphone access: System Preferences → Security & Privacy → Microphone
   - Accessibility (for global hotkeys): System Preferences → Security & Privacy → Accessibility

### macOS Audio Recording

The app uses `sox` for high-quality audio capture:
```bash
sox -d -t wav -r 16000 -c 1 output.wav
```

### macOS Global Hotkeys

Uses `electron-localshortcut` for global hotkey registration:
- `Cmd+Shift+Space` - Start/stop recording (macOS)
- `Ctrl+Shift+Space` - Start/stop recording (Windows/Linux)

### macOS System Tray

The app creates a native macOS menu bar icon with context menu for:
- Start/stop recording
- Open settings
- View statistics
- Quit app

## Code Quality Standards

- **TypeScript**: Strict mode enabled in `tsconfig.json`
- **No `any` types**: Use proper types or `unknown`
- **Error handling**: All subprocess calls use try/catch
- **Cleanup**: Models must implement cleanup() for resource management
- **Async/await**: Prefer over callbacks/promises.then()

## Performance Optimization

- Models checked sequentially, stops at first available (not all checked)
- Audio recorded to temp file only while recording (auto-deleted)
- Transcription runs in subprocess (doesn't block main thread)
- Results cached in statistics for history view

## Security Considerations

- All processing is offline/on-device
- No API keys or cloud services
- No telemetry (can be enabled in settings)
- Temp files deleted after transcription
- No audio stored unless user saves manually
