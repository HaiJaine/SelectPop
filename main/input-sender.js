import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolvePowerShellScriptPath } from './paths.js';

const execFileAsync = promisify(execFile);

const LETTER_KEYS = Object.fromEntries(
  'abcdefghijklmnopqrstuvwxyz'.split('').map((key, index) => [key, 0x41 + index])
);

const DIGIT_KEYS = Object.fromEntries(
  '0123456789'.split('').map((key, index) => [key, 0x30 + index])
);

const FUNCTION_KEYS = Object.fromEntries(
  Array.from({ length: 12 }, (_, index) => [`f${index + 1}`, 0x70 + index])
);

const SPECIAL_KEYS = {
  ctrl: 0x11,
  alt: 0x12,
  shift: 0x10,
  win: 0x5b,
  space: 0x20,
  enter: 0x0d,
  tab: 0x09,
  delete: 0x2e,
  home: 0x24,
  end: 0x23,
  pageup: 0x21,
  pagedown: 0x22,
  up: 0x26,
  down: 0x28,
  left: 0x25,
  right: 0x27
};

const KEY_TO_VK = {
  ...LETTER_KEYS,
  ...DIGIT_KEYS,
  ...FUNCTION_KEYS,
  ...SPECIAL_KEYS
};

let inputQueue = Promise.resolve();
const MODIFIER_ORDER = ['ctrl', 'shift', 'alt', 'win'];

export function normalizeHotkeyKeys(keys) {
  const normalizedKeys = Array.from(
    new Set(
      (keys || [])
        .map((key) => String(key || '').trim().toLowerCase())
        .filter(Boolean)
    )
  );

  if (!normalizedKeys.length) {
    throw new Error('快捷键不能为空。');
  }

  const modifiers = MODIFIER_ORDER.filter((key) => normalizedKeys.includes(key));
  const mainKeys = normalizedKeys.filter((key) => !MODIFIER_ORDER.includes(key));

  if (!mainKeys.length) {
    throw new Error('快捷键必须包含至少一个非修饰键。');
  }

  if (mainKeys.length > 1) {
    throw new Error('快捷键只能包含一个主键。');
  }

  const orderedKeys = [...modifiers, mainKeys[0]];

  for (const key of orderedKeys) {
    if (!KEY_TO_VK[key]) {
      throw new Error(`不支持的快捷键：${key}`);
    }
  }

  return orderedKeys;
}

function mapKeysToVirtualKeys(keys) {
  return normalizeHotkeyKeys(keys).map((key) => KEY_TO_VK[key]);
}

async function sendVirtualKeyChord(virtualKeys) {
  if (!virtualKeys.length) {
    return;
  }

  const scriptPath = resolvePowerShellScriptPath();
  await execFileAsync(
    'powershell.exe',
    [
      '-NoProfile',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      scriptPath,
      '-Chord',
      virtualKeys.join(',')
    ],
    {
      windowsHide: true
    }
  );
}

export function sendKeys(keys) {
  const virtualKeys = mapKeysToVirtualKeys(keys);
  inputQueue = inputQueue
    .catch(() => {})
    .then(() => sendVirtualKeyChord(virtualKeys));
  return inputQueue;
}

export function sendCopyShortcut() {
  return sendKeys(['ctrl', 'c']);
}
