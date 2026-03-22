import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildSelectionForegroundContext,
  createInternalFocusDismissHandler,
  shouldSkipSelectionRecovery
} from './selection-foreground-guard.js';

test('allows popup when helper source and current foreground are the same process', () => {
  const result = buildSelectionForegroundContext({
    diagnostics: {
      sourceProcessId: 4321,
      processName: 'Code.exe',
      processPath: 'C:\\Apps\\Code\\Code.exe',
      windowTitle: 'Source Window'
    },
    foregroundWindow: {
      title: 'Current Window',
      owner: {
        processId: 4321,
        name: 'code',
        path: 'c:/apps/code/code.exe'
      }
    },
    appProcessId: 9999
  });

  assert.equal(result.allowPopup, true);
  assert.equal(result.sourceProcessId, 4321);
  assert.equal(result.sourceProcessName, 'code.exe');
  assert.equal(result.currentProcessPath, 'c:\\apps\\code\\code.exe');
});

test('rejects popup when helper source pid and current foreground pid differ', () => {
  const result = buildSelectionForegroundContext({
    diagnostics: {
      sourceProcessId: 4321,
      processName: 'code.exe',
      processPath: 'C:\\Apps\\Code\\Code.exe'
    },
    foregroundWindow: {
      title: 'Code',
      owner: {
        processId: 9876,
        name: 'code.exe',
        path: 'C:\\Apps\\Code\\Code.exe'
      }
    },
    appProcessId: 999
  });

  assert.equal(result.allowPopup, false);
  assert.equal(result.rejectionCode, 'foreground-switched');
});

test('rejects popup when foreground switches to SelectPop itself', () => {
  const result = buildSelectionForegroundContext({
    diagnostics: {
      processName: 'reader.exe',
      processPath: 'C:\\Apps\\Reader\\reader.exe'
    },
    foregroundWindow: {
      title: 'SelectPop',
      owner: {
        processId: 777,
        name: 'selectpop.exe',
        path: 'C:\\Apps\\SelectPop\\selectpop.exe'
      }
    },
    appProcessId: 777
  });

  assert.equal(result.allowPopup, false);
  assert.equal(result.rejectionCode, 'self-foreground');
});

test('rejects popup when foreground switches to a different process', () => {
  const result = buildSelectionForegroundContext({
    diagnostics: {
      processName: 'reader.exe',
      processPath: 'C:\\Apps\\Reader\\reader.exe'
    },
    foregroundWindow: {
      title: 'Chrome',
      owner: {
        processId: 123,
        name: 'chrome.exe',
        path: 'C:\\Apps\\Chrome\\chrome.exe'
      }
    },
    appProcessId: 999
  });

  assert.equal(result.allowPopup, false);
  assert.equal(result.rejectionCode, 'foreground-switched');
});

test('skips recovery for blacklist-style helper failures but not for empty selection errors', () => {
  assert.equal(shouldSkipSelectionRecovery({
    lastError: 'Process is blacklisted.'
  }), true);
  assert.equal(shouldSkipSelectionRecovery({
    blockedRiskCategory: 'games'
  }), true);
  assert.equal(shouldSkipSelectionRecovery({
    lastError: 'No readable selection text was found.'
  }), false);
});

test('internal focus dismiss handler invalidates popup flow and hides popup', () => {
  const calls = [];
  const dismiss = createInternalFocusDismissHandler({
    popupManager: {
      hide() {
        calls.push('hide');
      }
    },
    selectionPopupController: {
      invalidate() {
        calls.push('invalidate');
      }
    }
  });

  dismiss('settings-window-focus');

  assert.deepEqual(calls, ['invalidate', 'hide']);
});
