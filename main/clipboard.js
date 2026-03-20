import electron from 'electron';

const { clipboard } = electron;

function runWithRetries(operation, attempts = 2) {
  let lastError = null;

  for (let index = 0; index < attempts; index += 1) {
    try {
      return operation();
    } catch (error) {
      lastError = error;
    }
  }

  if (lastError) {
    throw lastError;
  }

  return undefined;
}

function safeReadText(clipboardImpl) {
  try {
    return clipboardImpl.readText();
  } catch {
    return '';
  }
}

export function captureClipboardState(clipboardImpl = clipboard) {
  const formats = clipboardImpl.availableFormats();
  const buffers = [];

  for (const format of formats) {
    try {
      buffers.push({ format, data: clipboardImpl.readBuffer(format) });
    } catch {
      // Skip unsupported clipboard formats for the current platform.
    }
  }

  return {
    buffers,
    text: safeReadText(clipboardImpl)
  };
}

export function restoreClipboardState(snapshot, clipboardImpl = clipboard) {
  try {
    runWithRetries(() => clipboardImpl.clear());
  } catch {
    // Ignore clipboard clear failures; we'll still attempt to restore formats and text below.
  }

  let restoredAnyFormat = false;

  for (const entry of snapshot?.buffers || []) {
    try {
      runWithRetries(() => clipboardImpl.writeBuffer(entry.format, entry.data));
      restoredAnyFormat = true;
    } catch {
      // Ignore formats that cannot be restored on this machine.
    }
  }

  const targetText = typeof snapshot?.text === 'string' ? snapshot.text : '';
  const currentText = safeReadText(clipboardImpl);
  const shouldRestoreText =
    targetText !== currentText
    || (!restoredAnyFormat && targetText.length > 0)
    || (!restoredAnyFormat && currentText.length > 0 && targetText.length === 0);

  if (shouldRestoreText) {
    try {
      runWithRetries(() => clipboardImpl.writeText(targetText));
    } catch {
      // Keep clipboard restoration best-effort; callers should never crash on clipboard contention.
    }
  }
}
