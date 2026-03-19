import { clipboard, screen } from 'electron';
import { captureClipboardState, restoreClipboardState } from './clipboard.js';
import { sleep } from './utils.js';

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

export async function readSelectedTextFromClipboard(sendCopyShortcut) {
  const snapshot = captureClipboardState();
  const probe = `__selectpop_probe__${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`;

  try {
    clipboard.writeText(probe);
    await sleep(30);
    await sendCopyShortcut();

    const startedAt = Date.now();

    while (Date.now() - startedAt < SELECTION_PROBE_TIMEOUT_MS) {
      const currentText = clipboard.readText();

      if (currentText && currentText !== probe) {
        return currentText.trim();
      }

      await sleep(25);
    }

    return '';
  } finally {
    restoreClipboardState(snapshot);
  }
}
