import { resolveCopyBehavior } from './copy-app-rules.js';
import { isVsCodeRecoveryProcess } from './vscode-selection-recovery.js';

function sanitizeSelectedText(value) {
  return String(value || '')
    .replaceAll('\u0000', '')
    .replace(/\r\n/g, '\n')
    .trim();
}

function createRecoveryResult(overrides = {}) {
  return {
    ok: false,
    text: '',
    finalSelectionStrategy: '',
    finalTextSource: 'none',
    requestedMode: 'auto',
    effectiveMode: 'auto',
    matchedRule: null,
    processPath: '',
    processName: '',
    error: '',
    ...overrides
  };
}

export async function recoverSelectionForApp({
  helperText = '',
  helperStrategy = '',
  diagnostics = {},
  processName = '',
  processPath = '',
  hasRecentMouseAnchor = false,
  selectionConfig = {},
  selectionService,
  vsCodeRecoveryService
} = {}) {
  const normalizedHelperText = sanitizeSelectedText(helperText);
  const behavior = resolveCopyBehavior({
    rules: selectionConfig?.copy_app_rules || [],
    processPath,
    copyFallbackEnabled: selectionConfig?.copy_fallback_enabled === true
  });

  const baseResult = {
    requestedMode: behavior.requestedMode,
    effectiveMode: behavior.effectiveMode,
    matchedRule: behavior.matchedRule,
    processPath,
    processName
  };

  if (behavior.effectiveMode === 'skip_copy') {
    if (normalizedHelperText) {
      return createRecoveryResult({
        ...baseResult,
        ok: true,
        text: normalizedHelperText,
        finalSelectionStrategy: helperStrategy || diagnostics?.lastStrategy || 'helper-selection',
        finalTextSource: 'helper'
      });
    }

    return createRecoveryResult({
      ...baseResult,
      error: diagnostics?.lastError || '当前软件已配置为禁止 Ctrl+C，且原始取词结果为空。'
    });
  }

  if (behavior.effectiveMode === 'auto' && normalizedHelperText) {
    return createRecoveryResult({
      ...baseResult,
      ok: true,
      text: normalizedHelperText,
      finalSelectionStrategy: helperStrategy || diagnostics?.lastStrategy || 'helper-selection',
      finalTextSource: 'helper'
    });
  }

  const allowCopyRecovery = behavior.copyAllowed === true;
  const shouldTryVsCodeRecovery =
    isVsCodeRecoveryProcess(processName)
    && hasRecentMouseAnchor === true
    && typeof vsCodeRecoveryService?.recover === 'function';

  if (shouldTryVsCodeRecovery) {
    const vscodeResult = await vsCodeRecoveryService.recover({
      processName,
      lastReason: diagnostics?.lastReason || '',
      hasRecentMouseAnchor,
      allowCopyRecovery
    });

    if (vscodeResult?.ok) {
      return createRecoveryResult({
        ...baseResult,
        ok: true,
        text: sanitizeSelectedText(vscodeResult.text),
        finalSelectionStrategy: vscodeResult.strategy || 'vscode-recovery',
        finalTextSource: 'clipboard'
      });
    }
  }

  if (allowCopyRecovery && typeof selectionService?.readClipboardSelection === 'function') {
    const clipboardResult = await selectionService.readClipboardSelection({
      strategy: behavior.effectiveMode === 'force_copy' ? 'force-copy-recovery' : 'clipboard-fallback',
      focusKind: 'unknown',
      emptyError:
        behavior.effectiveMode === 'force_copy'
          ? '强制 Ctrl+C 取词没有返回可用文本。'
          : 'Copy fallback 没有返回可用文本。'
    });

    if (clipboardResult?.ok) {
      return createRecoveryResult({
        ...baseResult,
        ok: true,
        text: sanitizeSelectedText(clipboardResult.text),
        finalSelectionStrategy: clipboardResult.strategy || 'clipboard-fallback',
        finalTextSource: 'clipboard'
      });
    }
  }

  if (normalizedHelperText) {
    return createRecoveryResult({
      ...baseResult,
      ok: true,
      text: normalizedHelperText,
      finalSelectionStrategy: helperStrategy || diagnostics?.lastStrategy || 'helper-selection',
      finalTextSource: 'helper'
    });
  }

  return createRecoveryResult({
    ...baseResult,
    error: diagnostics?.lastError || '没有可用的选中文本。'
  });
}
