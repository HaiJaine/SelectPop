import path from 'node:path';
import { canonicalizeProcessName } from '../shared/process-name.js';

export const COPY_APP_RULE_MODES = ['auto', 'force_shortcut_copy', 'skip_copy'];
export const COPY_APP_RULE_SOURCES = ['installed', 'manual'];
const COPY_APP_RULE_MODE_ALIASES = new Map([
  ['force_copy', 'force_shortcut_copy'],
  ['force_command_copy', 'force_shortcut_copy'],
  ['skip_command_copy', 'skip_copy']
]);
const BUILTIN_COPY_APP_RULES = Object.freeze([
  {
    id: 'builtin-code',
    enabled: true,
    mode: 'force_shortcut_copy',
    process_name: 'code.exe'
  },
  {
    id: 'builtin-cursor',
    enabled: true,
    mode: 'force_shortcut_copy',
    process_name: 'cursor.exe'
  },
  {
    id: 'builtin-idea64',
    enabled: true,
    mode: 'skip_copy',
    process_name: 'idea64.exe'
  },
  {
    id: 'builtin-webstorm64',
    enabled: true,
    mode: 'skip_copy',
    process_name: 'webstorm64.exe'
  },
  {
    id: 'builtin-pycharm64',
    enabled: true,
    mode: 'skip_copy',
    process_name: 'pycharm64.exe'
  },
  {
    id: 'builtin-clion64',
    enabled: true,
    mode: 'skip_copy',
    process_name: 'clion64.exe'
  },
  {
    id: 'builtin-goland64',
    enabled: true,
    mode: 'skip_copy',
    process_name: 'goland64.exe'
  },
  {
    id: 'builtin-rider64',
    enabled: true,
    mode: 'skip_copy',
    process_name: 'rider64.exe'
  },
  {
    id: 'builtin-rubymine64',
    enabled: true,
    mode: 'skip_copy',
    process_name: 'rubymine64.exe'
  },
  {
    id: 'builtin-phpstorm64',
    enabled: true,
    mode: 'skip_copy',
    process_name: 'phpstorm64.exe'
  },
  {
    id: 'builtin-datagrip64',
    enabled: true,
    mode: 'skip_copy',
    process_name: 'datagrip64.exe'
  },
  {
    id: 'builtin-studio64',
    enabled: true,
    mode: 'skip_copy',
    process_name: 'studio64.exe'
  },
  {
    id: 'builtin-rustrover64',
    enabled: true,
    mode: 'skip_copy',
    process_name: 'rustrover64.exe'
  }
]);

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
  const normalizedValue = canonicalizeProcessName(value);

  if (normalizedValue) {
    return normalizedValue;
  }

  return inferProcessNameFromExePath(fallbackExePath);
}

export function normalizeCopyAppRuleMode(value) {
  const normalizedValue = COPY_APP_RULE_MODE_ALIASES.get(value) || value;
  return COPY_APP_RULE_MODES.includes(normalizedValue) ? normalizedValue : 'auto';
}

export function normalizeCopyAppRuleSource(value) {
  return COPY_APP_RULE_SOURCES.includes(value) ? value : 'manual';
}

export function resolveCopyAppRule(rules = [], processPath = '', processName = '') {
  const normalizedPath = normalizeExePath(processPath);
  const normalizedProcessName = normalizeProcessName(processName, processPath);

  if (normalizedPath) {
    const matchedByPath = rules.find((rule) => (
      rule.enabled !== false
      && normalizeExePath(rule.exe_path) === normalizedPath
    ));

    if (matchedByPath) {
      return matchedByPath;
    }
  }

  if (!normalizedProcessName) {
    return null;
  }

  return rules.find((rule) => (
    rule.enabled !== false
    && normalizeProcessName(rule.process_name, rule.exe_path) === normalizedProcessName
  )) || null;
}

function normalizeRule(rule = {}) {
  return {
    ...rule,
    enabled: rule?.enabled !== false,
    mode: normalizeCopyAppRuleMode(rule?.mode),
    exe_path: normalizeExePath(rule?.exe_path || ''),
    process_name: normalizeProcessName(rule?.process_name || '', rule?.exe_path || '')
  };
}

export function getBuiltinCopyAppRules() {
  return BUILTIN_COPY_APP_RULES.map((rule) => normalizeRule(rule));
}

export function getEffectiveCopyAppRules(rules = []) {
  const normalizedRules = (Array.isArray(rules) ? rules : []).map((rule) => normalizeRule(rule));
  const explicitPathOverrides = new Set(
    normalizedRules
      .map((rule) => rule.exe_path)
      .filter(Boolean)
  );
  const explicitProcessOverrides = new Set(
    normalizedRules
      .map((rule) => rule.process_name)
      .filter(Boolean)
  );

  const builtinRules = getBuiltinCopyAppRules().filter((rule) => {
    if (rule.exe_path && explicitPathOverrides.has(rule.exe_path)) {
      return false;
    }

    if (rule.process_name && explicitProcessOverrides.has(rule.process_name)) {
      return false;
    }

    return true;
  });

  return [...normalizedRules, ...builtinRules];
}

export function buildCopyRuleMatcherPayload(rules = []) {
  const payload = {
    force_shortcut_copy_exe_paths: [],
    skip_copy_exe_paths: [],
    force_shortcut_copy_processes: [],
    skip_copy_processes: []
  };
  const effectiveRules = getEffectiveCopyAppRules(rules);

  for (const rule of effectiveRules) {
    if (rule.enabled === false || rule.mode === 'auto') {
      continue;
    }

    const pathBucket = rule.mode === 'force_shortcut_copy'
      ? payload.force_shortcut_copy_exe_paths
      : payload.skip_copy_exe_paths;
    const processBucket = rule.mode === 'force_shortcut_copy'
      ? payload.force_shortcut_copy_processes
      : payload.skip_copy_processes;

    if (rule.exe_path && !pathBucket.includes(rule.exe_path)) {
      pathBucket.push(rule.exe_path);
    }

    if (rule.process_name && !processBucket.includes(rule.process_name)) {
      processBucket.push(rule.process_name);
    }
  }

  return payload;
}

export function resolveCopyBehavior({ rules = [], processPath = '', processName = '', copyFallbackEnabled = true } = {}) {
  const matchedRule = resolveCopyAppRule(getEffectiveCopyAppRules(rules), processPath, processName);
  const requestedMode = normalizeCopyAppRuleMode(matchedRule?.mode || 'auto');
  const effectiveMode = requestedMode === 'auto' && copyFallbackEnabled !== true
    ? 'skip_copy'
    : requestedMode;

  return {
    matchedRule,
    requestedMode,
    effectiveMode,
    copyAllowed: effectiveMode === 'force_shortcut_copy' || (copyFallbackEnabled === true && effectiveMode !== 'skip_copy')
  };
}
