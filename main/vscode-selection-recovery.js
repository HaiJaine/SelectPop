import { VSCODE_READ_SELECTION_TIMEOUT_MS } from './selection-service.js';

const VSCODE_RECOVERY_PROCESSES = new Set(['code.exe', 'cursor.exe']);

export function isVsCodeRecoveryProcess(processName) {
  return VSCODE_RECOVERY_PROCESSES.has(String(processName || '').trim().toLowerCase());
}

function createRecoveryResult(overrides = {}) {
  return {
    ok: false,
    text: '',
    strategy: 'vscode-recovery-failed',
    focusKind: 'unknown',
    shouldShowPopup: false,
    failureReason: 'VS Code selection recovery failed.',
    attempts: [],
    ...overrides
  };
}

function summarizeFailureReason(attempts = []) {
  const failedAttempts = attempts.filter((attempt) => !attempt?.ok);

  if (!failedAttempts.length) {
    return 'VS Code selection recovery failed.';
  }

  return failedAttempts
    .map((attempt) => `${attempt.step}: ${attempt.error || 'empty selection'}`)
    .join(' | ');
}

export class VsCodeSelectionRecoveryService {
  constructor({
    selectionService,
    sendTerminalCopyShortcut,
    sendEditorCopyShortcut,
    logger = console,
    scriptTimeoutMs = VSCODE_READ_SELECTION_TIMEOUT_MS,
    waitForForegroundRecovery = async () => true
  } = {}) {
    this.selectionService = selectionService;
    this.sendTerminalCopyShortcut = sendTerminalCopyShortcut;
    this.sendEditorCopyShortcut = sendEditorCopyShortcut;
    this.logger = logger;
    this.scriptTimeoutMs = scriptTimeoutMs;
    this.waitForForegroundRecovery = waitForForegroundRecovery;
  }

  shouldRecover({ processName = '', lastReason = '', hasRecentMouseAnchor = false } = {}) {
    return isVsCodeRecoveryProcess(processName)
      && String(lastReason || '').startsWith('mouse-')
      && hasRecentMouseAnchor === true;
  }

  async recover({
    processName = '',
    lastReason = '',
    hasRecentMouseAnchor = false,
    allowCopyRecovery = true
  } = {}) {
    if (!this.shouldRecover({
      processName,
      lastReason,
      hasRecentMouseAnchor
    })) {
      return createRecoveryResult({
        failureReason: 'Recovery preconditions were not met.'
      });
    }

    const attempts = [];

    const scriptResult = await this.selectionService.readScriptSelection({
      scriptMode: 'uia',
      scriptTimeoutMs: this.scriptTimeoutMs
    });
    attempts.push({
      step: 'uia',
      ok: scriptResult.ok,
      strategy: scriptResult.strategy,
      focusKind: scriptResult.focusKind,
      error: scriptResult.error
    });

    if (scriptResult.ok) {
      this.logger?.info?.('VS Code selection recovered via UIA-only path.', {
        processName,
        focusKind: scriptResult.focusKind,
        textLength: scriptResult.text.length
      });
      return createRecoveryResult({
        ok: true,
        text: scriptResult.text,
        strategy: 'vscode-uia-recovery',
        focusKind: scriptResult.focusKind || 'unknown',
        shouldShowPopup: true,
        failureReason: '',
        attempts
      });
    }

    if (allowCopyRecovery !== true) {
      const failureReason = summarizeFailureReason(attempts);
      return createRecoveryResult({
        ok: false,
        text: '',
        strategy: 'vscode-recovery-failed',
        focusKind: scriptResult.focusKind || 'unknown',
        shouldShowPopup: false,
        failureReason,
        attempts
      });
    }

    const clipboardReadOptions = {
      afterSendCopyShortcut: async () => {
        await this.waitForForegroundRecovery();
      }
    };
    const copyAttempts = [];

    if (scriptResult.focusKind === 'terminal') {
      copyAttempts.push({
        step: 'terminal-copy',
        strategy: 'vscode-terminal-copy-recovery',
        sendCopyShortcut: this.sendTerminalCopyShortcut,
        copyKeys: ['ctrl', 'shift', 'c'],
        focusKind: scriptResult.focusKind,
        emptyError: 'VS Code Ctrl+Shift+C did not produce clipboard text.'
      });
    } else if (scriptResult.focusKind === 'editor') {
      copyAttempts.push({
        step: 'editor-copy',
        strategy: 'vscode-editor-copy-recovery',
        sendCopyShortcut: this.sendEditorCopyShortcut,
        copyKeys: ['ctrl', 'c'],
        focusKind: 'editor',
        emptyError: 'VS Code Ctrl+C did not produce clipboard text.'
      });
    } else {
      copyAttempts.push({
        step: 'terminal-copy',
        strategy: 'vscode-terminal-copy-recovery',
        sendCopyShortcut: this.sendTerminalCopyShortcut,
        copyKeys: ['ctrl', 'shift', 'c'],
        focusKind: scriptResult.focusKind,
        emptyError: 'VS Code Ctrl+Shift+C did not produce clipboard text.'
      });
      copyAttempts.push({
        step: 'editor-copy',
        strategy: 'vscode-editor-copy-recovery',
        sendCopyShortcut: this.sendEditorCopyShortcut,
        copyKeys: ['ctrl', 'c'],
        focusKind: 'editor',
        emptyError: 'VS Code Ctrl+C did not produce clipboard text.'
      });
    }

    for (const copyAttempt of copyAttempts) {
      const copyResult = await this.selectionService.readClipboardSelection({
        sendCopyShortcut: copyAttempt.sendCopyShortcut,
        strategy: copyAttempt.strategy,
        focusKind: copyAttempt.focusKind,
        emptyError: copyAttempt.emptyError,
        clipboardReadOptions: {
          ...clipboardReadOptions,
          copyKeys: copyAttempt.copyKeys
        }
      });
      attempts.push({
        step: copyAttempt.step,
        ok: copyResult.ok,
        strategy: copyResult.strategy,
        focusKind: copyResult.focusKind,
        error: copyResult.error
      });

      if (!copyResult.ok) {
        continue;
      }

      this.logger?.info?.(
        copyAttempt.strategy === 'vscode-terminal-copy-recovery'
          ? 'VS Code selection recovered via Ctrl+Shift+C.'
          : 'VS Code selection recovered via Ctrl+C editor path.',
        {
          processName,
          focusKind: copyResult.focusKind || copyAttempt.focusKind || scriptResult.focusKind || 'unknown',
          textLength: copyResult.text.length
        }
      );
      return createRecoveryResult({
        ok: true,
        text: copyResult.text,
        strategy: copyAttempt.strategy,
        focusKind: copyResult.focusKind || copyAttempt.focusKind || scriptResult.focusKind || 'unknown',
        shouldShowPopup: true,
        failureReason: '',
        attempts
      });
    }

    const failureReason = summarizeFailureReason(attempts);
    this.logger?.warn?.('VS Code selection recovery failed.', {
      processName,
      focusKind: scriptResult.focusKind || 'unknown',
      failureReason
    });
    return createRecoveryResult({
      ok: false,
      text: '',
      strategy: 'vscode-recovery-failed',
      focusKind: scriptResult.focusKind || 'unknown',
      shouldShowPopup: false,
      failureReason,
      attempts
    });
  }
}
