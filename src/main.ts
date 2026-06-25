import { app, BrowserWindow, globalShortcut, ipcMain, clipboard, screen, systemPreferences } from 'electron';
import * as path from 'path';
import * as fs from 'fs';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { RecordingManager } from './recording';
import { ModularTranscriptionService } from './transcription-router';
import { MoonshineStreamingModel, StreamingEvent } from './models/MoonshineStreamingModel';
import { NemotronStreamingModel, NemotronStreamingEvent } from './models/NemotronStreamingModel';
import { SettingsManager } from './settings';
import { TrayManager } from './tray';
import { extractTrailingAction } from './voice-actions';
import { fireKeystroke } from './keystroke';

const execFileAsync = promisify(execFile);

let mainWindow: BrowserWindow | null = null;
let floatingButtonWindow: BrowserWindow | null = null;
let settingsWindow: BrowserWindow | null = null;
let trayManager: TrayManager | null = null;
let recordingManager: RecordingManager | null = null;
let transcriptionService: ModularTranscriptionService | null = null;
let streamingModel: MoonshineStreamingModel | null = null;
let nemotronStreamingModel: NemotronStreamingModel | null = null;
let useStreaming = false;
let isRecording = false;
let isTranscriptionReady = false;
let isTogglingRecording = false;
let lastToggleAt = 0;
let previousWindowFocus: any = null;
let saveButtonPositionTimer: NodeJS.Timeout | null = null;
let liveTypedText = '';
let liveTypeQueue: Promise<void> = Promise.resolve();
const settingsManager = new SettingsManager();

function getActiveStreamingModel(): MoonshineStreamingModel | NemotronStreamingModel | null {
  return nemotronStreamingModel || streamingModel;
}

function pythonScriptPath(name: string): string {
  if (app?.isPackaged) {
    return path.join(process.resourcesPath, 'scripts', name);
  }
  return path.join(__dirname, '..', 'python', name);
}

async function runKeyboardAutomation(action: object): Promise<void> {
  const scriptPath = pythonScriptPath('keyboard_automation.py');
  await new Promise<void>((resolve, reject) => {
    const child = require('child_process').spawn('python3', [scriptPath]);
    let stderr = '';
    child.stderr?.on('data', (d: Buffer) => { stderr += d.toString(); });
    child.on('error', reject);
    child.on('exit', (code: number) => {
      if (code === 0) resolve();
      else reject(new Error(`keyboard automation exited ${code}: ${stderr.trim()}`));
    });
    child.stdin.write(JSON.stringify(action));
    child.stdin.end();
  });
}

/**
 * Capture the currently focused window so we can restore focus later
 */
async function captureWindowFocus(): Promise<any> {
  try {
    const scriptPath = pythonScriptPath('window_focus.py');
    const { stdout } = await execFileAsync('python3', [scriptPath, 'get']);
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
    const scriptPath = pythonScriptPath('window_focus.py');
    const { stdout } = await execFileAsync('python3', [scriptPath, 'restore', JSON.stringify(windowInfo)]);
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

async function pasteClipboardIntoFocusedApp(): Promise<void> {
  if (process.platform === 'darwin') {
    await execFileAsync('osascript', ['-e', 'tell application "System Events" to keystroke "v" using command down']);
    return;
  }

  await runKeyboardAutomation({ type: 'hotkey', keys: ['ctrl', 'v'] });
}

function escapeAppleScriptText(text: string): string {
  return text
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\r?\n/g, '\\n');
}

function commonPrefixLength(a: string, b: string): number {
  const limit = Math.min(a.length, b.length);
  let index = 0;

  while (index < limit && a[index] === b[index]) {
    index++;
  }

  return index;
}

async function applyLiveTextChange(nextText: string): Promise<void> {
  const normalizedText = nextText.trimStart();
  if (!normalizedText || normalizedText === liveTypedText) return;

  const sharedPrefix = commonPrefixLength(liveTypedText, normalizedText);
  const deleteCount = liveTypedText.length - sharedPrefix;
  const insertText = normalizedText.slice(sharedPrefix);

  if (process.platform === 'darwin') {
    const scriptParts: string[] = ['tell application "System Events"'];

    if (deleteCount > 0) {
      scriptParts.push(`repeat ${deleteCount} times`);
      scriptParts.push('key code 51');
      scriptParts.push('end repeat');
    }

    if (insertText) {
      scriptParts.push(`keystroke "${escapeAppleScriptText(insertText)}"`);
    }

    scriptParts.push('end tell');
    await execFileAsync('osascript', scriptParts.flatMap(part => ['-e', part]));
    liveTypedText = normalizedText;
    return;
  }

  // Linux / Windows: pass the text via stdin, not via the shell, so that
  // characters like $, `, and " in the transcript can never be interpreted
  // as shell command substitution.
  if (deleteCount > 0 || insertText) {
    await runKeyboardAutomation({ type: 'type_change', deletes: deleteCount, text: insertText });
  }

  liveTypedText = normalizedText;
}

function queueLiveTextChange(nextText: string): void {
  liveTypeQueue = liveTypeQueue
    .then(() => applyLiveTextChange(nextText))
    .catch((error) => {
      console.log(`  [WARN] Live typing failed: ${error instanceof Error ? error.message : String(error)}`);
    });
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
    x: width - 212,
    y: height - 104
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
    width: 148,
    height: 52,
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

  floatingButtonWindow.on('move', () => {
    if (!floatingButtonWindow || floatingButtonWindow.isDestroyed()) return;

    if (saveButtonPositionTimer) {
      clearTimeout(saveButtonPositionTimer);
    }

    saveButtonPositionTimer = setTimeout(() => {
      if (!floatingButtonWindow || floatingButtonWindow.isDestroyed()) return;

      const [x, y] = floatingButtonWindow.getPosition();
      saveButtonPosition({ x, y });
    }, 250);
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

  const now = Date.now();
  if (isTogglingRecording || now - lastToggleAt < 750) {
    console.log('[INFO] Ignoring duplicate transcription toggle');
    return;
  }

  if (!isTranscriptionReady) {
    console.log('[INFO] Transcription is still initializing; wait for the HUD to be ready');
    updateFloatingButtonState('processing');
    return;
  }

  isTogglingRecording = true;
  lastToggleAt = now;

  if (!isRecording) {
    // Start recording - capture current window focus first
    previousWindowFocus = await captureWindowFocus();
    liveTypedText = '';
    liveTypeQueue = Promise.resolve();

    isRecording = true;
    console.log('\n' + '='.repeat(60));
    console.log('[MIC] RECORDING STARTED');
    console.log(`[TIME] [${new Date().toLocaleTimeString()}]`);
    console.log('='.repeat(60));

    mainWindow.webContents.send('recording-state', { state: 'recording' });
    updateFloatingButtonState('recording');
    trayManager?.setRecording(true);

    const activeStreamingModel = getActiveStreamingModel();

    if (useStreaming && activeStreamingModel) {
      // Streaming engines own the microphone directly; running a parallel
      // training-audio sox capture races the mic and breaks transcription.
      try {
        await activeStreamingModel.startStreaming();
        console.log('[OK] Streaming transcription started');
      } catch (error) {
        console.error('[ERROR] Streaming start error:', error);
        try {
          await activeStreamingModel.stopStreaming();
        } catch {
          // Ignore cleanup errors from a partially-started stream.
        }
        isRecording = false;
        updateFloatingButtonState('idle');
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
        updateFloatingButtonState('idle');
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
    trayManager?.setRecording(false);

    const activeStreamingModel = getActiveStreamingModel();

    if (useStreaming && activeStreamingModel) {
      // Streaming mode: stop and get final text
      try {
        const finalText = await activeStreamingModel.stopStreaming();
        await liveTypeQueue;

        const engineLabel = nemotronStreamingModel ? 'Nemotron streaming' : 'Moonshine v2 streaming';
        console.log(`[RESULTS] STREAMING TRANSCRIPTION RESULTS:`);
        console.log(`  [OK] Text: "${finalText}"`);
        console.log(`  [OK] Model: ${engineLabel}`);

        clipboard.writeText(finalText);
        console.log(`  [OK] Text copied to clipboard`);

        updateFloatingButtonState('idle');
        mainWindow?.hide();

        if (finalText.trim() && finalText.trim() !== liveTypedText.trim()) {
          queueLiveTextChange(finalText);
          await liveTypeQueue;
        }

        console.log(`[DONE] PIPELINE COMPLETE - Total time: ${Date.now() - pipelineStart}ms`);
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
          routingPreferences: {
            priority: 'accuracy',
            platform: 'desktop',
            language: 'en',
          }
        });
        const transcribeTime = Date.now() - transcribeStart;

        console.log(`[RESULTS] TRANSCRIPTION RESULTS:`);
        console.log(`  [OK] Text: "${result.text}"`);
        console.log(`  [OK] Model: ${result.modelUsed}`);
        console.log(`  [INFO] Transcription: ${transcribeTime}ms`);

        clipboard.writeText(result.text);
        console.log(`  [OK] Text copied to clipboard`);

        updateFloatingButtonState('idle');
        mainWindow?.hide();

        setTimeout(async () => {
          try {
            await restoreWindowFocus(previousWindowFocus);
            await new Promise(resolve => setTimeout(resolve, 100));
            await pasteClipboardIntoFocusedApp();
            console.log(`[DONE] PIPELINE COMPLETE - Total time: ${Date.now() - pipelineStart}ms`);
          } catch (error) {
            console.log(`  [WARN] Auto-paste failed: ${error instanceof Error ? error.message : String(error)}`);
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

  isTogglingRecording = false;
}

function registerShortcuts() {
  const toggleShortcuts = process.platform === 'darwin'
    ? ['Control+Shift+Space', 'Command+Shift+Space']
    : ['CommandOrControl+Shift+Space'];

  for (const shortcut of toggleShortcuts) {
    const registered = globalShortcut.register(shortcut, () => {
      toggleRecording();
    });

    if (registered) {
      console.log(`[OK] Registered global shortcut: ${shortcut}`);
    } else {
      console.error(`[ERROR] Global shortcut registration failed: ${shortcut}`);
    }
  }

}

function openSettingsWindow(): void {
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    settingsWindow.show();
    settingsWindow.focus();
    return;
  }
  settingsWindow = new BrowserWindow({
    width: 560,
    height: 420,
    title: 'Listen Settings',
    autoHideMenuBar: true,
    resizable: false,
    minimizable: false,
    maximizable: false,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
    },
  });
  settingsWindow.loadFile(path.join(__dirname, '../assets/settings.html'));
  settingsWindow.on('closed', () => { settingsWindow = null; });
}

function applyAutoStart(enabled: boolean): void {
  // macOS + Windows handled natively. On Linux, .desktop autostart is needed
  // separately (out of scope here).
  if (process.platform === 'darwin' || process.platform === 'win32') {
    app.setLoginItemSettings({ openAtLogin: enabled });
  }
}

function checkAccessibilityPermission(): void {
  if (process.platform !== 'darwin') return;
  // Passing `false` only queries — no prompt. We then call the prompting form
  // exactly once if denied, which surfaces the system "open Settings" alert.
  const granted = systemPreferences.isTrustedAccessibilityClient(false);
  if (granted) {
    console.log('[OK] macOS Accessibility permission: GRANTED');
    return;
  }
  console.log('');
  console.log('=' .repeat(72));
  console.log('[!] macOS Accessibility permission: NOT GRANTED');
  console.log('[!] Voice-typing and the Enter voice command will silently fail');
  console.log('[!] until Electron is added to: System Settings → Privacy &');
  console.log('[!] Security → Accessibility. Paste this path in the "+" picker');
  console.log('[!] (Cmd+Shift+G):');
  console.log('[!]');
  console.log(`[!]   ${process.execPath.replace(/\/Contents\/MacOS\/Electron$/, '')}`);
  console.log('[!]');
  console.log('[!] After granting, fully quit (Cmd+Q from tray) and restart.');
  console.log('=' .repeat(72));
  console.log('');
  // Show macOS system prompt as well.
  systemPreferences.isTrustedAccessibilityClient(true);
}

app.whenReady().then(async () => {
  createWindow();
  createFloatingButtonWindow();
  registerShortcuts();
  checkAccessibilityPermission();

  trayManager = new TrayManager({
    toggleRecording: () => { void toggleRecording(); },
    openSettings: () => openSettingsWindow(),
  });
  trayManager.create();

  applyAutoStart(settingsManager.get().autoStart);

  const settings = settingsManager.get();
  const transcriptionEngine = process.env.OPENWHISPER_TRANSCRIPTION_ENGINE
    || settings.transcriptionEngine
    || 'auto';
  const shouldUseNemotronStreaming = transcriptionEngine === 'nemotron-streaming';
  const shouldUseMoonshineStreaming = !shouldUseNemotronStreaming;

  // Nemotron is the recommended streaming engine; Moonshine is the fallback.
  if (shouldUseNemotronStreaming) {
    console.log('[INIT] Checking for Nemotron streaming...');
    nemotronStreamingModel = new NemotronStreamingModel();

    try {
      const streamingAvailable = await nemotronStreamingModel.isAvailable();
      if (streamingAvailable) {
        await nemotronStreamingModel.initialize();
        useStreaming = true;
        isTranscriptionReady = true;
        updateFloatingButtonState('idle');
        console.log('[OK] Nemotron streaming ready');

        let voiceActionFiring = false;
        nemotronStreamingModel.on('transcription', async (event: NemotronStreamingEvent) => {
          if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('streaming-text', {
              type: event.type,
              text: event.text,
            });
          }

          if (!isRecording) return;
          if (event.type !== 'partial' && event.type !== 'final') return;

          const fullText = nemotronStreamingModel?.getFullText() || event.text;

          if (voiceActionFiring) return;

          const { cleaned, action, name } = extractTrailingAction(fullText);
          if (action) {
            voiceActionFiring = true;
            try {
              queueLiveTextChange(cleaned);
              await liveTypeQueue;
              await fireKeystroke(action);
              console.log(`[voice-cmd] ${name} -> cleaned="${cleaned}"`);
              // Reset diff state: the typed prefix is committed, the cursor
              // moved (Return / Tab / arrow / etc.), and the recognizer is
              // about to restart fresh. The next partial begins a new
              // utterance, no longer relative to what we already committed.
              liveTypedText = '';
              nemotronStreamingModel?.commitAndResetSession(cleaned);
            } catch (e) {
              console.log(`[voice-cmd] failed: ${e instanceof Error ? e.message : e}`);
            } finally {
              voiceActionFiring = false;
            }
            return;
          }

          queueLiveTextChange(fullText);
        });
      } else {
        console.log('[INFO] Nemotron streaming not available (sherpa-onnx or model files missing)');
      }
    } catch (error) {
      console.log('[INFO] Nemotron streaming init failed:', error);
    }
  } else if (shouldUseMoonshineStreaming) {
    console.log('[INIT] Checking for Moonshine v2 streaming...');
    streamingModel = new MoonshineStreamingModel();

    try {
      const streamingAvailable = await streamingModel.isAvailable();
      if (streamingAvailable) {
        await streamingModel.initialize();
        useStreaming = true;
        isTranscriptionReady = true;
        updateFloatingButtonState('idle');
        console.log('[OK] Moonshine v2 streaming ready - real-time transcription enabled!');

        // Forward partial transcription to the UI
        streamingModel.on('transcription', (event: StreamingEvent) => {
          if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('streaming-text', {
              type: event.type,
              text: event.text,
            });
          }

          if (isRecording && (event.type === 'partial' || event.type === 'final')) {
            queueLiveTextChange(streamingModel?.getFullText() || event.text);
          }
        });
      } else {
        console.log('[INFO] Moonshine v2 not available, using batch mode');
      }
    } catch (error) {
      console.log('[INFO] Moonshine v2 streaming init failed, using batch mode:', error);
    }
  } else {
    console.log('[INIT] Skipping Moonshine streaming; configured engine:', transcriptionEngine);
  }

  if (!useStreaming) {
    // Also initialize batch transcription as fallback
    console.log('[INIT] Initializing batch transcription service...');
    transcriptionService = new ModularTranscriptionService();

    try {
      await transcriptionService.initialize();
      if (!isTranscriptionReady) {
        isTranscriptionReady = true;
        updateFloatingButtonState('idle');
      }
      console.log('[OK] Batch transcription ready (fallback)');
    } catch (error) {
      console.error('[ERROR] Failed to load batch model:', error);
    }
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
  streamingModel?.cleanup();
  nemotronStreamingModel?.cleanup();
  trayManager?.destroy();
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

ipcMain.handle('settings:get', () => settingsManager.get());

ipcMain.handle('settings:save', (_event, partial) => {
  const wasAutoStart = settingsManager.get().autoStart;
  settingsManager.set(partial || {});
  const next = settingsManager.get();
  if (next.autoStart !== wasAutoStart) {
    applyAutoStart(next.autoStart);
  }
  return next;
});
