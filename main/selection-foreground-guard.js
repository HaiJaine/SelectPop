import { canonicalizeProcessName } from '../shared/process-name.js';
import { normalizeExePath } from './copy-app-rules.js';

const TERMINAL_SELECTION_FAILURE_REASONS = new Set([
  'Selection is disabled.',
  'No foreground window.',
  'Foreground window belongs to SelectPop.',
  'Process is not in whitelist.',
  'Process is blacklisted.'
]);

function normalizeWindowTitle(value) {
  return String(value || '').trim();
}

export function buildSelectionForegroundContext({
  diagnostics = {},
  foregroundWindow = null,
  appProcessId = 0
} = {}) {
  const sourceProcessId = Number(diagnostics?.sourceProcessId || 0);
  const sourceProcessName = canonicalizeProcessName(diagnostics?.processName || '');
  const sourceProcessPath = normalizeExePath(diagnostics?.processPath || '');
  const sourceWindowTitle = normalizeWindowTitle(diagnostics?.windowTitle || '');

  const currentProcessId = Number(foregroundWindow?.owner?.processId || 0);
  const currentProcessName = canonicalizeProcessName(foregroundWindow?.owner?.name || '');
  const currentProcessPath = normalizeExePath(foregroundWindow?.owner?.path || '');
  const currentWindowTitle = normalizeWindowTitle(foregroundWindow?.title || '');

  let allowPopup = true;
  let rejectionCode = '';
  let rejectionReason = '';

  if (appProcessId > 0 && currentProcessId === appProcessId) {
    allowPopup = false;
    rejectionCode = 'self-foreground';
    rejectionReason = 'Foreground switched to SelectPop before popup could be shown.';
  } else if (sourceProcessId > 0 && currentProcessId > 0 && sourceProcessId !== currentProcessId) {
    allowPopup = false;
    rejectionCode = 'foreground-switched';
    rejectionReason = 'Foreground process changed before popup could be shown.';
  } else if (sourceProcessPath && currentProcessPath && sourceProcessPath !== currentProcessPath) {
    allowPopup = false;
    rejectionCode = 'foreground-switched';
    rejectionReason = 'Foreground process changed before popup could be shown.';
  } else if (sourceProcessName && currentProcessName && sourceProcessName !== currentProcessName) {
    allowPopup = false;
    rejectionCode = 'foreground-switched';
    rejectionReason = 'Foreground process changed before popup could be shown.';
  }

  return {
    allowPopup,
    rejectionCode,
    rejectionReason,
    sourceProcessId,
    sourceProcessName,
    sourceProcessPath,
    sourceWindowTitle,
    currentProcessId,
    currentProcessName,
    currentProcessPath,
    currentWindowTitle
  };
}

export function shouldSkipSelectionRecovery(diagnostics = {}) {
  return (
    Boolean(String(diagnostics?.blockedRiskCategory || '').trim())
    || TERMINAL_SELECTION_FAILURE_REASONS.has(String(diagnostics?.lastError || '').trim())
  );
}

export function createInternalFocusDismissHandler({
  popupManager,
  selectionPopupController,
  logger = null
} = {}) {
  return (reason = 'selectpop-focus') => {
    selectionPopupController?.invalidate?.();
    popupManager?.hide?.();
    logger?.info?.('Dismissed popup because a SelectPop window took focus.', {
      reason
    });
  };
}
