export const TOOL_ICON_PRESET_IDS = ['copy', 'keyboard', 'search', 'translate'];
export const INTERNAL_ICON_PRESET_IDS = ['grip-horizontal', 'placeholder'];
export const ICON_PRESET_IDS = [...TOOL_ICON_PRESET_IDS, ...INTERNAL_ICON_PRESET_IDS];
export const ICON_NAME_PATTERN = /^[a-z0-9-]+$/u;

export const TOOL_TYPE_DEFAULT_ICONS = {
  copy: 'copy',
  hotkey: 'keyboard',
  url: 'search',
  ai: 'translate'
};

const LEGACY_BUILTIN_ICON_ALIASES = {
  clipboard: 'copy',
  'clipboard-copy': 'copy',
  'copy-plus': 'copy',
  command: 'keyboard',
  'search-check': 'search',
  'search-code': 'search',
  languages: 'translate',
  language: 'translate',
  'languages-square': 'translate',
  'link-2': 'link',
  'external-link': 'link',
  sparkles: 'bolt',
  zap: 'bolt',
  'wand-sparkles': 'bolt',
  pencil: 'edit',
  pen: 'edit',
  'square-pen': 'edit'
};

const COMMON_LUCIDE_ICON_NAMES = [
  'arrow-right',
  'badge-help',
  'book-open',
  'bookmark',
  'bot',
  'brain',
  'calendar',
  'check',
  'check-check',
  'chevron-right',
  'circle-help',
  'clipboard',
  'clock-3',
  'code-2',
  'command',
  'download',
  'external-link',
  'file-code-2',
  'file-search',
  'files',
  'globe',
  'grip-horizontal',
  'highlighter',
  'keyboard',
  'languages',
  'link',
  'link-2',
  'list',
  'message-square',
  'mouse-pointer-click',
  'notebook-pen',
  'pen',
  'pencil',
  'search',
  'search-code',
  'send',
  'sparkles',
  'square-pen',
  'star',
  'terminal',
  'text-cursor-input',
  'translate',
  'wand-sparkles',
  'zap'
];

export const ICON_NAME_OPTIONS = Array.from(
  new Set([...TOOL_ICON_PRESET_IDS, ...COMMON_LUCIDE_ICON_NAMES, ...Object.keys(LEGACY_BUILTIN_ICON_ALIASES)])
).sort((left, right) => left.localeCompare(right));

export function normalizeIconName(iconName) {
  return String(iconName || '')
    .trim()
    .toLowerCase();
}

export function isValidIconName(iconName) {
  const normalized = normalizeIconName(iconName);
  return normalized ? ICON_NAME_PATTERN.test(normalized) : false;
}

export function isBuiltinIconName(iconName) {
  return ICON_PRESET_IDS.includes(normalizeIconName(iconName));
}

export function resolveBuiltinFallbackIconName(iconName) {
  const normalized = normalizeIconName(iconName);

  if (isBuiltinIconName(normalized)) {
    return normalized;
  }

  return 'placeholder';
}

export function resolveIconAssetName(iconName) {
  return resolveBuiltinFallbackIconName(iconName);
}
