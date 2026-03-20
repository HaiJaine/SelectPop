function normalizeSelectionTextForFingerprint(value) {
  return String(value || '')
    .replaceAll('\u0000', '')
    .replace(/\r\n/g, '\n')
    .trim();
}

export function buildSelectionPopupFingerprint({
  diagnostics = {},
  selectedText = '',
  processName = '',
  processPath = ''
} = {}) {
  const normalizedText = normalizeSelectionTextForFingerprint(selectedText);

  if (!normalizedText) {
    return '';
  }

  const normalizedProcessName = String(processName || diagnostics?.processName || '').trim().toLowerCase();
  const normalizedProcessPath = String(processPath || diagnostics?.processPath || '').trim().toLowerCase();
  const triggerAt = Number.isFinite(Number(diagnostics?.lastTriggerAt)) ? Number(diagnostics.lastTriggerAt) : 0;
  const reason = String(diagnostics?.lastReason || '').trim().toLowerCase();

  return [
    normalizedProcessName,
    normalizedProcessPath,
    reason,
    triggerAt,
    normalizedText
  ].join('\u001f');
}

export function createSelectionPopupController({
  dedupeWindowMs = 800,
  now = () => Date.now()
} = {}) {
  let generation = 0;
  let lastShownFingerprint = '';
  let lastShownAt = 0;

  function invalidate() {
    generation += 1;
    lastShownFingerprint = '';
    lastShownAt = 0;
    return generation;
  }

  function beginFlow() {
    generation += 1;
    return generation;
  }

  function isCurrent(flowId) {
    return flowId === generation;
  }

  function shouldShow({ flowId, fingerprint = '' } = {}) {
    if (!isCurrent(flowId)) {
      return false;
    }

    if (!fingerprint) {
      return true;
    }

    return !(lastShownFingerprint === fingerprint && now() - lastShownAt <= dedupeWindowMs);
  }

  function markShown(fingerprint = '') {
    if (!fingerprint) {
      return;
    }

    lastShownFingerprint = fingerprint;
    lastShownAt = now();
  }

  return {
    beginFlow,
    invalidate,
    isCurrent,
    shouldShow,
    markShown
  };
}
