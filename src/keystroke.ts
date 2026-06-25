/**
 * keystroke.ts
 *
 * Fire a single OS keystroke (with optional modifiers) from a high-level
 * KeystrokeAction. macOS uses osascript / "tell System Events"; Linux/Windows
 * fall through to the shared Python keyboard automation helper.
 *
 * Each call spawns a fresh process. That's fine at voice-command frequency
 * (~once per spoken trigger). The per-partial typing path is the hot loop —
 * keystroke firing is not. If the persistent osascript helper lands later,
 * route fireKeystroke through it too.
 */
import { execFile } from 'child_process';
import { promisify } from 'util';
import { pythonExecutable, pythonScriptPath } from './python-runtime';

const execFileAsync = promisify(execFile);

export type KeyModifier = 'cmd' | 'shift' | 'ctrl' | 'alt';

export interface KeystrokeAction {
  /**
   * Logical key name. Letter keys are uppercase single letters ('A'..'Z'),
   * named keys use Web-style identifiers ('Return', 'Tab', 'Escape', 'Space',
   * 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'BracketLeft',
   * 'BracketRight'). Extend MAC_KEY_CODE / PYAUTOGUI_KEY_NAME below.
   */
  key: string;
  modifiers?: KeyModifier[];
}

// macOS virtual key codes (Carbon HIToolbox). Add as needed.
const MAC_KEY_CODE: Record<string, number> = {
  Return: 36,
  Tab: 48,
  Space: 49,
  Escape: 53,
  ArrowLeft: 123,
  ArrowRight: 124,
  ArrowDown: 125,
  ArrowUp: 126,
  BracketLeft: 33,
  BracketRight: 30,
  // Letter keys
  A: 0, B: 11, C: 8, D: 2, E: 14, F: 3, G: 5, H: 4, I: 34, J: 38,
  K: 40, L: 37, M: 46, N: 45, O: 31, P: 35, Q: 12, R: 15, S: 1, T: 17,
  U: 32, V: 9, W: 13, X: 7, Y: 16, Z: 6,
};

const MAC_MODIFIER_PHRASE: Record<KeyModifier, string> = {
  cmd: 'command down',
  shift: 'shift down',
  ctrl: 'control down',
  alt: 'option down',
};

// Helper key names for non-macOS fallback.
const HELPER_KEY_NAME: Record<string, string> = {
  Return: 'enter',
  Tab: 'tab',
  Space: 'space',
  Escape: 'esc',
  ArrowLeft: 'left',
  ArrowRight: 'right',
  ArrowDown: 'down',
  ArrowUp: 'up',
  BracketLeft: '[',
  BracketRight: ']',
};

function helperKey(key: string): string {
  if (HELPER_KEY_NAME[key]) return HELPER_KEY_NAME[key];
  if (/^[A-Z]$/.test(key)) return key.toLowerCase();
  throw new Error(`keyboard helper key mapping missing for "${key}"`);
}

const HELPER_MODIFIER_NAME: Record<KeyModifier, string> = {
  cmd: 'command',
  shift: 'shift',
  ctrl: 'ctrl',
  alt: 'alt',
};

export async function fireKeystroke(action: KeystrokeAction): Promise<void> {
  if (process.platform === 'darwin') {
    const code = MAC_KEY_CODE[action.key];
    if (code === undefined) {
      throw new Error(`No macOS key code mapping for "${action.key}"`);
    }
    let script = `tell application "System Events" to key code ${code}`;
    if (action.modifiers && action.modifiers.length > 0) {
      const using = action.modifiers.map(m => MAC_MODIFIER_PHRASE[m]).join(', ');
      script += ` using {${using}}`;
    }
    await execFileAsync('osascript', ['-e', script]);
    return;
  }

  // Linux / Windows: shared helper via stdin (no shell interpolation).
  const keys = [
    ...(action.modifiers ?? []).map(m => HELPER_MODIFIER_NAME[m]),
    helperKey(action.key),
  ];
  const scriptPath = pythonScriptPath('keyboard_automation.py');

  await new Promise<void>((resolve, reject) => {
    const child = require('child_process').spawn(pythonExecutable(), [scriptPath]);
    let stderr = '';
    child.stderr?.on('data', (d: Buffer) => { stderr += d.toString(); });
    child.on('error', reject);
    child.on('exit', (code: number) => {
      if (code === 0) resolve();
      else reject(new Error(`keyboard helper exited ${code}: ${stderr.trim()}`));
    });
    child.stdin.write(JSON.stringify({ type: 'hotkey', keys }));
    child.stdin.end();
  });
}
