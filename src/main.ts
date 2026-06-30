import { app, BrowserWindow, globalShortcut, ipcMain, clipboard, screen, systemPreferences, Notification } from 'electron';
import * as path from 'path';
import * as fs from 'fs';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { RecordingManager } from './recording';
import { ModularTranscriptionService } from './transcription-router';
import { MoonshineStreamingModel, StreamingEvent } from './models/MoonshineStreamingModel';
import { NemotronStreamingModel, NemotronStreamingEvent } from './models/NemotronStreamingModel';
import { ElevenLabsV2StreamingModel, ElevenLabsV2StreamingEvent } from './models/ElevenLabsV2StreamingModel';
import { CartesiaInk2StreamingModel, CartesiaInk2StreamingEvent } from './models/CartesiaInk2StreamingModel';
import { SettingsManager } from './settings';
import { TrayManager } from './tray';
import { extractTrailingAction } from './voice-actions';
import { fireKeystroke } from './keystroke';
import {
  checkPythonRuntime,
  installLinuxPythonRuntime,
  pythonExecutable,
  pythonScriptPath,
} from './python-runtime';

const execFileAsync = promisify(execFile);

function loadDotEnvFile(): void {
  const envPath = path.join(process.cwd(), '.env');
  if (!fs.existsSync(envPath)) return;

  try {
    const overrideKeys = new Set([
      'OPENWHISPER_AUTO_STOP_SILENCE_MS',
      'OPENWHISPER_CLOUD_USAGE_ALERT_MS',
      'OPENWHISPER_VAD_MODE',
      'OPENWHISPER_WEBRTC_VAD_AGGRESSIVENESS',
      'OPENWHISPER_WEBRTC_VAD_MIN_SPEECH_RATIO',
      'OPENWHISPER_VAD_RMS_THRESHOLD',
      'OPENWHISPER_VAD_DEBUG',
    ]);
    const lines = fs.readFileSync(envPath, 'utf-8').split(/\r?\n/);
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;

      const separator = trimmed.indexOf('=');
      if (separator === -1) continue;

      const key = trimmed.slice(0, separator).trim();
      let value = trimmed.slice(separator + 1).trim();
      if (!key) continue;

      if (
        (value.startsWith('"') && value.endsWith('"'))
        || (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }

      if (process.env[key] !== undefined && !overrideKeys.has(key)) continue;
      process.env[key] = value;
    }
  } catch (error) {
    console.log(`[WARN] Could not load .env: ${error}`);
  }
}

loadDotEnvFile();

let mainWindow: BrowserWindow | null = null;
let floatingButtonWindow: BrowserWindow | null = null;
let settingsWindow: BrowserWindow | null = null;
let trayManager: TrayManager | null = null;
let recordingManager: RecordingManager | null = null;
let transcriptionService: ModularTranscriptionService | null = null;
let streamingModel: MoonshineStreamingModel | null = null;
let nemotronStreamingModel: NemotronStreamingModel | null = null;
let elevenLabsV2StreamingModel: ElevenLabsV2StreamingModel | null = null;
let cartesiaInk2StreamingModel: CartesiaInk2StreamingModel | null = null;
let useStreaming = false;
let isRecording = false;
let isTranscriptionReady = false;
let isTogglingRecording = false;
let lastToggleAt = 0;
let previousWindowFocus: any = null;
let saveButtonPositionTimer: NodeJS.Timeout | null = null;
let liveTypedText = '';
let liveTypeQueue: Promise<void> = Promise.resolve();
let isInstallingPythonRuntime = false;
let cloudRecordingStartedAt = 0;
let cloudUsageAlerted = false;
let cloudUsageAlertTimer: NodeJS.Timeout | null = null;
let cloudStreamActiveStartedAt = 0;
let cloudStreamActiveMs = 0;
let cloudPausedStartedAt = 0;
let cloudPausedMs = 0;
const settingsManager = new SettingsManager();

const cloudUsageFile = path.join(app.getPath('userData'), 'cloud-usage.json');
const DEFAULT_CLOUD_USAGE_ALERT_MS = 5 * 60 * 1000;

interface CloudUsageLedger {
  totalMs: number;
  alertedAtMs: number;
  sessions: Array<{
    engine: string;
    startedAt: string;
    durationMs: number;
  }>;
}

function getActiveStreamingModel(): MoonshineStreamingModel | NemotronStreamingModel | ElevenLabsV2StreamingModel | CartesiaInk2StreamingModel | null {
  return cartesiaInk2StreamingModel || elevenLabsV2StreamingModel || nemotronStreamingModel || streamingModel;
}

function getActiveStreamingEngineLabel(): string {
  if (cartesiaInk2StreamingModel) return 'Cartesia Ink 2 realtime';
  if (elevenLabsV2StreamingModel) return 'ElevenLabs Scribe v2 realtime';
  if (nemotronStreamingModel) return 'Nemotron streaming';
  return 'Moonshine v2 streaming';
}

function isCloudStreamingEngineActive(): boolean {
  return Boolean(cartesiaInk2StreamingModel || elevenLabsV2StreamingModel);
}

function cloudUsageAlertMs(): number {
  return Number(process.env.OPENWHISPER_CLOUD_USAGE_ALERT_MS || DEFAULT_CLOUD_USAGE_ALERT_MS);
}

function loadCloudUsageLedger(): CloudUsageLedger {
  try {
    if (fs.existsSync(cloudUsageFile)) {
      const ledger = JSON.parse(fs.readFileSync(cloudUsageFile, 'utf-8'));
      return {
        totalMs: Number(ledger.totalMs || 0),
        alertedAtMs: Number(ledger.alertedAtMs || 0),
        sessions: Array.isArray(ledger.sessions) ? ledger.sessions : [],
      };
    }
  } catch (error) {
    console.log(`[WARN] Could not load cloud usage ledger: ${error}`);
  }

  return { totalMs: 0, alertedAtMs: 0, sessions: [] };
}

function saveCloudUsageLedger(ledger: CloudUsageLedger): void {
  try {
    const dir = path.dirname(cloudUsageFile);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(cloudUsageFile, JSON.stringify(ledger, null, 2), 'utf-8');
  } catch (error) {
    console.log(`[WARN] Could not save cloud usage ledger: ${error}`);
  }
}

function notifyCloudUsageThreshold(totalMs: number, thresholdMs: number): void {
  const totalMinutes = (totalMs / 60000).toFixed(1);
  const thresholdMinutes = Math.round(thresholdMs / 60000);
  const body = `Estimated cloud STT usage reached ${totalMinutes} minutes. Threshold: ${thresholdMinutes} minutes.`;

  console.log(`[ALERT] ${body}`);
  if (Notification.isSupported()) {
    new Notification({
      title: 'Cloud STT usage alert',
      body,
    }).show();
  }
}

function markCloudUsageAlerted(estimatedTotalMs: number): void {
  const ledger = loadCloudUsageLedger();
  ledger.alertedAtMs = estimatedTotalMs;
  saveCloudUsageLedger(ledger);
  cloudUsageAlerted = true;
}

function startCloudUsageAlertTimer(): void {
  const thresholdMs = cloudUsageAlertMs();
  if (thresholdMs <= 0 || !cloudRecordingStartedAt) return;

  const ledger = loadCloudUsageLedger();
  cloudUsageAlerted = ledger.alertedAtMs >= thresholdMs;
  if (cloudUsageAlerted) return;

  if (cloudUsageAlertTimer) clearInterval(cloudUsageAlertTimer);
  cloudUsageAlertTimer = setInterval(() => {
    if (!cloudRecordingStartedAt || cloudUsageAlerted) return;

    const latestLedger = loadCloudUsageLedger();
    const estimatedTotalMs = latestLedger.totalMs + (Date.now() - cloudRecordingStartedAt);
    if (estimatedTotalMs >= thresholdMs) {
      notifyCloudUsageThreshold(estimatedTotalMs, thresholdMs);
      markCloudUsageAlerted(estimatedTotalMs);
    }
  }, 5000);
}

function stopCloudUsageAlertTimer(): void {
  if (cloudUsageAlertTimer) {
    clearInterval(cloudUsageAlertTimer);
    cloudUsageAlertTimer = null;
  }
}

function recordCloudUsageSession(engine: string, startedAtMs: number, endedAtMs: number): void {
  if (!startedAtMs || endedAtMs <= startedAtMs) return;

  const durationMs = endedAtMs - startedAtMs;
  const ledger = loadCloudUsageLedger();
  ledger.totalMs += durationMs;
  ledger.sessions.push({
    engine,
    startedAt: new Date(startedAtMs).toISOString(),
    durationMs,
  });
  ledger.sessions = ledger.sessions.slice(-500);

  const thresholdMs = cloudUsageAlertMs();
  if (thresholdMs > 0 && ledger.totalMs >= thresholdMs && ledger.alertedAtMs < thresholdMs) {
    ledger.alertedAtMs = ledger.totalMs;
    cloudUsageAlerted = true;
    notifyCloudUsageThreshold(ledger.totalMs, thresholdMs);
  }

  saveCloudUsageLedger(ledger);
}

function formatDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}m ${seconds}s`;
}

function resetCloudStreamTimers(): void {
  cloudStreamActiveStartedAt = Date.now();
  cloudStreamActiveMs = 0;
  cloudPausedStartedAt = 0;
  cloudPausedMs = 0;
}

function markCloudStreamPaused(): void {
  const now = Date.now();
  if (cloudStreamActiveStartedAt) {
    cloudStreamActiveMs += now - cloudStreamActiveStartedAt;
    cloudStreamActiveStartedAt = 0;
  }
  if (!cloudPausedStartedAt) {
    cloudPausedStartedAt = now;
  }
}

function markCloudStreamResumed(): void {
  const now = Date.now();
  if (cloudPausedStartedAt) {
    cloudPausedMs += now - cloudPausedStartedAt;
    cloudPausedStartedAt = 0;
  }
  if (!cloudStreamActiveStartedAt) {
    cloudStreamActiveStartedAt = now;
  }
}

function cloudStreamTimingSnapshot(): { activeMs: number; pausedMs: number; totalMs: number } {
  const now = Date.now();
  const activeMs = cloudStreamActiveMs + (cloudStreamActiveStartedAt ? now - cloudStreamActiveStartedAt : 0);
  const pausedMs = cloudPausedMs + (cloudPausedStartedAt ? now - cloudPausedStartedAt : 0);
  const totalMs = cloudRecordingStartedAt ? now - cloudRecordingStartedAt : activeMs + pausedMs;
  return { activeMs, pausedMs, totalMs };
}

async function runKeyboardAutomation(action: object): Promise<void> {
  const scriptPath = pythonScriptPath('keyboard_automation.py');
  await new Promise<void>((resolve, reject) => {
    const child = require('child_process').spawn(pythonExecutable(), [scriptPath]);
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
    const { stdout } = await execFileAsync(pythonExecutable(), [scriptPath, 'get']);
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
    const { stdout } = await execFileAsync(pythonExecutable(), [scriptPath, 'restore', JSON.stringify(windowInfo)]);
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
        if (isCloudStreamingEngineActive()) {
          cloudRecordingStartedAt = Date.now();
          cloudUsageAlerted = false;
          resetCloudStreamTimers();
          startCloudUsageAlertTimer();
        }
        console.log('[OK] Streaming transcription started');
      } catch (error) {
        console.error('[ERROR] Streaming start error:', error);
        stopCloudUsageAlertTimer();
        cloudRecordingStartedAt = 0;
        cloudUsageAlerted = false;
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
        const engineLabel = getActiveStreamingEngineLabel();
        const finalText = await activeStreamingModel.stopStreaming();
        if (isCloudStreamingEngineActive() && cloudRecordingStartedAt) {
          const stoppedAt = Date.now();
          const timing = cloudStreamTimingSnapshot();
          recordCloudUsageSession(engineLabel, cloudRecordingStartedAt, stoppedAt);
          console.log(
            `[USAGE] ${engineLabel}: provider-connected ${formatDuration(timing.activeMs)}, `
            + `paused/listening ${formatDuration(timing.pausedMs)}, total recording ${formatDuration(timing.totalMs)}`
          );
          stopCloudUsageAlertTimer();
          cloudRecordingStartedAt = 0;
          cloudUsageAlerted = false;
        }
        await liveTypeQueue;

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
        if (isCloudStreamingEngineActive() && cloudRecordingStartedAt) {
          const stoppedAt = Date.now();
          const timing = cloudStreamTimingSnapshot();
          recordCloudUsageSession(getActiveStreamingEngineLabel(), cloudRecordingStartedAt, stoppedAt);
          console.log(
            `[USAGE] ${getActiveStreamingEngineLabel()}: provider-connected ${formatDuration(timing.activeMs)}, `
            + `paused/listening ${formatDuration(timing.pausedMs)}, total recording ${formatDuration(timing.totalMs)}`
          );
          stopCloudUsageAlertTimer();
          cloudRecordingStartedAt = 0;
          cloudUsageAlerted = false;
        }
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

function showSetupRequired(missing: string[], python: string): void {
  if (!mainWindow || mainWindow.isDestroyed()) return;

  const send = () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    mainWindow.webContents.send('app-ready');
    mainWindow.webContents.send('setup-required', { missing, python });
    mainWindow.show();
    updateFloatingButtonState('processing');
  };

  if (mainWindow.webContents.isLoading()) {
    mainWindow.webContents.once('did-finish-load', send);
  } else {
    send();
  }
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

  if (app.isPackaged && process.platform === 'linux') {
    const runtime = await checkPythonRuntime();
    if (!runtime.ok) {
      console.log('[SETUP] Linux Python runtime needs setup:', runtime.missing.join(', '));
      showSetupRequired(runtime.missing, runtime.python);

      app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) {
          createWindow();
        }
      });
      return;
    }
  }

  const settings = settingsManager.get();
  const configuredTranscriptionEngine = process.env.OPENWHISPER_TRANSCRIPTION_ENGINE
    || settings.transcriptionEngine
    || 'auto';
  const transcriptionEngine = configuredTranscriptionEngine === 'auto'
    ? 'nemotron-streaming'
    : configuredTranscriptionEngine;
  const shouldUseCartesiaInk2 = transcriptionEngine === 'cartesia-ink2';
  const shouldUseElevenLabsV2 = transcriptionEngine === 'elevenlabs-v2';
  const shouldUseNemotronStreaming = transcriptionEngine === 'nemotron-streaming';
  const shouldUseMoonshineStreaming = !shouldUseCartesiaInk2 && !shouldUseElevenLabsV2 && !shouldUseNemotronStreaming;

  if (shouldUseCartesiaInk2) {
    console.log('[INIT] Checking for Cartesia Ink 2 realtime...');
    cartesiaInk2StreamingModel = new CartesiaInk2StreamingModel();

    try {
      const streamingAvailable = await cartesiaInk2StreamingModel.isAvailable();
      if (streamingAvailable) {
        await cartesiaInk2StreamingModel.initialize();
        useStreaming = true;
        isTranscriptionReady = true;
        updateFloatingButtonState('idle');
        console.log('[OK] Cartesia Ink 2 realtime ready');

        cartesiaInk2StreamingModel.on('transcription', (event: CartesiaInk2StreamingEvent) => {
          if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('streaming-text', {
              type: event.type,
              text: event.text,
            });
          }

          if (isRecording && (event.type === 'partial' || event.type === 'final')) {
            queueLiveTextChange(cartesiaInk2StreamingModel?.getFullText() || event.text);
          }
        });

        cartesiaInk2StreamingModel.on('auto-stop', (event: { reason: string; silenceMs: number }) => {
          if (!isRecording) return;
          markCloudStreamPaused();
          console.log(`[INFO] Paused Cartesia cloud stream after ${event.silenceMs}ms of ${event.reason}; local VAD is still listening`);
          liveTypedText = cartesiaInk2StreamingModel?.getFullText() || liveTypedText;
        });

        cartesiaInk2StreamingModel.on('auto-resume', () => {
          if (!isRecording) return;
          markCloudStreamResumed();
          console.log('[INFO] Resumed Cartesia cloud stream after speech was detected');
          liveTypedText = cartesiaInk2StreamingModel?.getFullText() || liveTypedText;
        });
      } else {
        console.log('[INFO] Cartesia Ink 2 not available; set CARTESIA_API_KEY to enable it');
      }
    } catch (error) {
      console.log('[INFO] Cartesia Ink 2 streaming init failed, using batch mode:', error);
    }
  } else if (shouldUseElevenLabsV2) {
    console.log('[INIT] Checking for ElevenLabs Scribe v2 realtime...');
    elevenLabsV2StreamingModel = new ElevenLabsV2StreamingModel();

    try {
      const streamingAvailable = await elevenLabsV2StreamingModel.isAvailable();
      if (streamingAvailable) {
        await elevenLabsV2StreamingModel.initialize();
        useStreaming = true;
        isTranscriptionReady = true;
        updateFloatingButtonState('idle');
        console.log('[OK] ElevenLabs Scribe v2 realtime ready');

        elevenLabsV2StreamingModel.on('transcription', (event: ElevenLabsV2StreamingEvent) => {
          if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('streaming-text', {
              type: event.type,
              text: event.text,
            });
          }

          if (isRecording && (event.type === 'partial' || event.type === 'final')) {
            queueLiveTextChange(elevenLabsV2StreamingModel?.getFullText() || event.text);
          }
        });

        elevenLabsV2StreamingModel.on('auto-stop', (event: { reason: string; silenceMs: number }) => {
          if (!isRecording) return;
          markCloudStreamPaused();
          console.log(`[INFO] Paused ElevenLabs cloud stream after ${event.silenceMs}ms of ${event.reason}; local VAD is still listening`);
          liveTypedText = elevenLabsV2StreamingModel?.getFullText() || liveTypedText;
        });

        elevenLabsV2StreamingModel.on('auto-resume', () => {
          if (!isRecording) return;
          markCloudStreamResumed();
          console.log('[INFO] Resumed ElevenLabs cloud stream after speech was detected');
          liveTypedText = elevenLabsV2StreamingModel?.getFullText() || liveTypedText;
        });
      } else {
        console.log('[INFO] ElevenLabs v2 not available; set ELEVENLABS_API_KEY to enable it');
      }
    } catch (error) {
      console.log('[INFO] ElevenLabs v2 streaming init failed, using batch mode:', error);
    }
  } else if (shouldUseNemotronStreaming) {
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
  if (isCloudStreamingEngineActive() && cloudRecordingStartedAt) {
    const stoppedAt = Date.now();
    const timing = cloudStreamTimingSnapshot();
    recordCloudUsageSession(getActiveStreamingEngineLabel(), cloudRecordingStartedAt, stoppedAt);
    console.log(
      `[USAGE] ${getActiveStreamingEngineLabel()}: provider-connected ${formatDuration(timing.activeMs)}, `
      + `paused/listening ${formatDuration(timing.pausedMs)}, total recording ${formatDuration(timing.totalMs)}`
    );
    cloudRecordingStartedAt = 0;
  }
  stopCloudUsageAlertTimer();
  globalShortcut.unregisterAll();
  cartesiaInk2StreamingModel?.cleanup();
  elevenLabsV2StreamingModel?.cleanup();
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

ipcMain.handle('setup-python-runtime', async () => {
  if (isInstallingPythonRuntime) {
    return { ok: false, error: 'Python setup is already running.' };
  }

  isInstallingPythonRuntime = true;
  try {
    await installLinuxPythonRuntime((line) => {
      mainWindow?.webContents.send('setup-progress', { line });
    });

    const runtime = await checkPythonRuntime();
    if (!runtime.ok) {
      throw new Error(`Setup finished but modules are still missing: ${runtime.missing.join(', ')}`);
    }

    mainWindow?.webContents.send('setup-complete', {
      message: 'Python setup complete. Restart Listen to enable dictation.',
    });
    return { ok: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    mainWindow?.webContents.send('setup-error', { error: message });
    return { ok: false, error: message };
  } finally {
    isInstallingPythonRuntime = false;
  }
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
