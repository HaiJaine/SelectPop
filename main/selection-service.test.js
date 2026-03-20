import assert from 'node:assert/strict';
import test from 'node:test';
import { SelectionService } from './selection-service.js';

test('returns script selection without triggering clipboard fallback', async () => {
  let scriptCalls = 0;
  let clipboardCalls = 0;
  const service = new SelectionService({
    sendCopyShortcut: async () => {},
    resolvePowerShellAssetPathImpl: async () => 'read-selection.ps1',
    execFileImpl: async () => {
      scriptCalls += 1;
      return {
        stdout: JSON.stringify({
          text: 'hello world',
          strategy: 'uia',
          focusKind: 'editor',
          timedOut: false,
          error: ''
        }),
        stderr: ''
      };
    },
    readSelectedTextFromClipboardImpl: async () => {
      clipboardCalls += 1;
      return 'clipboard';
    },
    logger: null
  });

  const result = await service.readSelection({
    allowClipboardFallback: false
  });

  assert.equal(result.ok, true);
  assert.equal(result.text, 'hello world');
  assert.equal(result.strategy, 'uia');
  assert.equal(result.focusKind, 'editor');
  assert.equal(scriptCalls, 1);
  assert.equal(clipboardCalls, 0);
});

test('skips clipboard fallback entirely when disabled', async () => {
  let clipboardCalls = 0;
  const service = new SelectionService({
    sendCopyShortcut: async () => {},
    resolvePowerShellAssetPathImpl: async () => 'read-selection.ps1',
    execFileImpl: async () => ({ stdout: '', stderr: '' }),
    readSelectedTextFromClipboardImpl: async () => {
      clipboardCalls += 1;
      return 'clipboard';
    },
    logger: null
  });

  const result = await service.readSelection({
    allowClipboardFallback: false
  });

  assert.equal(result.ok, false);
  assert.equal(result.text, '');
  assert.equal(clipboardCalls, 0);
});

test('uses the injected copy shortcut for clipboard fallback', async () => {
  const sentShortcuts = [];
  const service = new SelectionService({
    sendCopyShortcut: async () => {
      sentShortcuts.push('default');
    },
    resolvePowerShellAssetPathImpl: async () => 'read-selection.ps1',
    execFileImpl: async () => ({ stdout: '', stderr: '' }),
    readSelectedTextFromClipboardImpl: async (sendCopyShortcut) => {
      await sendCopyShortcut();
      return 'clipboard';
    },
    logger: null
  });

  const result = await service.readSelection({
    allowClipboardFallback: true,
    sendCopyShortcut: async () => {
      sentShortcuts.push('vscode');
    },
    clipboardStrategy: 'vscode-terminal-copy-recovery'
  });

  assert.equal(result.ok, true);
  assert.equal(result.text, 'clipboard');
  assert.equal(result.strategy, 'vscode-terminal-copy-recovery');
  assert.deepEqual(sentShortcuts, ['vscode']);
});

test('prefers helper-backed clipboard reads when copy keys are available', async () => {
  const helperCalls = [];
  let fallbackCalls = 0;
  const service = new SelectionService({
    sendCopyShortcut: async () => {},
    resolvePowerShellAssetPathImpl: async () => 'read-selection.ps1',
    execFileImpl: async () => ({ stdout: '', stderr: '' }),
    readClipboardTextAfterCopyImpl: async (payload) => {
      helperCalls.push(payload);
      return {
        text: 'helper clipboard'
      };
    },
    readSelectedTextFromClipboardImpl: async () => {
      fallbackCalls += 1;
      return 'fallback';
    },
    logger: null
  });

  const result = await service.readClipboardSelection({
    strategy: 'vscode-terminal-copy-recovery',
    clipboardReadOptions: {
      copyKeys: ['ctrl', 'shift', 'c'],
      timeoutMs: 600,
      pollMs: 40
    }
  });

  assert.equal(result.ok, true);
  assert.equal(result.text, 'helper clipboard');
  assert.equal(result.strategy, 'vscode-terminal-copy-recovery');
  assert.deepEqual(helperCalls, [{
    keys: ['ctrl', 'shift', 'c'],
    timeoutMs: 600,
    pollMs: 40
  }]);
  assert.equal(fallbackCalls, 0);
});

test('falls back to JS clipboard polling when helper-backed copy read fails', async () => {
  let fallbackCalls = 0;
  const service = new SelectionService({
    sendCopyShortcut: async () => {},
    resolvePowerShellAssetPathImpl: async () => 'read-selection.ps1',
    execFileImpl: async () => ({ stdout: '', stderr: '' }),
    readClipboardTextAfterCopyImpl: async () => {
      throw new Error('helper unavailable');
    },
    readSelectedTextFromClipboardImpl: async () => {
      fallbackCalls += 1;
      return 'fallback clipboard';
    },
    logger: null
  });

  const result = await service.readClipboardSelection({
    strategy: 'clipboard-fallback',
    clipboardReadOptions: {
      copyKeys: ['ctrl', 'c']
    }
  });

  assert.equal(result.ok, true);
  assert.equal(result.text, 'fallback clipboard');
  assert.equal(fallbackCalls, 1);
});

test('reports script timeout as structured result', async () => {
  const service = new SelectionService({
    sendCopyShortcut: async () => {},
    resolvePowerShellAssetPathImpl: async () => 'read-selection.ps1',
    execFileImpl: async () => {
      const error = new Error('timed out');
      error.killed = true;
      error.signal = 'SIGTERM';
      throw error;
    },
    logger: null
  });

  const result = await service.readScriptSelection({
    scriptMode: 'uia',
    scriptTimeoutMs: 900
  });

  assert.equal(result.ok, false);
  assert.equal(result.strategy, 'script-timeout');
  assert.equal(result.timedOut, true);
});
