# Meeting Mode - Implementation Guide

This document explains the new meeting mode feature for capturing and transcribing long-form conversations.

## Features Implemented (Phase 1)

✅ **Audio Chunking** - Splits long recordings into 30-second chunks
✅ **Batch Transcription** - Processes chunks with progress updates
✅ **Meeting UI** - Dedicated interface for meeting recordings
✅ **Meeting History** - Saves and manages meeting transcripts
✅ **Export** - Export to Markdown, Text, or JSON

## Architecture

### Components

1. **AudioChunker.ts** - Splits long audio files into processable chunks
   - Uses ffmpeg or sox
   - 30-second chunks with 1-second overlap
   - Prevents cutting mid-word

2. **MeetingTranscriber.ts** - Batch transcription with progress
   - Processes chunks sequentially
   - Real-time progress callbacks
   - Merges segments with timestamps
   - Export to Markdown/Text

3. **MeetingManager.ts** - Meeting storage and history
   - Saves meetings with metadata
   - Search and filter meetings
   - Export functionality
   - Storage statistics

4. **meeting.html** - Meeting mode UI
   - Recording controls
   - Live transcript view
   - Progress indicator
   - Save/export buttons

5. **meeting-integration.ts** - Electron IPC handlers
   - Start/stop recording
   - Progress updates
   - Save/export dialogs

## Integration Steps

### 1. Add to main.ts

Add these imports at the top:

```typescript
import { createMeetingWindow, setupMeetingIPC } from './meeting-integration';
```

In your `app.on('ready')` handler, add:

```typescript
app.on('ready', () => {
  // ... existing code ...
  
  // Setup meeting mode IPC handlers
  setupMeetingIPC();
});
```

Add a menu item or hotkey to open meeting mode:

```typescript
// Add global hotkey for meeting mode (e.g., Cmd+Shift+M)
globalShortcut.register('CommandOrControl+Shift+M', () => {
  createMeetingWindow();
});
```

### 2. Update package.json

No new dependencies needed! Uses existing:
- ffmpeg or sox (for audio chunking)
- Existing model infrastructure

### 3. Test Installation

```bash
# Make sure you have ffmpeg or sox installed
# macOS:
brew install ffmpeg

# Linux:
sudo apt-get install ffmpeg

# Or use sox (already required):
brew install sox  # macOS
sudo apt-get install sox  # Linux
```

### 4. Build and Test

```bash
npm run build
npm start
```

Then press `Cmd+Shift+M` (or `Ctrl+Shift+M`) to open meeting mode.

## Usage

### Recording a Meeting

1. **Open Meeting Mode**: Press `Cmd+Shift+M`
2. **Start Recording**: Click "Start Meeting" button
3. **Record**: Let it run for as long as needed (minutes to hours)
4. **Stop & Transcribe**: Click "Stop & Transcribe"
5. **Wait**: Progress bar shows chunk processing
6. **Review**: See transcript with timestamps
7. **Save/Export**: Save to Markdown or Text file

### Meeting History

All meetings are automatically saved to:
```
~/Library/Application Support/Listen/meetings/  (macOS)
%APPDATA%/Listen/meetings/                      (Windows)
~/.config/Listen/meetings/                      (Linux)
```

Each meeting includes:
- Full transcript with timestamps
- Metadata (date, duration, model used)
- Optional audio file (if enabled)

### Export Formats

**Markdown** (.md):
```markdown
# Meeting Recording

**Date:** 2024-05-15 10:30 AM
**Duration:** 45m 23s
**Model:** Moonshine Base

---

## Transcript

**[0:00]** Let's start the meeting...

**[2:15]** I think we should prioritize...

**[5:30]** Great point about the roadmap...
```

**Plain Text** (.txt):
```
Meeting Recording
==================

Date: 2024-05-15 10:30 AM
Duration: 45m 23s

Transcript:

[0:00] Let's start the meeting...

[2:15] I think we should prioritize...

[5:30] Great point about the roadmap...
```

**JSON** (.json):
```json
{
  "id": "meeting_1234567890_abc123",
  "title": "Meeting Recording",
  "timestamp": 1715779800000,
  "duration": 2723,
  "transcript": {
    "segments": [
      {
        "text": "Let's start the meeting...",
        "startTime": 0,
        "endTime": 30,
        "confidence": 0.95
      }
    ],
    "fullText": "...",
    "modelUsed": "Moonshine Base"
  }
}
```

## Performance

### Chunking Strategy

- **Chunk Size**: 30 seconds (configurable)
- **Overlap**: 1 second (prevents word cutting)
- **Processing**: Sequential (one chunk at a time)

### Speed Estimates

For a 1-hour meeting:

| Model | Chunks | Processing Time | RTF |
|-------|--------|----------------|-----|
| Parakeet TDT (GPU) | 120 | ~1 second | 3,333x |
| Moonshine Base | 120 | ~12 seconds | 10x |
| Distil-Whisper | 120 | ~20 seconds | 6x |
| Faster-Whisper | 120 | ~30 seconds | 4x |

**Note**: Processing time = (Total Audio / RTF) + chunking overhead

### Storage

| Item | Size |
|------|------|
| 1-hour audio (WAV) | ~350 MB |
| Transcript (JSON) | ~50-100 KB |
| Transcript (Markdown) | ~30-60 KB |

Audio files are deleted by default after transcription. Enable "Keep Audio" in settings to preserve originals.

## Configuration

### Chunk Duration

Change chunk size in `meeting-integration.ts`:

```typescript
// Default: 30 seconds
meetingTranscriber = new MeetingTranscriber(30);

// For faster models: 60 seconds
meetingTranscriber = new MeetingTranscriber(60);

// For slower models: 20 seconds
meetingTranscriber = new MeetingTranscriber(20);
```

### Audio Quality

Recording settings in `recording.ts`:
- **Sample Rate**: 16kHz (optimal for Whisper)
- **Channels**: Mono
- **Format**: WAV (uncompressed)

## Troubleshooting

### "Could not determine audio duration"

Install ffmpeg or sox:
```bash
brew install ffmpeg  # macOS
sudo apt-get install ffmpeg  # Linux
```

### "Could not extract audio chunk"

Same as above - requires ffmpeg or sox.

### "No STT models available"

Install at least one model:
```bash
./install-moonshine.sh
# or
pip install faster-whisper
```

### Long processing time

- Use a faster model (Parakeet, Moonshine)
- Enable GPU acceleration (install CUDA version of PyTorch)
- Reduce chunk size for better parallelization (future enhancement)

## Next Steps (Future Phases)

### Phase 2: Real-time Features
- [ ] Live streaming transcription (using MoonshineStreamingModel)
- [ ] Real-time transcript updates during recording
- [ ] Speaker change detection

### Phase 3: AI Summarization
- [ ] Integrate Claude API for smart summaries
- [ ] Extract action items
- [ ] Identify key decisions
- [ ] Generate meeting notes

### Phase 4: System Audio Capture
- [ ] Capture from Zoom/Meet/Teams/Slack
- [ ] Virtual audio device setup
- [ ] Multi-source audio mixing
- [ ] Echo cancellation

## Contributing

To extend meeting mode:

1. **Add new export format**: Extend `MeetingManager.ts`
2. **Improve chunking**: Modify `AudioChunker.ts`
3. **Add summarization**: Create `MeetingSummarizer.ts`
4. **Add search**: Extend meeting history UI

## API Reference

See inline documentation in:
- `src/AudioChunker.ts`
- `src/MeetingTranscriber.ts`
- `src/MeetingManager.ts`
- `src/meeting-integration.ts`
