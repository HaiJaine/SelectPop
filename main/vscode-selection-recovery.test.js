import assert from 'node:assert/strict';
import test from 'node:test';
import { isVsCodeRecoveryProcess, VsCodeSelectionRecoveryService } from './vscode-selection-recovery.js';

test('recognizes VS Code and Cursor processes for recovery', () => {
  assert.equal(isVsCodeRecoveryProcess('code.exe'), true);
  assert.equal(isVsCodeRecoveryProcess('cursor.exe'), true);
});

test('does not treat standalone terminals as VS Code recovery targets', () => {
  assert.equal(isVsCodeRecoveryProcess('windowsTerminal.exe'), false);
  assert.equal(isVsCodeRecoveryProcess('wezterm-gui.exe'), false);
  assert.equal(isVsCodeRecoveryProcess('tabby.exe'), false);
});

test('recovery state machine stops at UIA success', async () => {
  const calls = [];
  const service = new VsCodeSelectionRecoveryService({
    selectionService: {
      readScriptSelection: async () => {
        calls.push('uia');
        return {
          ok: true,
          text: 'selected',
          strategy: 'uia',
          focusKind: 'editor',
          error: ''
        };
      },
      readClipboardSelection: async () => {
        calls.push('clipboard');
        return {
          ok: false,
          text: '',
          strategy: 'clipboard',
          focusKind: 'editor',
          error: 'unused'
        };
      }
    },
    sendTerminalCopyShortcut: async () => {},
    sendEditorCopyShortcut: async () => {},
    logger: null
  });

  const result = await service.recover({
    processName: 'code.exe',
    lastReason: 'mouse-drag',
    hasRecentMouseAnchor: true
  });

  assert.equal(result.ok, true);
  assert.equal(result.strategy, 'vscode-uia-recovery');
  assert.deepEqual(calls, ['uia']);
});

test('recovery state machine uses Ctrl+C directly for editor focus', async () => {
  const calls = [];
  const service = new VsCodeSelectionRecoveryService({
    selectionService: {
      readScriptSelection: async () => {
        calls.push('uia');
        return {
          ok: false,
          text: '',
          strategy: 'uia',
          focusKind: 'editor',
          error: 'empty'
        };
      },
      readClipboardSelection: async ({ strategy }) => {
        calls.push(strategy);
        return {
          ok: true,
          text: 'editor selection',
          strategy,
          focusKind: 'editor',
          error: ''
        };
      }
    },
    sendTerminalCopyShortcut: async () => {},
    sendEditorCopyShortcut: async () => {},
    logger: null
  });

  const result = await service.recover({
    processName: 'code.exe',
    lastReason: 'mouse-drag',
    hasRecentMouseAnchor: true
  });

  assert.equal(result.ok, true);
  assert.equal(result.strategy, 'vscode-editor-copy-recovery');
  assert.deepEqual(calls, ['uia', 'vscode-editor-copy-recovery']);
});

test('recovery never uses Ctrl+C when focus kind is terminal', async () => {
  const calls = [];
  const service = new VsCodeSelectionRecoveryService({
    selectionService: {
      readScriptSelection: async () => {
        calls.push('uia');
        return {
          ok: false,
          text: '',
          strategy: 'uia',
          focusKind: 'terminal',
          error: 'empty'
        };
      },
      readClipboardSelection: async ({ strategy }) => {
        calls.push(strategy);
        return {
          ok: false,
          text: '',
          strategy,
          focusKind: 'terminal',
          error: 'empty'
        };
      }
    },
    sendTerminalCopyShortcut: async () => {},
    sendEditorCopyShortcut: async () => {},
    logger: null
  });

  const result = await service.recover({
    processName: 'code.exe',
    lastReason: 'mouse-drag',
    hasRecentMouseAnchor: true
  });

  assert.equal(result.ok, false);
  assert.equal(result.strategy, 'vscode-recovery-failed');
  assert.deepEqual(calls, ['uia', 'vscode-terminal-copy-recovery']);
});

test('recovery skips copy-based attempts when copy recovery is disabled', async () => {
  const calls = [];
  const service = new VsCodeSelectionRecoveryService({
    selectionService: {
      readScriptSelection: async () => {
        calls.push('uia');
        return {
          ok: false,
          text: '',
          strategy: 'uia',
          focusKind: 'editor',
          error: 'empty'
        };
      },
      readClipboardSelection: async ({ strategy }) => {
        calls.push(strategy);
        return {
          ok: false,
          text: '',
          strategy,
          focusKind: 'editor',
          error: 'should not run'
        };
      }
    },
    sendTerminalCopyShortcut: async () => {},
    sendEditorCopyShortcut: async () => {},
    logger: null
  });

  const result = await service.recover({
    processName: 'code.exe',
    lastReason: 'mouse-drag',
    hasRecentMouseAnchor: true,
    allowCopyRecovery: false
  });

  assert.equal(result.ok, false);
  assert.equal(result.strategy, 'vscode-recovery-failed');
  assert.deepEqual(calls, ['uia']);
});
