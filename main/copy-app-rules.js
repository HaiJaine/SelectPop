import path from 'node:path';

export const COPY_APP_RULE_MODES = ['auto', 'force_copy', 'skip_copy'];
export const COPY_APP_RULE_SOURCES = ['installed', 'manual'];

function stripWrappingQuotes(value) {
  const text = String(value || '').trim();
  return text.replace(/^"(.*)"$/u, '$1');
}

export function canonicalizeExePath(value) {
  const rawValue = stripWrappingQuotes(value).replaceAll('/', '\\');

  if (!rawValue) {
    return '';
  }

  return path.win32.normalize(rawValue);
}

export function normalizeExePath(value) {
  const canonicalPath = canonicalizeExePath(value);

  if (!canonicalPath) {
    return '';
  }

  return canonicalPath.toLowerCase();
}

export function inferProcessNameFromExePath(exePath) {
  const normalizedPath = normalizeExePath(exePath);

  if (!normalizedPath) {
    return '';
  }

  return path.win32.basename(normalizedPath).toLowerCase();
}

export function normalizeProcessName(value, fallbackExePath = '') {
  const normalizedValue = String(value || '').trim().toLowerCase();

  if (normalizedValue) {
    return normalizedValue;
  }

  return inferProcessNameFromExePath(fallbackExePath);
}

export function normalizeCopyAppRuleMode(value) {
  return COPY_APP_RULE_MODES.includes(value) ? value : 'auto';
}

export function normalizeCopyAppRuleSource(value) {
  return COPY_APP_RULE_SOURCES.includes(value) ? value : 'manual';
}

export function resolveCopyAppRule(rules = [], processPath = '') {
  const normalizedPath = normalizeExePath(processPath);

  if (!normalizedPath) {
    return null;
  }

  return rules.find((rule) => rule.enabled !== false && normalizeExePath(rule.exe_path) === normalizedPath) || null;
}

export function resolveCopyBehavior({ rules = [], processPath = '', copyFallbackEnabled = true } = {}) {
  const matchedRule = resolveCopyAppRule(rules, processPath);
  const requestedMode = normalizeCopyAppRuleMode(matchedRule?.mode || 'auto');
  const effectiveMode =
    requestedMode === 'force_copy' && copyFallbackEnabled !== true
      ? 'skip_copy'
      : requestedMode;

  return {
    matchedRule,
    requestedMode,
    effectiveMode,
    copyAllowed: copyFallbackEnabled === true && effectiveMode !== 'skip_copy'
  };
}
