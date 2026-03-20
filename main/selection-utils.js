import electron from 'electron';
import { captureClipboardState, restoreClipboardState } from './clipboard.js';
import { sleep } from './utils.js';

const { clipboard, screen } = electron;

export const SELECTION_ACTION_THRESHOLD_MS = 380;
export const SELECTION_DRAG_THRESHOLD_PX = 6;
export const SELECTION_PROBE_TIMEOUT_MS = 450;
export const SELECTION_COOLDOWN_MS = 180;
export const SELECTION_READ_DELAY_MS = 150;

export function normalizeHookPoint(point) {
  if (!point) {
    return { x: 0, y: 0 };
  }

  if (typeof screen.screenToDipPoint === 'function') {
    return screen.screenToDipPoint({ x: point.x, y: point.y });
  }

  return { x: point.x, y: point.y };
}

export function distanceBetweenPoints(a, b) {
  if (!a || !b) {
    return Number.POSITIVE_INFINITY;
  }

  return Math.hypot(a.x - b.x, a.y - b.y);
}

export async function readSelectedTextFromClipboard(sendCopyShortcut, options = {}) {
  const clipboardImpl = options?.clipboardImpl || clipboard;
  const captureClipboardStateImpl = options?.captureClipboardStateImpl || captureClipboardState;
  const restoreClipboardStateImpl = options?.restoreClipboardStateImpl || restoreClipboardState;
  const sleepImpl = options?.sleepImpl || sleep;
  const snapshot = captureClipboardStateImpl(clipboardImpl);
  const originalText = String(snapshot?.text || '');

  try {
    await sleepImpl(30);
    if (typeof options?.beforeSendCopyShortcut === 'function') {
      await options.beforeSendCopyShortcut();
    }
    await sendCopyShortcut();
    if (typeof options?.afterSendCopyShortcut === 'function') {
      await options.afterSendCopyShortcut();
    }

    const startedAt = Date.now();

    while (Date.now() - startedAt < SELECTION_PROBE_TIMEOUT_MS) {
      const currentText = clipboardImpl.readText();

      if (currentText && currentText !== originalText) {
        return currentText.trim();
      }

      await sleepImpl(25);
    }

    return '';
  } finally {
    restoreClipboardStateImpl(snapshot, clipboardImpl);
  }
}
