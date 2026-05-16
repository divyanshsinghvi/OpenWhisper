/**
 * Unit tests for voice-actions.ts.
 *
 * Pure string-in / struct-out — no Electron, no audio, runs in milliseconds.
 * Run with: npx tsc --noEmit tests/test_voice_actions.ts (lint)
 *   or:    npx ts-node tests/test_voice_actions.ts        (execute)
 *
 * If a future test framework lands, port these `assertEq` calls over.
 */
import { extractTrailingAction } from '../src/voice-actions';

let failures = 0;

function assertEq<T>(actual: T, expected: T, label: string): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) {
    failures += 1;
    console.error(`[FAIL] ${label}\n        got: ${a}\n   expected: ${e}`);
  } else {
    console.log(`[ok]   ${label}`);
  }
}

// --- triggers fire ---
assertEq(
  extractTrailingAction('hello world press enter').name,
  'press enter',
  'press enter at end fires Return',
);
assertEq(
  extractTrailingAction('say something press shift tab').name,
  'press shift tab',
  'shift tab fires (and beats bare tab)',
);
assertEq(
  extractTrailingAction('done press tab').name,
  'press tab',
  'bare tab fires when no shift',
);
assertEq(
  extractTrailingAction('go back').name,
  'go back',
  'go back fires without "press" prefix',
);
assertEq(
  extractTrailingAction('close tab').name,
  'close tab',
  'close tab fires',
);
assertEq(
  extractTrailingAction('hello next tab').name,
  'next tab',
  'next tab fires',
);

// --- trigger text stripped from cleaned ---
assertEq(
  extractTrailingAction('hello world press enter').cleaned,
  'hello world',
  'cleaned strips "press enter"',
);
assertEq(
  extractTrailingAction('Form is done. press tab').cleaned,
  'Form is done.',
  'cleaned preserves prior punctuation, strips trigger',
);

// --- natural speech that mentions a trigger word should NOT fire ---
assertEq(
  extractTrailingAction('I want to enter the room').action,
  null,
  'no fire: bare "enter" without "press"',
);
assertEq(
  extractTrailingAction('I will press the button later').action,
  null,
  'no fire: "press" followed by non-trigger',
);
assertEq(
  extractTrailingAction('hello world').action,
  null,
  'no fire: ordinary speech',
);
assertEq(
  extractTrailingAction('press enter the room').action,
  null,
  'no fire: trigger not at suffix',
);

// --- punctuation / casing tolerance ---
assertEq(
  extractTrailingAction('hello PRESS ENTER').name,
  'press enter',
  'case insensitive',
);
assertEq(
  extractTrailingAction('hello press enter.').name,
  'press enter',
  'trailing period tolerated',
);
assertEq(
  extractTrailingAction('hello press enter!').name,
  'press enter',
  'trailing exclamation tolerated',
);

// --- aliases ---
assertEq(
  extractTrailingAction('hello press return').name,
  'press enter',
  'press return aliases to press enter',
);
assertEq(
  extractTrailingAction('hello press send').name,
  'press enter',
  'press send aliases to press enter',
);
assertEq(
  extractTrailingAction('hello press new line').name,
  'press enter',
  'press new line aliases',
);

// --- summary ---
if (failures > 0) {
  console.error(`\n${failures} test(s) failed.`);
  process.exit(1);
}
console.log('\nAll voice-action tests passed.');
