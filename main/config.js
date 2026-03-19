import Store from 'electron-store';
import {
  AI_SYSTEM_PROMPT,
  BUILTIN_COPY_TOOL_ID,
  CONFIG_VERSION,
  HARD_DISABLED_CATEGORIES,
  SUPPORTED_BROWSERS,
  SUPPORTED_PROXY_MODES,
  SUPPORTED_PROXY_TYPES,
  SUPPORTED_SELECTION_MODES,
  SUPPORTED_WEBDAV_CONFLICT_POLICIES,
  SUPPORTED_WEBDAV_SYNC_MODES,
  SUPPORTED_TOOL_TYPES,
  DEFAULT_WEBDAV_BACKUP_RETENTION,
  createDefaultConfig
} from './defaults.js';
import { TOOL_TYPE_DEFAULT_ICONS, normalizeIconName } from '../shared/icons.js';
import { deriveUrlToolFaviconMeta } from '../shared/url-tool.js';
import { coerceArray, createId, deepClone } from './utils.js';

let store;

function normalizeCopyTool(tool = {}) {
  return {
    id: BUILTIN_COPY_TOOL_ID,
    type: 'copy',
    name: String(tool.name || '复制'),
    icon: normalizeIconName(tool.icon) || TOOL_TYPE_DEFAULT_ICONS.copy,
    enabled: tool.enabled !== false,
    copy_before_action: false
  };
}

function normalizeHotkeyTool(tool = {}) {
  const keys = coerceArray(tool.keys)
    .map((key) => String(key).trim().toLowerCase())
    .filter(Boolean);

  return {
    id: String(tool.id || createId('tool')),
    type: 'hotkey',
    name: String(tool.name || '快捷键'),
    icon: normalizeIconName(tool.icon) || TOOL_TYPE_DEFAULT_ICONS.hotkey,
    enabled: tool.enabled !== false,
    keys,
    copy_before_action: tool.copy_before_action === true
  };
}

function normalizeUrlToolFavicon(template, favicon) {
  const derived = deriveUrlToolFaviconMeta(template, favicon);

  if (!derived) {
    return null;
  }

  return {
    page_url: String(derived.page_url || ''),
    origin: String(derived.origin || ''),
    ...(derived.icon_url ? { icon_url: String(derived.icon_url) } : {})
  };
}

function normalizeUrlTool(tool = {}) {
  const browser = SUPPORTED_BROWSERS.includes(tool.browser) ? tool.browser : 'default';
  const template = String(tool.template || 'https://www.google.com/search?q={text_encoded}');
  const autoFetchFavicon = tool.auto_fetch_favicon !== false;

  return {
    id: String(tool.id || createId('tool')),
    type: 'url',
    name: String(tool.name || '搜索'),
    icon: normalizeIconName(tool.icon) || TOOL_TYPE_DEFAULT_ICONS.url,
    enabled: tool.enabled !== false,
    template,
    browser,
    auto_fetch_favicon: autoFetchFavicon,
    favicon: autoFetchFavicon ? normalizeUrlToolFavicon(template, tool.favicon) : null,
    copy_before_action: tool.copy_before_action === true
  };
}

function normalizeAiTool(tool = {}) {
  const providerIds = coerceArray(tool.provider_ids)
    .concat(typeof tool.provider_id === 'string' ? [tool.provider_id] : [])
    .map((value) => String(value || '').trim())
    .filter(Boolean);

  return {
    id: String(tool.id || createId('tool')),
    type: 'ai',
    name: String(tool.name || 'AI 翻译'),
    icon: normalizeIconName(tool.icon) || TOOL_TYPE_DEFAULT_ICONS.ai,
    enabled: tool.enabled !== false,
    provider_id: providerIds[0] || '',
    provider_ids: Array.from(new Set(providerIds)),
    copy_before_action: tool.copy_before_action === true,
    prompt: typeof tool.prompt === 'string' ? tool.prompt : ''
  };
}

function normalizeTool(tool = {}) {
  if (tool.id === BUILTIN_COPY_TOOL_ID || tool.type === 'copy') {
    return normalizeCopyTool(tool);
  }

  if (!SUPPORTED_TOOL_TYPES.includes(tool.type)) {
    return normalizeUrlTool(tool);
  }

  switch (tool.type) {
    case 'hotkey':
      return normalizeHotkeyTool(tool);
    case 'url':
      return normalizeUrlTool(tool);
    case 'ai':
      return normalizeAiTool(tool);
    default:
      return normalizeCopyTool(tool);
  }
}

function normalizeProxy(proxy, { allowInherit = false, fallbackMode = 'system' } = {}) {
  if (!proxy) {
    return { mode: fallbackMode };
  }

  if (typeof proxy.mode === 'string') {
    const supportedModes = allowInherit ? SUPPORTED_PROXY_MODES : SUPPORTED_PROXY_MODES.filter((mode) => mode !== 'inherit');
    const mode = supportedModes.includes(proxy.mode) ? proxy.mode : fallbackMode;

    if (mode !== 'custom') {
      return { mode };
    }

    const host = String(proxy.host || '').trim();
    const port = Number(proxy.port || 0);

    if (!host || !port) {
      return { mode: fallbackMode };
    }

    return {
      mode,
      type: SUPPORTED_PROXY_TYPES.includes(proxy.type) ? proxy.type : 'http',
      host,
      port
    };
  }

  if (proxy.enabled === true) {
    const host = String(proxy.host || '').trim();
    const port = Number(proxy.port || 0);

    if (!host || !port) {
      return { mode: fallbackMode };
    }

    return {
      mode: 'custom',
      type: SUPPORTED_PROXY_TYPES.includes(proxy.type) ? proxy.type : 'http',
      host,
      port
    };
  }

  if (proxy.enabled === false) {
    return { mode: 'none' };
  }

  return { mode: fallbackMode };
}

export function resolveProviderProxy(providerProxy, selectionProxy) {
  const normalizedSelectionProxy = normalizeProxy(selectionProxy, { fallbackMode: 'system' });
  const normalizedProviderProxy = normalizeProxy(providerProxy, { allowInherit: true, fallbackMode: 'inherit' });

  if (normalizedProviderProxy.mode === 'inherit') {
    return normalizedSelectionProxy;
  }

  return normalizedProviderProxy;
}

function normalizeRequestParams(requestParams) {
  if (!requestParams || typeof requestParams !== 'object' || Array.isArray(requestParams)) {
    return {};
  }

  return deepClone(requestParams);
}

function normalizeProvider(provider = {}) {
  return {
    id: String(provider.id || createId('provider')),
    name: String(provider.name || 'OpenAI Compatible'),
    provider: 'openai',
    base_url: String(provider.base_url || 'https://api.openai.com').trim().replace(/\/+$/, ''),
    api_key: String(provider.api_key || '').trim(),
    model: String(provider.model || 'gpt-4o').trim(),
    timeout_ms: Math.max(1_000, Number(provider.timeout_ms || 30_000)),
    proxy: normalizeProxy(provider.proxy, { allowInherit: true, fallbackMode: 'inherit' }),
    request_params: normalizeRequestParams(provider.request_params),
    prompt: String(provider.prompt || AI_SYSTEM_PROMPT).trim() || AI_SYSTEM_PROMPT
  };
}

function normalizeUi(ui = {}) {
  const defaults = createDefaultConfig().ui;
  const normalizeCoordinate = (value) => {
    const nextValue = Number(value);
    return Number.isFinite(nextValue) ? nextValue : undefined;
  };

  return {
    settingsBounds: {
      ...(normalizeCoordinate(ui?.settingsBounds?.x) !== undefined
        ? { x: normalizeCoordinate(ui?.settingsBounds?.x) }
        : {}),
      ...(normalizeCoordinate(ui?.settingsBounds?.y) !== undefined
        ? { y: normalizeCoordinate(ui?.settingsBounds?.y) }
        : {}),
      width: Math.max(720, Number(ui?.settingsBounds?.width || defaults.settingsBounds.width)),
      height: Math.max(560, Number(ui?.settingsBounds?.height || defaults.settingsBounds.height))
    },
    aiWindowBounds: {
      ...(normalizeCoordinate(ui?.aiWindowBounds?.x) !== undefined
        ? { x: normalizeCoordinate(ui?.aiWindowBounds?.x) }
        : {}),
      ...(normalizeCoordinate(ui?.aiWindowBounds?.y) !== undefined
        ? { y: normalizeCoordinate(ui?.aiWindowBounds?.y) }
        : {}),
      width: Math.max(320, Number(ui?.aiWindowBounds?.width || defaults.aiWindowBounds.width)),
      height: Math.max(320, Number(ui?.aiWindowBounds?.height || defaults.aiWindowBounds.height))
    },
    aiWindowCloseOnBlur: ui?.aiWindowCloseOnBlur !== false,
    aiWindowFontScale: Math.min(200, Math.max(70, Number(ui?.aiWindowFontScale || defaults.aiWindowFontScale || 100))),
    aiWindowPresentationPin: ui?.aiWindowPresentationPin === true
  };
}

function normalizeLogging(logging = {}) {
  return {
    enabled: logging?.enabled === true
  };
}

function normalizeStartup(startup = {}) {
  return {
    launch_on_boot: startup?.launch_on_boot === true
  };
}

function normalizeWebDavSync(webdav = {}) {
  const defaults = createDefaultConfig().sync.webdav;
  const normalizeString = (value, fallback = '') => String(value ?? fallback).trim();

  return {
    enabled: webdav?.enabled === true,
    url: normalizeString(webdav?.url),
    username: normalizeString(webdav?.username),
    password: String(webdav?.password ?? ''),
    remote_path: normalizeString(webdav?.remote_path, defaults.remote_path) || defaults.remote_path,
    backup_enabled: webdav?.backup_enabled !== false,
    backup_retention: Math.max(0, Number(webdav?.backup_retention ?? defaults.backup_retention ?? DEFAULT_WEBDAV_BACKUP_RETENTION)),
    mode: SUPPORTED_WEBDAV_SYNC_MODES.includes(webdav?.mode) ? webdav.mode : defaults.mode,
    conflict_policy: SUPPORTED_WEBDAV_CONFLICT_POLICIES.includes(webdav?.conflict_policy)
      ? webdav.conflict_policy
      : defaults.conflict_policy,
    sync_ai_window_font_size: webdav?.sync_ai_window_font_size === true,
    last_sync_at: normalizeString(webdav?.last_sync_at),
    last_sync_status: ['idle', 'success', 'error', 'conflict'].includes(webdav?.last_sync_status)
      ? webdav.last_sync_status
      : 'idle',
    last_sync_action: ['upload', 'upload-initial', 'download', 'noop', 'resolved-local', 'resolved-remote', 'deferred', ''].includes(webdav?.last_sync_action)
      ? webdav.last_sync_action
      : '',
    last_sync_error: normalizeString(webdav?.last_sync_error),
    last_sync_snapshot_hash: normalizeString(webdav?.last_sync_snapshot_hash)
  };
}

function normalizeSync(sync = {}) {
  return {
    webdav: normalizeWebDavSync(sync?.webdav)
  };
}

function normalizeMeta(meta = {}) {
  return {
    updated_at: typeof meta?.updated_at === 'string' ? meta.updated_at.trim() : ''
  };
}

function normalizeSelection(selection = {}, configVersion = 0) {
  const defaults = createDefaultConfig().selection;
  const mode = SUPPORTED_SELECTION_MODES.includes(selection?.mode) ? selection.mode : defaults.mode;
  const auxiliaryHotkey = coerceArray(selection?.auxiliary_hotkey)
    .map((key) => String(key).trim().toLowerCase())
    .filter(Boolean);
  const blacklistExes = coerceArray(selection?.blacklist_exes)
    .map((value) => String(value).trim().toLowerCase())
    .filter(Boolean);
  const whitelistExes = coerceArray(selection?.whitelist_exes)
    .map((value) => String(value).trim().toLowerCase())
    .filter(Boolean);
  const hardDisabledCategories = coerceArray(selection?.hard_disabled_categories)
    .map((value) => String(value).trim())
    .filter((value) => HARD_DISABLED_CATEGORIES.includes(value));

  const rawToolbarOffsetX = Number(selection?.toolbar_offset?.x);
  const rawToolbarOffsetY = Number(selection?.toolbar_offset?.y);
  const rawToolbarAutoHideSeconds = Number(selection?.toolbar_auto_hide_seconds);
  const hasToolbarOffsetX = Number.isFinite(rawToolbarOffsetX);
  const hasToolbarOffsetY = Number.isFinite(rawToolbarOffsetY);
  const migratedLegacyToolbarOffset =
    configVersion < 7 && hasToolbarOffsetX && hasToolbarOffsetY && rawToolbarOffsetX === 0 && rawToolbarOffsetY === -6;

  return {
    mode,
    auxiliary_hotkey: auxiliaryHotkey,
    blacklist_exes: Array.from(new Set(blacklistExes)),
    whitelist_exes: Array.from(new Set(whitelistExes)),
    hard_disabled_categories:
      Array.isArray(selection?.hard_disabled_categories)
        ? Array.from(new Set(hardDisabledCategories))
        : [...defaults.hard_disabled_categories],
    toolbar_offset: {
      x: hasToolbarOffsetX
        ? rawToolbarOffsetX
        : defaults.toolbar_offset.x,
      y: migratedLegacyToolbarOffset
        ? defaults.toolbar_offset.y
        : hasToolbarOffsetY
          ? rawToolbarOffsetY
        : defaults.toolbar_offset.y
    },
    toolbar_auto_hide_seconds:
      Number.isFinite(rawToolbarAutoHideSeconds) && rawToolbarAutoHideSeconds > 0
        ? Math.max(0, Math.round(rawToolbarAutoHideSeconds))
        : 0,
    proxy: normalizeProxy(selection?.proxy, { fallbackMode: defaults.proxy?.mode || 'system' }),
    copy_fallback_enabled: configVersion < 3 ? true : selection?.copy_fallback_enabled !== false,
    diagnostics_enabled: selection?.diagnostics_enabled !== false
  };
}

function ensureBuiltinCopyTool(tools) {
  const normalizedTools = coerceArray(tools)
    .map((tool) => normalizeTool(tool))
    .filter(Boolean);

  const copyCandidates = normalizedTools
    .map((tool, index) => ({ tool, index }))
    .filter(({ tool }) => tool.id === BUILTIN_COPY_TOOL_ID || tool.type === 'copy');

  if (!copyCandidates.length) {
    normalizedTools.unshift(normalizeCopyTool());
  } else {
    const [firstCopy] = copyCandidates;
    normalizedTools[firstCopy.index] = normalizeCopyTool(firstCopy.tool);

    for (let index = copyCandidates.length - 1; index >= 1; index -= 1) {
      normalizedTools.splice(copyCandidates[index].index, 1);
    }
  }

  const seen = new Set();
  return normalizedTools.filter((tool, index) => {
    if (index === 0) {
      seen.add(tool.id);
      return true;
    }

    if (seen.has(tool.id)) {
      tool.id = createId('tool');
    }

    seen.add(tool.id);
    return true;
  });
}

function normalizeConfig(input = {}) {
  const configVersion = Number(input.version || 0);

  return {
    version: CONFIG_VERSION,
    tools: ensureBuiltinCopyTool(input.tools),
    ai_providers: coerceArray(input.ai_providers).map((provider) => normalizeProvider(provider)),
    selection: normalizeSelection(input.selection, configVersion),
    logging: normalizeLogging(input.logging),
    startup: normalizeStartup(input.startup),
    sync: normalizeSync(input.sync),
    meta: normalizeMeta(input.meta),
    ui: normalizeUi(input.ui)
  };
}

export const __test__ = {
  normalizeConfig
};

export function initConfigStore(portablePaths) {
  store = new Store({
    name: 'config',
    cwd: portablePaths.data,
    defaults: createDefaultConfig(),
    clearInvalidConfig: false,
    serialize: (value) => JSON.stringify(value, null, 2)
  });

  store.store = normalizeConfig(store.store);
  return getConfig();
}

function requireStore() {
  if (!store) {
    throw new Error('Config store has not been initialized.');
  }

  return store;
}

export function getConfig() {
  return deepClone(normalizeConfig(requireStore().store));
}

export function saveConfig(nextConfig, options = {}) {
  const normalized = normalizeConfig(nextConfig);
  const preserveMetaTimestamp = options?.preserveMetaTimestamp === true;
  normalized.meta.updated_at =
    preserveMetaTimestamp && normalized.meta.updated_at
      ? normalized.meta.updated_at
      : new Date().toISOString();
  requireStore().store = normalized;
  return getConfig();
}

export function getEnabledTools() {
  return getConfig().tools.filter((tool) => tool.enabled);
}

export function getToolById(toolId) {
  return getConfig().tools.find((tool) => tool.id === toolId) || null;
}

export function getProviderById(providerId) {
  const config = getConfig();
  const provider = config.ai_providers.find((item) => item.id === providerId);

  if (!provider) {
    return null;
  }

  return {
    ...provider,
    proxy: resolveProviderProxy(provider.proxy, config.selection?.proxy)
  };
}
