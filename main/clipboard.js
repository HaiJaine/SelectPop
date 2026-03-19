import { clipboard } from 'electron';

export function captureClipboardState() {
  const formats = clipboard.availableFormats();
  const buffers = [];

  for (const format of formats) {
    try {
      buffers.push({ format, data: clipboard.readBuffer(format) });
    } catch {
      // Skip unsupported clipboard formats for the current platform.
    }
  }

  return {
    buffers,
    text: clipboard.readText()
  };
}

export function restoreClipboardState(snapshot) {
  clipboard.clear();
  let restoredAnyFormat = false;

  for (const entry of snapshot?.buffers || []) {
    try {
      clipboard.writeBuffer(entry.format, entry.data);
      restoredAnyFormat = true;
    } catch {
      // Ignore formats that cannot be restored on this machine.
    }
  }

  if (!restoredAnyFormat && snapshot?.text) {
    clipboard.writeText(snapshot.text);
  }
}
