import assert from 'node:assert/strict';
import test from 'node:test';
import { recoverSelectionForApp } from './selection-recovery.js';

test('auto mode keeps helper text without copy recovery', async () => {
  const result = await recoverSelectionForApp({
    helperText: 'helper text',
    helperStrategy: 'uia',
    diagnostics: {},
    processName: 'reader.exe',
    processPath: 'C:\\Apps\\Reader\\reader.exe',
    hasRecentMouseAnchor: true,
    selectionConfig: {
      copy_fallback_enabled: true,
      copy_app_rules: []
    },
    selectionService: {
      readClipboardSelection: async () => {
        throw new Error('should not run');
      }
    }
  });

  assert.equal(result.ok, true);
  assert.equal(result.text, 'helper text');
  assert.equal(result.finalTextSource, 'helper');
});

test('force_copy prefers clipboard result and falls back to helper text', async () => {
  const clipboardFirst = await recoverSelectionForApp({
    helperText: 'helper text',
    helperStrategy: 'uia',
    diagnostics: {},
    processName: 'reader.exe',
    processPath: 'C:\\Apps\\Reader\\reader.exe',
    selectionConfig: {
      copy_fallback_enabled: true,
      copy_app_rules: [
        {
          id: 'rule-a',
          enabled: true,
          mode: 'force_copy',
          exe_path: 'C:\\Apps\\Reader\\reader.exe'
        }
      ]
    },
    selectionService: {
      readClipboardSelection: async () => ({
        ok: true,
        text: 'clipboard text',
        strategy: 'force-copy-recovery'
      })
    }
  });

  const helperFallback = await recoverSelectionForApp({
    helperText: 'helper text',
    helperStrategy: 'uia',
    diagnostics: {},
    processName: 'reader.exe',
    processPath: 'C:\\Apps\\Reader\\reader.exe',
    selectionConfig: {
      copy_fallback_enabled: true,
      copy_app_rules: [
        {
          id: 'rule-a',
          enabled: true,
          mode: 'force_copy',
          exe_path: 'C:\\Apps\\Reader\\reader.exe'
        }
      ]
    },
    selectionService: {
      readClipboardSelection: async () => ({
        ok: false,
        text: '',
        strategy: 'force-copy-recovery'
      })
    }
  });

  assert.equal(clipboardFirst.text, 'clipboard text');
  assert.equal(clipboardFirst.finalTextSource, 'clipboard');
  assert.equal(helperFallback.text, 'helper text');
  assert.equal(helperFallback.finalTextSource, 'helper');
});

test('skip_copy never triggers clipboard recovery', async () => {
  const result = await recoverSelectionForApp({
    helperText: '',
    diagnostics: {
      lastError: 'empty'
    },
    processName: 'locked.exe',
    processPath: 'C:\\Apps\\Locked\\locked.exe',
    selectionConfig: {
      copy_fallback_enabled: true,
      copy_app_rules: [
        {
          id: 'rule-a',
          enabled: true,
          mode: 'skip_copy',
          exe_path: 'C:\\Apps\\Locked\\locked.exe'
        }
      ]
    },
    selectionService: {
      readClipboardSelection: async () => {
        throw new Error('should not run');
      }
    }
  });

  assert.equal(result.ok, false);
  assert.equal(result.effectiveMode, 'skip_copy');
});

test('auto mode uses VS Code recovery before generic clipboard fallback when helper text is empty', async () => {
  const result = await recoverSelectionForApp({
    helperText: '',
    diagnostics: {
      lastReason: 'mouse-drag'
    },
    processName: 'code.exe',
    processPath: 'C:\\Apps\\Code\\Code.exe',
    hasRecentMouseAnchor: true,
    selectionConfig: {
      copy_fallback_enabled: true,
      copy_app_rules: []
    },
    selectionService: {
      readClipboardSelection: async () => ({
        ok: false,
        text: '',
        strategy: 'clipboard-fallback'
      })
    },
    vsCodeRecoveryService: {
      recover: async () => ({
        ok: true,
        text: 'vscode text',
        strategy: 'vscode-editor-copy-recovery'
      })
    }
  });

  assert.equal(result.ok, true);
  assert.equal(result.text, 'vscode text');
  assert.equal(result.finalSelectionStrategy, 'vscode-editor-copy-recovery');
});
