import { app, BrowserWindow, globalShortcut, ipcMain, clipboard, screen } from 'electron';
import * as path from 'path';
import * as fs from 'fs';
import { exec } from 'child_process';
import { promisify } from 'util';
import { RecordingManager } from './recording';
import { ModularTranscriptionService } from './transcription-router';
import { MoonshineStreamingModel, StreamingEvent } from './models/MoonshineStreamingModel';
import { DatasetManager } from './dataset';

const execAsync = promisify(exec);

let mainWindow: BrowserWindow | null = null;
let floatingButtonWindow: BrowserWindow | null = null;
let recordingManager: RecordingManager | null = null;
let transcriptionService: ModularTranscriptionService | null = null;
let streamingModel: MoonshineStreamingModel | null = null;
let useStreaming = false;
let isRecording = false;
let previousWindowFocus: any = null;

/**
 * Capture the currently focused window so we can restore focus later
 */
async function captureWindowFocus(): Promise<any> {
  try {
    const { stdout } = await execAsync('python3 ' + path.join(__dirname, '..', 'window_focus.py') + ' get');
    const windowInfo = JSON.parse(stdout.trim());
    if (windowInfo.handle) {
      console.log(`[OK] Captured focus: ${windowInfo.title || 'Unknown'}`);
      return windowInfo;
    }
  } catch (error) {
    console.log(`[WARN] Could not capture window focus: ${error}`);
  }
  return null;
}

/**
 * Restore focus to the previously captured window
 */
async function restoreWindowFocus(windowInfo: any): Promise<boolean> {
  if (!windowInfo || !windowInfo.handle) return false;

  try {
    const { stdout } = await execAsync(`python3 ${path.join(__dirname, '..', 'window_focus.py')} restore '${JSON.stringify(windowInfo).replace(/'/g, "'\\''")}'`);
    const result = JSON.parse(stdout.trim());
    if (result.success) {
      console.log(`[OK] Restored focus to: ${windowInfo.title || 'previous window'}`);
    }
    return result.success;
  } catch (error) {
    console.log(`[WARN] Could not restore window focus: ${error}`);
  }
  return false;
}

// Floating button position persistence
const buttonPositionFile = path.join(app.getPath('userData'), 'button-position.json');

interface ButtonPosition {
  x: number;
  y: number;
}

function loadButtonPosition(): ButtonPosition {
  try {
    if (fs.existsSync(buttonPositionFile)) {
      const data = fs.readFileSync(buttonPositionFile, 'utf-8');
      return JSON.parse(data);
    }
  } catch (error) {
    console.log('Could not load button position, using default');
  }

  // Default position: bottom-right
  const { width, height } = screen.getPrimaryDisplay().workAreaSize;
  return {
    x: width - 100,
    y: height - 100
  };
}

function saveButtonPosition(position: ButtonPosition) {
  try {
    const dir = path.dirname(buttonPositionFile);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(buttonPositionFile, JSON.stringify(position, null, 2));
  } catch (error) {
    console.error('Could not save button position:', error);
  }
}

function createWindow() {
  const { width, height } = screen.getPrimaryDisplay().workAreaSize;

  mainWindow = new BrowserWindow({
    width: 400,
    height: 200,
    x: Math.floor((width - 400) / 2),
    y: Math.floor((height - 200) / 2),
    transparent: true,
    frame: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    show: false,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
    },
  });

  mainWindow.loadFile(path.join(__dirname, '../assets/index.html'));

  // Prevent window from showing on launch
  mainWindow.on('ready-to-show', () => {
    // Don't show automatically
  });
}

function createFloatingButtonWindow() {
  const position = loadButtonPosition();

  floatingButtonWindow = new BrowserWindow({
    width: 60,
    height: 60,
    x: position.x,
    y: position.y,
    transparent: true,
    frame: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    focusable: false, // Don't steal focus when interacting with button
    webPreferences: {
      preload: path.join(__dirname, 'preload-floating-button.js'),
      nodeIntegration: false,
      contextIsolation: true,
    },
  });

  floatingButtonWindow.loadFile(path.join(__dirname, '../assets/floating-button.html'));

  // Handle window closed
  floatingButtonWindow.on('closed', () => {
    floatingButtonWindow = null;
  });

  // Send initial state
  floatingButtonWindow.webContents.on('did-finish-load', () => {
    updateFloatingButtonState(isRecording ? 'recording' : 'idle');
  });
}

function updateFloatingButtonState(state: string) {
  if (floatingButtonWindow && !floatingButtonWindow.isDestroyed()) {
    floatingButtonWindow.webContents.send('floating-button-state', { state });
  }
}

async function toggleRecording() {
  if (!mainWindow) return;

  if (!isRecording) {
    // Start recording - capture current window focus first
    previousWindowFocus = await captureWindowFocus();

    isRecording = true;
    console.log('\n' + '='.repeat(60));
    console.log('[MIC] RECORDING STARTED');
    console.log(`[TIME] [${new Date().toLocaleTimeString()}]`);
    console.log('='.repeat(60));

    // Show window without stealing focus from user's app
    mainWindow.showInactive();
    mainWindow.setAlwaysOnTop(true, 'screen-saver');
    mainWindow.webContents.send('recording-state', { state: 'recording' });
    updateFloatingButtonState('recording');

    if (useStreaming && streamingModel) {
      // Streaming mode: Moonshine v2 handles mic directly
      try {
        await streamingModel.startStreaming();
        console.log('[OK] Streaming transcription started');
      } catch (error) {
        console.error('[ERROR] Streaming start error:', error);
        isRecording = false;
      }
    } else {
      // Batch mode: record with sox, then transcribe
      if (!recordingManager) {
        recordingManager = new RecordingManager();
      }
      try {
        await recordingManager.startRecording();
        console.log('[OK] Audio stream initialized');
      } catch (error) {
        console.error('[ERROR] Recording start error:', error);
        isRecording = false;
      }
    }
  } else {
    // Stop recording
    isRecording = false;
    const pipelineStart = Date.now();
    console.log('\n' + '='.repeat(60));
    console.log('[STOP] RECORDING STOPPED');
    console.log('='.repeat(60));

    mainWindow.webContents.send('recording-state', { state: 'processing' });
    updateFloatingButtonState('processing');

    if (useStreaming && streamingModel) {
      // Streaming mode: stop and get final text
      try {
        const finalText = await streamingModel.stopStreaming();
        console.log(`[RESULTS] STREAMING TRANSCRIPTION RESULTS:`);
        console.log(`  [OK] Text: "${finalText}"`);
        console.log(`  [OK] Model: Moonshine v2 (streaming)`);

        // Copy to clipboard
        clipboard.writeText(finalText);
        console.log(`  [OK] Text copied to clipboard`);

        updateFloatingButtonState('idle');
        mainWindow?.hide();

        // Restore focus and paste
        setTimeout(async () => {
          try {
            await restoreWindowFocus(previousWindowFocus);
            await new Promise(resolve => setTimeout(resolve, 100));
            const pasteKey = process.platform === 'darwin' ? 'command' : 'ctrl';
            await execAsync(`python3 -c "import pyautogui; pyautogui.hotkey('${pasteKey}', 'v')"`);
            console.log(`[DONE] PIPELINE COMPLETE - Total time: ${Date.now() - pipelineStart}ms`);
          } catch (error) {
            console.log(`  [INFO] Text is in clipboard - paste manually with ${process.platform === 'darwin' ? 'Cmd' : 'Ctrl'}+V`);
          }
        }, 100);
      } catch (error) {
        console.error('[ERROR] Streaming stop error:', error);
        mainWindow.webContents.send('recording-state', {
          state: 'error',
          error: error instanceof Error ? error.message : 'Streaming failed'
        });
        updateFloatingButtonState('idle');
        setTimeout(() => { mainWindow?.hide(); }, 2000);
      }
    } else if (recordingManager) {
      // Batch mode: existing flow
      try {
        const audioFilePath = await recordingManager.stopRecording();
        console.log(`[OK] Recording finalized`);

        if (!transcriptionService) {
          throw new Error('Transcription service failed to initialize');
        }

        const transcribeStart = Date.now();
        const result = await transcriptionService.transcribe(audioFilePath, {
          routingPreferences: { priority: 'balance', platform: 'desktop', language: 'en' }
        });
        const transcribeTime = Date.now() - transcribeStart;

        console.log(`[RESULTS] TRANSCRIPTION RESULTS:`);
        console.log(`  [OK] Text: "${result.text}"`);
        console.log(`  [OK] Model: ${result.modelUsed}`);
        console.log(`  [INFO] Transcription: ${transcribeTime}ms`);

        // Save to dataset
        try {
          const datasetManager = new DatasetManager();
          const fileSize = fs.existsSync(audioFilePath) ? fs.statSync(audioFilePath).size : 0;
          const recordingDuration = fileSize > 44 ? Math.round(((fileSize - 44) / 32000) * 1000) : 0;
          await datasetManager.saveEntry(audioFilePath, {
            transcription: result.text, confidence: result.confidence ?? 0,
            model: result.modelUsed, language: 'en', duration: recordingDuration, fileSize: fileSize
          });
        } catch (datasetError) {
          console.error('[WARN] Failed to save dataset entry:', datasetError);
        }

        clipboard.writeText(result.text);
        console.log(`  [OK] Text copied to clipboard`);

        updateFloatingButtonState('idle');
        mainWindow?.hide();

        setTimeout(async () => {
          try {
            await restoreWindowFocus(previousWindowFocus);
            await new Promise(resolve => setTimeout(resolve, 100));
            const pasteKey = process.platform === 'darwin' ? 'command' : 'ctrl';
            await execAsync(`python3 -c "import pyautogui; pyautogui.hotkey('${pasteKey}', 'v')"`);
            console.log(`[DONE] PIPELINE COMPLETE - Total time: ${Date.now() - pipelineStart}ms`);
          } catch (error) {
            console.log(`  [INFO] Text is in clipboard - paste manually`);
          }
        }, 100);
      } catch (error) {
        console.error('[ERROR] Transcription error:', error);
        mainWindow.webContents.send('recording-state', {
          state: 'error',
          error: error instanceof Error ? error.message : 'Transcription failed'
        });
        updateFloatingButtonState('idle');
        setTimeout(() => { mainWindow?.hide(); }, 2000);
      }
    }
  }
}

function registerShortcuts() {
  // Global hotkey: Ctrl+Shift+Space
  const ret = globalShortcut.register('CommandOrControl+Shift+Space', () => {
    toggleRecording();
  });

  if (!ret) {
    console.error('Global shortcut registration failed');
  }

  // ESC to cancel
  globalShortcut.register('Escape', () => {
    if (mainWindow?.isVisible()) {
      if (isRecording && recordingManager) {
        recordingManager.cancelRecording();
        isRecording = false;
      }
      mainWindow.hide();
      mainWindow.webContents.send('recording-state', { state: 'idle' });
    }
  });
}

app.whenReady().then(async () => {
  createWindow();
  createFloatingButtonWindow();
  registerShortcuts();

  // Try streaming (Moonshine v2) first, fall back to batch transcription
  console.log('[INIT] Checking for Moonshine v2 streaming...');
  streamingModel = new MoonshineStreamingModel();

  try {
    const streamingAvailable = await streamingModel.isAvailable();
    if (streamingAvailable) {
      await streamingModel.initialize();
      useStreaming = true;
      console.log('[OK] Moonshine v2 streaming ready - real-time transcription enabled!');

      // Forward partial transcription to the UI
      streamingModel.on('transcription', (event: StreamingEvent) => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('streaming-text', {
            type: event.type,
            text: event.text,
          });
        }
      });
    } else {
      console.log('[INFO] Moonshine v2 not available, using batch mode');
    }
  } catch (error) {
    console.log('[INFO] Moonshine v2 streaming init failed, using batch mode:', error);
  }

  // Also initialize batch transcription as fallback
  console.log('[INIT] Initializing batch transcription service...');
  transcriptionService = new ModularTranscriptionService();

  try {
    await transcriptionService.initialize();
    console.log('[OK] Batch transcription ready (fallback)');
  } catch (error) {
    console.error('[ERROR] Failed to load batch model:', error);
  }

  // Signal UI that app is ready
  if (mainWindow) {
    mainWindow.webContents.send('app-ready');
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  if (floatingButtonWindow && !floatingButtonWindow.isDestroyed()) {
    floatingButtonWindow.destroy();
  }
});

// IPC handlers
ipcMain.on('cancel-recording', () => {
  if (isRecording && recordingManager) {
    recordingManager.cancelRecording();
    isRecording = false;
  }
  mainWindow?.hide();
});

// Floating button IPC handlers
ipcMain.on('floating-button-click', () => {
  toggleRecording();
});

ipcMain.on('floating-button-drag', (event, { deltaX, deltaY }) => {
  if (floatingButtonWindow && !floatingButtonWindow.isDestroyed()) {
    const [x, y] = floatingButtonWindow.getPosition();
    floatingButtonWindow.setPosition(x + deltaX, y + deltaY);
  }
});

ipcMain.on('floating-button-drag-end', () => {
  if (floatingButtonWindow && !floatingButtonWindow.isDestroyed()) {
    const [x, y] = floatingButtonWindow.getPosition();
    saveButtonPosition({ x, y });
  }
});

ipcMain.on('floating-button-ready', () => {
  updateFloatingButtonState(isRecording ? 'recording' : 'idle');
});
