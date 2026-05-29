/**
 * voice-actions.ts
 *
 * Mid-stream voice-command recognition for dictation.
 *
 * Each command is a trigger phrase (regex anchored at the end of the current
 * partial) bound to a keystroke action. extractTrailingAction strips the
 * matched trigger from the text so it isn't typed into the focused app.
 *
 * Design intent: triggers require an explicit verb prefix ("press"/"go"/"next"/
 * "previous"/"new"/"close"/"switch") so natural speech like "I'll enter the
 * room" or "open the door" never fires by accident.
 */
import type { KeystrokeAction } from './keystroke';

interface VoiceCommand {
  /** Pretty name for logs. */
  name: string;
  /** Must use `[.!?:;,]*\s*$` or similar suffix anchor. Case-insensitive. */
  pattern: RegExp;
  /** Keystroke fired when this trigger matches. */
  action: KeystrokeAction;
}

// Order matters only for log readability — we match against all and pick the
// LONGEST match (covers e.g. "shift tab" winning over "tab").
const COMMANDS: VoiceCommand[] = [
  // Return / send
  {
    name: 'press enter',
    pattern: /[\s,]*\bpress\s+(?:enter|return|send|submit|new\s*line)\b[.!?]?\s*$/i,
    action: { key: 'Return' },
  },

  // Tab navigation
  {
    name: 'press shift tab',
    pattern: /[\s,]*\bpress\s+shift\s+tab\b[.!?]?\s*$/i,
    action: { key: 'Tab', modifiers: ['shift'] },
  },
  {
    name: 'press tab',
    pattern: /[\s,]*\bpress\s+tab\b[.!?]?\s*$/i,
    action: { key: 'Tab' },
  },

  // Common single keys
  {
    name: 'press escape',
    pattern: /[\s,]*\bpress\s+(?:escape|esc)\b[.!?]?\s*$/i,
    action: { key: 'Escape' },
  },
  {
    name: 'press space',
    pattern: /[\s,]*\bpress\s+space\b[.!?]?\s*$/i,
    action: { key: 'Space' },
  },

  // Arrow keys
  {
    name: 'press up',
    pattern: /[\s,]*\bpress\s+up\b[.!?]?\s*$/i,
    action: { key: 'ArrowUp' },
  },
  {
    name: 'press down',
    pattern: /[\s,]*\bpress\s+down\b[.!?]?\s*$/i,
    action: { key: 'ArrowDown' },
  },
  {
    name: 'press left',
    pattern: /[\s,]*\bpress\s+left\b[.!?]?\s*$/i,
    action: { key: 'ArrowLeft' },
  },
  {
    name: 'press right',
    pattern: /[\s,]*\bpress\s+right\b[.!?]?\s*$/i,
    action: { key: 'ArrowRight' },
  },

  // Browser / app navigation
  {
    name: 'go back',
    pattern: /[\s,]*\bgo\s+back\b[.!?]?\s*$/i,
    action: { key: 'BracketLeft', modifiers: ['cmd'] },
  },
  {
    name: 'go forward',
    pattern: /[\s,]*\bgo\s+forward\b[.!?]?\s*$/i,
    action: { key: 'BracketRight', modifiers: ['cmd'] },
  },

  // Tabs / windows
  {
    name: 'next tab',
    pattern: /[\s,]*\bnext\s+tab\b[.!?]?\s*$/i,
    action: { key: 'Tab', modifiers: ['ctrl'] },
  },
  {
    name: 'previous tab',
    pattern: /[\s,]*\b(?:previous|prev)\s+tab\b[.!?]?\s*$/i,
    action: { key: 'Tab', modifiers: ['ctrl', 'shift'] },
  },
  {
    name: 'new tab',
    pattern: /[\s,]*\bnew\s+tab\b[.!?]?\s*$/i,
    action: { key: 'T', modifiers: ['cmd'] },
  },
  {
    name: 'close tab',
    pattern: /[\s,]*\bclose\s+(?:tab|window)\b[.!?]?\s*$/i,
    action: { key: 'W', modifiers: ['cmd'] },
  },
  {
    name: 'switch app',
    pattern: /[\s,]*\bswitch\s+app\b[.!?]?\s*$/i,
    action: { key: 'Tab', modifiers: ['cmd'] },
  },
];

export interface ExtractedAction {
  cleaned: string;
  action: KeystrokeAction | null;
  name: string | null;
}

/**
 * Match `text` against all commands; return the longest matching trigger.
 * `cleaned` is `text` with the trigger stripped from the suffix.
 */
export function extractTrailingAction(text: string): ExtractedAction {
  let best: { cmd: VoiceCommand; matchStart: number } | null = null;

  for (const cmd of COMMANDS) {
    const m = text.match(cmd.pattern);
    if (!m) continue;
    const start = m.index ?? text.length - m[0].length;
    // Prefer the match with the EARLIER start — that's the LONGEST trigger
    // (e.g. "shift tab" starts earlier than the shorter "tab" tail).
    if (best === null || start < best.matchStart) {
      best = { cmd, matchStart: start };
    }
  }

  if (!best) return { cleaned: text, action: null, name: null };
  return {
    cleaned: text.slice(0, best.matchStart).trimEnd(),
    action: best.cmd.action,
    name: best.cmd.name,
  };
}

// Re-export for callers that don't want to import keystroke separately.
export type { KeystrokeAction };
