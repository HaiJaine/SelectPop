import assert from 'node:assert/strict';
import test from 'node:test';
import { captureClipboardState, restoreClipboardState } from './clipboard.js';
import { readSelectedTextFromClipboard } from './selection-utils.js';

function createFakeClipboard(initialText = '', initialBuffers = []) {
  let text = initialText;
  const buffers = new Map(initialBuffers.map((entry) => [entry.format, entry.data]));
  const writes = [];

  return {
    writes,
    availableFormats() {
      return Array.from(buffers.keys());
    },
    readBuffer(format) {
      return buffers.get(format) || Buffer.from('');
    },
    writeBuffer(format, data) {
      writes.push({ type: 'buffer', format });
      buffers.set(format, data);
    },
    readText() {
      return text;
    },
    writeText(value) {
      writes.push({ type: 'text', value });
      text = String(value || '');
    },
    clear() {
      writes.push({ type: 'clear' });
      text = '';
      buffers.clear();
    }
  };
}

test('restores original clipboard text even when buffer restoration succeeds', () => {
  const clipboard = createFakeClipboard('temporary clipboard', [
    {
      format: 'text/plain',
      data: Buffer.from('temporary clipboard', 'utf8')
    }
  ]);

  restoreClipboardState({
    buffers: [
      {
        format: 'text/plain',
        data: Buffer.from('temporary clipboard', 'utf8')
      }
    ],
    text: 'original clipboard'
  }, clipboard);

  assert.equal(clipboard.readText(), 'original clipboard');
});

test('clipboard polling fallback no longer writes a visible probe string', async () => {
  const clipboard = createFakeClipboard('before copy');
  const snapshots = [];

  const selectedText = await readSelectedTextFromClipboard(async () => {
    clipboard.writeText('selected text');
  }, {
    clipboardImpl: clipboard,
    captureClipboardStateImpl: (clipboardImpl) => {
      const snapshot = captureClipboardState(clipboardImpl);
      snapshots.push(snapshot);
      return snapshot;
    },
    restoreClipboardStateImpl: restoreClipboardState,
    sleepImpl: async () => {}
  });

  assert.equal(selectedText, 'selected text');
  assert.equal(
    clipboard.writes.some((entry) => entry.type === 'text' && String(entry.value).startsWith('__selectpop_probe__')),
    false
  );
  assert.equal(clipboard.readText(), 'before copy');
  assert.equal(snapshots.length, 1);
});
