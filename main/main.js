import fs from 'node:fs';
import { Worker } from 'node:worker_threads';
import {
  BrowserWindow,
  Menu,
  Tray,
  app,
  clipboard,
  dialog,
  ipcMain,
  nativeImage,
  screen,
  shell
} from 'electron';
import { executeCopyAction } from './actions/copy.js';
import { executeHotkeyAction } from './actions/hotkey.js';
import { executeUrlAction } from './actions/url.js';
import {
  getConfig,
  getEnabledTools,
  getProviderById,
  getTranslationTargetByRef,
  getToolById,
  initConfigStore,
  resolveProviderProxy,
  saveConfig
} from './config.js';
import { APP_NAME } from './defaults.js';
import { getForegroundWindow, waitForForegroundRecovery } from './foreground.js';
import { createDisconnectedDiagnostics, createHelperRuntimeController } from './helper-runtime-controller.js';
import { normalizeHotkeyKeys, sendCopyShortcut, sendVsCodeCopyShortcut } from './input-sender.js';
import { listInstalledApps } from './installed-apps.js';
import { AppLogger } from './logger.js';
import { syncLaunchOnBootRegistry } from './launch-on-boot.js';
import { NativeClient } from './native-client.js';
import { configurePortableAppPaths, createPortablePaths, ensurePortablePaths, resolveAssetPath } from './paths.js';
import { PopupManager } from './popup.js';
import { recoverSelectionForApp } from './selection-recovery.js';
import { buildSelectionPopupFingerprint, createSelectionPopupController } from './selection-popup-controller.js';
import { SelectionService } from './selection-service.js';
import { normalizeHookPoint } from './selection-utils.js';
import { SettingsWindowManager } from './settings-window.js';
import { deepClone } from './utils.js';
import { VsCodeSelectionRecoveryService } from './vscode-selection-recovery.js';

app.disableHardwareAcceleration();

let tray = null;
let hookWorker = null;
let globalEnabled = true;
let quitting = false;
let latestMouseReleaseAnchor = null;
let latestDiagnostics = null;
let webDavSyncService = null;
let webDavSyncServicePromise = null;
let iconService = null;
let iconServicePromise = null;
let translationCache = null;
let translationCachePromise = null;
let aiWindowManager = null;
let aiWindowManagerPromise = null;
let aiRuntimeModule = null;
let aiRuntimeModulePromise = null;
let aiWarmCleanupTimer = null;
let aiWarmUntil = 0;
let aiRuntimeLoadDurationMs = 0;
let latestAiState = {
  windowCount: 0,
  activeRequestCount: 0,
  lastReason: ''
};
let markdownRendererPromise = null;
let markdownRendererReleaseTimer = null;
let startupMemorySampleTimer = null;
const MARKDOWN_RENDERER_IDLE_MS = 30_000;
const STARTUP_IDLE_SAMPLE_DELAY_MS = 20_000;
const AI_WARM_IDLE_MS = 5 * 60_000;
const STARTUP_LOG_FILE_NAME = 'startup.log';
const SELECTION_POPUP_DEDUPE_WINDOW_MS = 900;

const portablePaths = createPortablePaths();
ensurePortablePaths(portablePaths);
configurePortableAppPaths(portablePaths);

app.setName(APP_NAME);

const appLogger = new AppLogger({
  logsDir: portablePaths.logs
});
const urlLogger = appLogger.child('url');

if (!app.requestSingleInstanceLock()) {
  app.quit();
}

function serializeStartupFailure(error) {
  if (error instanceof Error) {
    return JSON.stringify({
      name: error.name,
      message: error.message,
      stack: error.stack
    });
  }

  return JSON.stringify({
    message: String(error)
  });
}

function appendStartupFailureLog(message, error) {
  const targetPath = `${portablePaths.logs}\\${STARTUP_LOG_FILE_NAME}`;
  const line = `${new Date().toISOString()} ERROR [startup] ${message} ${serializeStartupFailure(error)}`;

  fs.mkdirSync(portablePaths.logs, { recursive: true });
  fs.appendFileSync(targetPath, `${line}\n`, 'utf8');
}

async function renderMarkdownToHtmlLazy(markdown) {
  if (!markdownRendererPromise) {
    markdownRendererPromise = import('./markdown.js')
      .then((module) => module.renderMarkdownToHtml)
      .catch((error) => {
        markdownRendererPromise = null;
        throw error;
      });
  }

  const renderMarkdown = await markdownRendererPromise;
  if (markdownRendererReleaseTimer) {
    clearTimeout(markdownRendererReleaseTimer);
  }
  markdownRendererReleaseTimer = setTimeout(() => {
    markdownRendererPromise = null;
    markdownRendererReleaseTimer = null;
  }, MARKDOWN_RENDERER_IDLE_MS);
  return renderMarkdown(markdown);
}

function createEmptyDiagnostics() {
  return {
    connected: false,
    helperReady: false,
    lastStrategy: '',
    finalSelectionStrategy: '',
    finalTextSource: '',
    lastReason: '',
    lastError: '',
    processName: '',
    processPath: '',
    windowTitle: '',
    className: '',
    blockedRiskCategory: '',
    blockedRiskSignal: '',
    matchedCopyRule: '',
    requestedCopyMode: 'auto',
    effectiveCopyMode: 'auto',
    selectionLength: 0,
    lastTriggerAt: 0,
    helperWorkingSetBytes: 0,
    helperPrivateBytes: 0
  };
}

function hasBlockedRiskDiagnostics(diagnostics = {}) {
  return Boolean(String(diagnostics?.blockedRiskCategory || '').trim());
}

function createHelperDisconnectedDiagnostics(baseDiagnostics = null) {
  return createDisconnectedDiagnostics({
    baseDiagnostics,
    createEmptyDiagnostics
  });
}

function kbToBytes(value) {
  const nextValue = Number(value || 0);
  return Number.isFinite(nextValue) ? Math.max(0, Math.round(nextValue * 1024)) : 0;
}

function createMemoryBucket() {
  return {
    count: 0,
    workingSetBytes: 0,
    privateBytes: 0,
    peakWorkingSetBytes: 0
  };
}

function addMetricToBucket(bucket, metric) {
  if (!bucket || !metric?.memory) {
    return;
  }

  bucket.count += 1;
  bucket.workingSetBytes += kbToBytes(metric.memory.workingSetSize);
  bucket.privateBytes += kbToBytes(metric.memory.privateBytes);
  bucket.peakWorkingSetBytes += kbToBytes(metric.memory.peakWorkingSetSize);
}

function combineMemoryBuckets(...buckets) {
  return buckets.reduce((combined, bucket) => ({
    count: combined.count + Number(bucket?.count || 0),
    workingSetBytes: combined.workingSetBytes + Number(bucket?.workingSetBytes || 0),
    privateBytes: combined.privateBytes + Number(bucket?.privateBytes || 0),
    peakWorkingSetBytes: combined.peakWorkingSetBytes + Number(bucket?.peakWorkingSetBytes || 0)
  }), createMemoryBucket());
}

function captureElectronMemorySnapshot() {
  const buckets = {
    browser: createMemoryBucket(),
    renderer: createMemoryBucket(),
    gpu: createMemoryBucket(),
    utility: createMemoryBucket(),
    other: createMemoryBucket()
  };

  for (const metric of app.getAppMetrics()) {
    switch (metric.type) {
      case 'Browser':
        addMetricToBucket(buckets.browser, metric);
        break;
      case 'Tab':
        addMetricToBucket(buckets.renderer, metric);
        break;
      case 'GPU':
        addMetricToBucket(buckets.gpu, metric);
        break;
      case 'Utility':
        addMetricToBucket(buckets.utility, metric);
        break;
      default:
        addMetricToBucket(buckets.other, metric);
        break;
    }
  }

  return {
    ...buckets,
    total: combineMemoryBuckets(
      buckets.browser,
      buckets.renderer,
      buckets.gpu,
      buckets.utility,
      buckets.other
    )
  };
}

function formatBucketSummaryForLog(bucket) {
  return {
    count: Number(bucket?.count || 0),
    workingSetMB: Number((Number(bucket?.workingSetBytes || 0) / 1024 / 1024).toFixed(1)),
    privateMB: Number((Number(bucket?.privateBytes || 0) / 1024 / 1024).toFixed(1))
  };
}

function buildMemorySummaryForLog(memory) {
  return {
    electron: {
      browser: formatBucketSummaryForLog(memory?.electron?.browser),
      renderer: formatBucketSummaryForLog(memory?.electron?.renderer),
      gpu: formatBucketSummaryForLog(memory?.electron?.gpu),
      utility: formatBucketSummaryForLog(memory?.electron?.utility),
      other: formatBucketSummaryForLog(memory?.electron?.other),
      total: formatBucketSummaryForLog(memory?.electron?.total)
    },
    nativeHelper: formatBucketSummaryForLog(memory?.nativeHelper),
    total: formatBucketSummaryForLog(memory?.total)
  };
}

async function collectDiagnosticsSnapshot(baseDiagnostics = null) {
  let helperDiagnostics = baseDiagnostics;

  if (!helperDiagnostics) {
    try {
      helperDiagnostics = await nativeClient.requestDiagnostics();
    } catch (error) {
      appLogger.warn('diagnostics', 'Failed to request helper diagnostics snapshot.', {
        message: error instanceof Error ? error.message : String(error)
      });
      helperDiagnostics = latestDiagnostics || createEmptyDiagnostics();
    }
  }

  latestDiagnostics = {
    ...createEmptyDiagnostics(),
    ...(latestDiagnostics || {}),
    ...(helperDiagnostics || {})
  };

  const electronMemory = captureElectronMemorySnapshot();
  const helperProcessInfo = nativeClient.getProcessInfo();
  const aiRuntimeStats = await getAiRuntimeStatsSnapshot();
  const nativeHelperMemory = {
    count: helperProcessInfo.pid ? 1 : 0,
    workingSetBytes: Number(latestDiagnostics.helperWorkingSetBytes || 0),
    privateBytes: Number(latestDiagnostics.helperPrivateBytes || 0),
    peakWorkingSetBytes: 0
  };

  return {
    ...latestDiagnostics,
    helperPid: helperProcessInfo.pid,
    sampledAt: new Date().toISOString(),
    aiWarm: aiWarmUntil > Date.now(),
    aiWarmUntil: aiWarmUntil ? new Date(aiWarmUntil).toISOString() : '',
    activeAiRequests: latestAiState.activeRequestCount,
    aiWindowCount: latestAiState.windowCount,
    aiLastStateReason: latestAiState.lastReason || '',
    aiSessionPoolSize: aiRuntimeStats.sessionPoolSize,
    aiSessionReuseHits: aiRuntimeStats.sessionReuseHits,
    aiRuntimeLoadMs: aiRuntimeLoadDurationMs,
    translationCacheLoaded: aiRuntimeStats.translationCacheLoaded,
    translationCacheEntries: aiRuntimeStats.translationCacheEntries,
    memory: {
      electron: electronMemory,
      nativeHelper: nativeHelperMemory,
      total: combineMemoryBuckets(electronMemory.total, nativeHelperMemory)
    }
  };
}

async function syncDiagnosticsSnapshot(baseDiagnostics = null) {
  const snapshot = await collectDiagnosticsSnapshot(baseDiagnostics);
  settingsWindowManager.syncDiagnostics(snapshot);
  return snapshot;
}

async function logPerformanceSnapshot(scope, message, meta = {}, baseDiagnostics = null) {
  const snapshot = await collectDiagnosticsSnapshot(baseDiagnostics);
  appLogger.info(scope, message, {
    ...meta,
    memory: buildMemorySummaryForLog(snapshot.memory)
  });
  return snapshot;
}

async function loadAiRuntimeModule() {
  if (aiRuntimeModule) {
    return aiRuntimeModule;
  }

  if (!aiRuntimeModulePromise) {
    const startedAt = Date.now();

    aiRuntimeModulePromise = import('./ai/index.js')
      .then((module) => {
        aiRuntimeModule = module;
        aiRuntimeLoadDurationMs = Date.now() - startedAt;
        appLogger.info('ai', 'AI runtime module loaded.', {
          loadMs: aiRuntimeLoadDurationMs
        });
        return module;
      })
      .catch((error) => {
        aiRuntimeModulePromise = null;
        throw error;
      });
  }

  return aiRuntimeModulePromise;
}

function clearAiWarmCleanupTimer() {
  if (aiWarmCleanupTimer) {
    clearTimeout(aiWarmCleanupTimer);
    aiWarmCleanupTimer = null;
  }
}

function touchAiWarm(reason = 'activity') {
  aiWarmUntil = Date.now() + AI_WARM_IDLE_MS;
  latestAiState.lastReason = reason;
}

async function getAiRuntimeStatsSnapshot() {
  if (!aiRuntimeModule) {
    return {
      sessionPoolSize: 0,
      sessionReuseHits: 0,
      translationCacheLoaded: translationCache?.loaded === true,
      translationCacheEntries: translationCache?.getStats?.().entryCount || 0
    };
  }

  const runtimeStats = aiRuntimeModule.getAiRuntimeStats?.() || {};
  const cacheStats = translationCache?.getStats?.() || {
    loaded: false,
    entryCount: 0
  };

  return {
    sessionPoolSize: Number(runtimeStats.size || 0),
    sessionReuseHits: Number(runtimeStats.reuseHits || 0),
    translationCacheLoaded: cacheStats.loaded === true,
    translationCacheEntries: Number(cacheStats.entryCount || 0)
  };
}

async function releaseAiWarmResources(reason = 'idle-timeout') {
  clearAiWarmCleanupTimer();

  if (aiWindowManager && !aiWindowManager.canRelease()) {
    touchAiWarm('busy');
    scheduleAiWarmCleanup('busy');
    return false;
  }

  if (aiWindowManager) {
    aiWindowManager.dispose?.();
    aiWindowManager = null;
    aiWindowManagerPromise = null;
  }

  translationCache?.dispose?.();
  translationCache = null;
  translationCachePromise = null;

  if (aiRuntimeModule) {
    await aiRuntimeModule.releaseAiRuntime?.();
  }

  aiWarmUntil = 0;
  latestAiState = {
    windowCount: 0,
    activeRequestCount: 0,
    lastReason: reason
  };
  clearAiWarmCleanupTimer();
  appLogger.info('ai', 'Released warm AI resources.', {
    reason
  });
  return true;
}

function scheduleAiWarmCleanup(reason = 'scheduled') {
  clearAiWarmCleanupTimer();

  if (!aiWarmUntil) {
    return;
  }

  const delayMs = Math.max(0, aiWarmUntil - Date.now());

  aiWarmCleanupTimer = setTimeout(() => {
    aiWarmCleanupTimer = null;
    void releaseAiWarmResources(reason);
  }, delayMs);
}

function handleAiStateChanged(state = {}) {
  latestAiState = {
    windowCount: Number(state.windowCount || 0),
    activeRequestCount: Number(state.activeRequestCount || 0),
    lastReason: String(state.reason || '')
  };

  touchAiWarm(latestAiState.lastReason || 'state-changed');

  if (latestAiState.windowCount === 0 && latestAiState.activeRequestCount === 0) {
    scheduleAiWarmCleanup(latestAiState.lastReason || 'idle');
    return;
  }

  clearAiWarmCleanupTimer();
}

async function getIconService() {
  if (iconService) {
    return iconService;
  }

  if (!iconServicePromise) {
    iconServicePromise = import('./icon-service.js')
      .then(({ IconService }) => {
        const service = new IconService({
          cacheDir: portablePaths.iconCache,
          logger: appLogger.child('icons'),
          getProxy: () => getConfig().selection?.proxy
        });
        service.on('icon-resolved', (payload) => {
          settingsWindowManager.syncIconResolved(payload);
        });
        service.on('icon-failed', (payload) => {
          settingsWindowManager.syncIconFailed(payload);
        });
        iconService = service;
        return service;
      })
      .catch((error) => {
        iconServicePromise = null;
        throw error;
      });
  }

  return iconServicePromise;
}

async function getTranslationCache() {
  if (translationCache) {
    return translationCache;
  }

  if (!translationCachePromise) {
    translationCachePromise = import('./translation-cache.js')
      .then(({ TranslationCache }) => {
        translationCache = new TranslationCache({
          cacheDir: portablePaths.aiCache,
          logger: appLogger.child('ai-cache')
        });
        return translationCache;
      })
      .catch((error) => {
        translationCachePromise = null;
        throw error;
      });
  }

  return translationCachePromise;
}

async function getAiWindowManager() {
  if (aiWindowManager) {
    touchAiWarm('manager-reused');
    return aiWindowManager;
  }

  if (!aiWindowManagerPromise) {
    aiWindowManagerPromise = Promise.all([
      import('./ai-window.js'),
      getTranslationCache(),
      loadAiRuntimeModule()
    ])
      .then(([{ AiWindowManager }, currentTranslationCache, aiRuntime]) => {
        aiWindowManager = new AiWindowManager(
          getConfig,
          getTranslationTargetByRef,
          {
            startTranslation: (target, text, prompt, callbacks, signal, options) =>
              aiRuntime.startTranslation(target, text, prompt, callbacks, signal, options),
            logger: appLogger.child('ai'),
            saveBounds: (bounds) => persistUiBounds('aiWindowBounds', bounds),
            translationCache: currentTranslationCache,
            onStateChanged: handleAiStateChanged
          }
        );
        touchAiWarm('manager-created');
        scheduleAiWarmCleanup('manager-created');
        return aiWindowManager;
      })
      .catch((error) => {
        aiWindowManagerPromise = null;
        throw error;
      });
  }

  return aiWindowManagerPromise;
}

function formatSyncTimestampForPrompt(value) {
  const timestamp = Date.parse(String(value || ''));

  if (!Number.isFinite(timestamp)) {
    return '未知';
  }

  return new Date(timestamp).toLocaleString('zh-CN', {
    hour12: false
  });
}

async function promptWebDavConflict({ localConfig, remoteConfig, remoteUrl }) {
  const options = {
    type: 'warning',
    title: 'WebDAV 同步冲突',
    message: '检测到本地和远端配置都发生了变化。',
    detail: [
      '自动同步已暂停，请选择要保留的共享配置版本。',
      `本地记录时间：${formatSyncTimestampForPrompt(localConfig?.meta?.updated_at)}`,
      `远端记录时间：${formatSyncTimestampForPrompt(remoteConfig?.meta?.updated_at)}`,
      `同步位置：${remoteUrl}`,
      '',
      '“使用本地”会先备份远端，再上传当前本地共享配置。',
      '“使用远程”会下载远端共享配置，并保留本机专属设置。',
      '“稍后处理”会保留冲突状态，不覆盖任一方。'
    ].join('\n'),
    buttons: ['使用本地', '使用远程', '稍后处理'],
    defaultId: 0,
    cancelId: 2,
    noLink: true,
    normalizeAccessKeys: true
  };
  const parentWindow = settingsWindowManager.window && !settingsWindowManager.window.isDestroyed()
    ? settingsWindowManager.window
    : undefined;
  const result = parentWindow
    ? await dialog.showMessageBox(parentWindow, options)
    : await dialog.showMessageBox(options);

  if (result.response === 0) {
    return 'local';
  }

  if (result.response === 1) {
    return 'remote';
  }

  return 'defer';
}

async function getWebDavSyncService() {
  if (webDavSyncService) {
    return webDavSyncService;
  }

  if (!webDavSyncServicePromise) {
    webDavSyncServicePromise = import('./webdav-sync.js')
      .then(({ WebDavSyncService }) => {
        webDavSyncService = new WebDavSyncService({
          getConfig,
          logger: appLogger.child('webdav'),
          promptConflict: (context) => promptWebDavConflict(context),
          applyConfig: (nextConfig, options) =>
            commitConfig(nextConfig, {
              preserveMetaTimestamp: options?.preserveMetaTimestamp === true,
              scheduleSyncUpload: options?.syncUpload !== false,
              refreshRuntime: options?.refreshRuntime !== false,
              syncSettingsWindow: options?.syncSettingsWindow !== false,
              updateStartup: options?.updateStartup !== false,
              successLogContext: options?.successLogContext ?? null
            })
        });
        return webDavSyncService;
      })
      .catch((error) => {
        webDavSyncServicePromise = null;
        throw error;
      });
  }

  return webDavSyncServicePromise;
}

async function testProviderConnectionLazy(provider) {
  const aiModule = await loadAiRuntimeModule();
  touchAiWarm('provider-test');
  scheduleAiWarmCleanup('provider-test');
  return aiModule.testProviderConnection(provider);
}

function triggerStartupWebDavSync() {
  void (async () => {
    const config = getConfig();

    if (config?.sync?.webdav?.enabled !== true) {
      return;
    }

    appLogger.info('webdav', 'Startup WebDAV sync beginning.');

    try {
      const service = await getWebDavSyncService();
      const syncResult = await service.syncOnStartup();

      appLogger.info('webdav', 'Startup WebDAV sync completed.', {
        ok: syncResult?.ok === true,
        action: syncResult?.action || '',
        skipped: syncResult?.skipped === true,
        conflict: syncResult?.conflict === true
      });
    } catch (error) {
      appLogger.warn('webdav', 'Startup WebDAV sync failed.', {
        message: error instanceof Error ? error.message : String(error)
      });
    }
  })();
}

function scheduleStartupIdleSample() {
  if (startupMemorySampleTimer) {
    clearTimeout(startupMemorySampleTimer);
  }

  startupMemorySampleTimer = setTimeout(() => {
    startupMemorySampleTimer = null;
    void logPerformanceSnapshot('perf', 'Captured startup idle memory sample.', {
      delayMs: STARTUP_IDLE_SAMPLE_DELAY_MS
    });
  }, STARTUP_IDLE_SAMPLE_DELAY_MS);
}

async function persistUiBounds(key, bounds) {
  const nextConfig = deepClone(getConfig());
  nextConfig.ui = {
    ...nextConfig.ui,
    [key]: {
      ...(nextConfig.ui?.[key] || {}),
      ...bounds
    }
  };
  await commitConfig(nextConfig, {
    refreshRuntime: false,
    syncSettingsWindow: false,
    updateStartup: false,
    successLogContext: null
  });
}

function handleDisplayMetricsChanged() {
  settingsWindowManager.handleDisplayMetricsChanged?.();
  aiWindowManager?.handleDisplayMetricsChanged?.();
  popupManager.handleDisplayMetricsChanged?.();
}

function captureLiveCursorDip(fallbackPoint = null) {
  try {
    const point = screen.getCursorScreenPoint();

    if (Number.isFinite(point?.x) && Number.isFinite(point?.y)) {
      return point;
    }
  } catch {
  }

  return fallbackPoint;
}

function rememberMouseReleaseAnchor(point) {
  if (!point) {
    return;
  }

  latestMouseReleaseAnchor = {
    point,
    capturedAt: Date.now()
  };
}

function hasRecentMouseAnchor() {
  return Boolean(latestMouseReleaseAnchor && Date.now() - latestMouseReleaseAnchor.capturedAt <= 2000);
}

function resolvePopupAnchorPoint(fallbackPoint = null) {
  if (latestMouseReleaseAnchor && Date.now() - latestMouseReleaseAnchor.capturedAt <= 2000) {
    return {
      point: latestMouseReleaseAnchor.point,
      source: 'hook-mouseup-dip'
    };
  }

  const liveCursorDip = captureLiveCursorDip(fallbackPoint);

  return {
    point: liveCursorDip || fallbackPoint || { x: 0, y: 0 },
    source: liveCursorDip ? 'live-cursor-dip' : 'fallback-dip'
  };
}

async function showPopupForSelection({
  selectedText,
  tools = getEnabledTools(),
  diagnostics = {},
  strategy = '',
  mouse = null,
  anchorRect = null,
  flowId = 0,
  fingerprint = ''
} = {}) {
  if (!globalEnabled || !selectionPopupController.isCurrent(flowId)) {
    return false;
  }

  if (!tools.length || !selectedText) {
    appLogger.warn('selection', 'Selection result ignored because no enabled tools or text were available.', {
      enabledToolCount: tools.length,
      selectionLength: selectedText?.length || 0
    });
    return false;
  }

  for (const tool of tools) {
    queuePopupToolIconFetch(tool);
  }

  if (popupManager.isVisible()) {
    popupManager.hide();
  }

  const selectionReason = diagnostics?.lastReason || '';
  appLogger.info('selection', 'Selection found.', {
    strategy: strategy || diagnostics?.lastStrategy || '',
    reason: selectionReason,
    processName: diagnostics?.processName || '',
    selectionLength: selectedText.length
  });

  const helperMouseDip =
    mouse && Number.isFinite(mouse.x) && Number.isFinite(mouse.y)
      ? normalizeHookPoint(mouse)
      : null;
  const popupAnchor =
    selectionReason.startsWith('mouse-')
      ? resolvePopupAnchorPoint(helperMouseDip)
      : {
          point: captureLiveCursorDip(helperMouseDip) || helperMouseDip || { x: 0, y: 0 },
          source: 'live-cursor-dip'
        };
  const decoratedTools = await decorateToolsForUi(tools);

  if (!globalEnabled || !selectionPopupController.isCurrent(flowId)) {
    return false;
  }

  if (!selectionPopupController.shouldShow({ flowId, fingerprint })) {
    appLogger.info('popup', 'Popup request deduplicated or superseded.', {
      fingerprint,
      strategy: strategy || diagnostics?.lastStrategy || ''
    });
    return false;
  }

  await popupManager.show({
    selectedText,
    tools: decoratedTools,
    mouse,
    anchorPoint: popupAnchor.point,
    anchorSource: popupAnchor.source,
    anchorRect,
    strategy
  });

  if (!globalEnabled || !selectionPopupController.isCurrent(flowId)) {
    popupManager.hide();
    return false;
  }

  selectionPopupController.markShown(fingerprint);
  const popupContext = popupManager.getContext?.() || {};
  appLogger.info('popup', 'Popup shown for selected text.', {
    toolCount: tools.length,
    strategy: strategy || diagnostics?.lastStrategy || '',
    anchorType: popupContext.anchorType || 'unknown',
    anchorSource: popupContext.anchorSource || 'unknown',
    usedAnchorRect: popupContext.usedAnchorRect === true,
    helperMouse: popupContext.mouse || null,
    liveCursorDip: popupContext.anchorPoint || null,
    helperLiveDelta: popupContext.helperLiveDelta || null,
    displayScaleFactor: popupContext.displayScaleFactor || null,
    bounds: popupManager.getBounds()
  });
  return true;
}

function createMatchedRuleLabel(rule) {
  if (!rule) {
    return '';
  }

  return `${rule.label || rule.process_name || '兼容规则'} · ${rule.mode}`;
}

async function resolveSelectionContext(diagnostics = {}) {
  const foregroundWindow = await getForegroundWindow();
  const processName = String(
    foregroundWindow?.owner?.name
      || diagnostics?.processName
      || ''
  ).trim().toLowerCase();
  const processPath = String(foregroundWindow?.owner?.path || '').trim();

  return {
    processName,
    processPath,
    windowTitle: String(foregroundWindow?.title || diagnostics?.windowTitle || '').trim()
  };
}

async function handleRecoveredSelection({
  helperText = '',
  diagnostics = {},
  strategy = '',
  mouse = null,
  anchorRect = null,
  flowId = 0
} = {}) {
  if (!globalEnabled || !selectionPopupController.isCurrent(flowId)) {
    return false;
  }

  const selectionContext = await resolveSelectionContext(diagnostics);

  if (!globalEnabled || !selectionPopupController.isCurrent(flowId)) {
    return false;
  }

  const recovery = await recoverSelectionForApp({
    helperText,
    helperStrategy: strategy || diagnostics?.lastStrategy || '',
    diagnostics,
    processName: selectionContext.processName,
    processPath: selectionContext.processPath,
    hasRecentMouseAnchor: hasRecentMouseAnchor(),
    selectionConfig: getConfig().selection,
    selectionService,
    vsCodeRecoveryService: vsCodeSelectionRecoveryService
  });

  if (!globalEnabled || !selectionPopupController.isCurrent(flowId)) {
    return false;
  }

  const mergedDiagnostics = {
    ...(diagnostics || {}),
    processName: selectionContext.processName || diagnostics?.processName || '',
    processPath: selectionContext.processPath || '',
    windowTitle: selectionContext.windowTitle || diagnostics?.windowTitle || '',
    matchedCopyRule: createMatchedRuleLabel(recovery.matchedRule),
    requestedCopyMode: recovery.requestedMode,
    effectiveCopyMode: recovery.effectiveMode,
    finalSelectionStrategy: recovery.finalSelectionStrategy,
    finalTextSource: recovery.finalTextSource,
    selectionLength: recovery.text?.length || 0,
    lastError: recovery.ok ? '' : recovery.error || diagnostics?.lastError || ''
  };

  await syncDiagnosticsSnapshot(mergedDiagnostics);

  if (!globalEnabled || !selectionPopupController.isCurrent(flowId)) {
    return false;
  }

  if (!recovery.ok || !recovery.text) {
    appLogger.warn('selection', 'Selection recovery produced no usable text.', {
      processName: mergedDiagnostics.processName,
      processPath: mergedDiagnostics.processPath,
      requestedCopyMode: recovery.requestedMode,
      effectiveCopyMode: recovery.effectiveMode,
      finalSelectionStrategy: recovery.finalSelectionStrategy,
      error: recovery.error || diagnostics?.lastError || ''
    });
    return false;
  }

  const fingerprint = buildSelectionPopupFingerprint({
    diagnostics: mergedDiagnostics,
    selectedText: recovery.text,
    processName: selectionContext.processName,
    processPath: selectionContext.processPath
  });

  return showPopupForSelection({
    selectedText: recovery.text,
    tools: getEnabledTools(),
    diagnostics: mergedDiagnostics,
    strategy: recovery.finalSelectionStrategy,
    mouse,
    anchorRect,
    flowId,
    fingerprint
  });
}

function applyLaunchOnBoot(config) {
  return syncLaunchOnBootPreference(config);
}

class LaunchOnBootSyncWarning extends Error {
  constructor(message, config, cause = null) {
    super(message);
    this.name = 'LaunchOnBootSyncWarning';
    this.config = config;
    this.cause = cause;
  }
}

async function syncLaunchOnBootPreference(
  config,
  {
    interactive = false
  } = {}
) {
  try {
    return await syncLaunchOnBootRegistry({
      enabled: config?.startup?.launch_on_boot === true
    });
  } catch (error) {
    const baseMessage = error instanceof Error ? error.message : String(error);
    appLogger.warn('startup', 'Failed to update launch-on-boot preference.', {
      message: baseMessage
    });

    if (!interactive) {
      return {
        changed: false,
        enabled: config?.startup?.launch_on_boot === true,
        command: ''
      };
    }

    throw new LaunchOnBootSyncWarning(
      `配置已保存，但本机自启写入失败，将在后续启动重试。\n\n${baseMessage}`,
      config,
      error
    );
  }
}

const popupManager = new PopupManager(getConfig, {
  logger: appLogger.child('popup')
});
const settingsWindowManager = new SettingsWindowManager(getConfig, (bounds) => persistUiBounds('settingsBounds', bounds));
const nativeClient = new NativeClient({
  appPid: process.pid,
  logger: appLogger.child('native-helper')
});
const selectionPopupController = createSelectionPopupController({
  dedupeWindowMs: SELECTION_POPUP_DEDUPE_WINDOW_MS
});
const selectionService = new SelectionService({
  sendCopyShortcut,
  readClipboardTextAfterCopyImpl: ({ keys, timeoutMs, pollMs }) =>
    nativeClient.readClipboardTextAfterCopy({
      keys,
      timeoutMs,
      pollMs
    }),
  logger: appLogger.child('selection-service')
});
const vsCodeSelectionRecoveryService = new VsCodeSelectionRecoveryService({
  selectionService,
  sendTerminalCopyShortcut: sendVsCodeCopyShortcut,
  sendEditorCopyShortcut: sendCopyShortcut,
  waitForForegroundRecovery,
  logger: appLogger.child('vscode-selection')
});
const helperRuntime = createHelperRuntimeController({
  nativeClient,
  getConfig,
  createDisconnectedState: (baseDiagnostics = null) => createHelperDisconnectedDiagnostics(baseDiagnostics),
  syncDiagnostics: (baseDiagnostics = null) => syncDiagnosticsSnapshot(baseDiagnostics),
  syncHotkeyRecordState: (payload) => settingsWindowManager.syncHotkeyRecordState(payload),
  onRuntimeStateChanged: (state) => {
    globalEnabled = state.globalEnabled;
    refreshTrayMenu();
  },
  onDisable: async () => {
    selectionPopupController.invalidate();
    popupManager.hide();
  },
  onEnableFailure: async (error) => {
    appLogger.error('native-helper', 'Native helper failed while enabling from tray.', error);
    dialog.showErrorBox(
      'SelectPop 启用失败',
      [
        '原生 helper 启动失败，已回退为禁用状态。',
        '',
        error instanceof Error ? error.message : String(error)
      ].join('\n')
    );
  }
});

process.on('uncaughtException', (error) => {
  appLogger.error('process', 'Uncaught exception.', error);
});

process.on('unhandledRejection', (error) => {
  appLogger.error('process', 'Unhandled promise rejection.', error);
});

function validateHotkeyTools(nextConfig) {
  for (const tool of nextConfig?.tools || []) {
    if (tool?.type === 'hotkey') {
      tool.keys = normalizeHotkeyKeys(tool.keys);
    }
  }

  const selection = nextConfig?.selection;

  if (selection?.auxiliary_hotkey?.length) {
    selection.auxiliary_hotkey = normalizeHotkeyKeys(selection.auxiliary_hotkey);
  }

  return nextConfig;
}

async function commitConfig(
  nextConfig,
  {
    preserveMetaTimestamp = false,
    refreshRuntime = true,
    syncSettingsWindow = true,
    updateStartup = true,
    startupFailureMode = 'ignore',
    scheduleSyncUpload = true,
    successLogContext = 'config'
  } = {}
) {
  const inputConfig = refreshRuntime ? validateHotkeyTools(nextConfig) : nextConfig;
  const config = saveConfig(inputConfig, { preserveMetaTimestamp });
  let startupWarning = null;

  appLogger.setEnabled(config.logging?.enabled === true);

  if (successLogContext) {
    appLogger.info(successLogContext, 'Configuration saved.', {
      selectionMode: config.selection.mode,
      copyFallbackEnabled: config.selection.copy_fallback_enabled,
      loggingEnabled: config.logging?.enabled === true,
      launchOnBoot: config.startup?.launch_on_boot === true,
      webDavEnabled: config.sync?.webdav?.enabled === true
    });
  }

  if (syncSettingsWindow) {
    settingsWindowManager.syncConfig(config);
  }

  aiWindowManager?.syncUiConfig(config);

  if (refreshRuntime) {
    await helperRuntime.syncConfig(config);
  }

  if (updateStartup) {
    try {
      await syncLaunchOnBootPreference(config, {
        interactive: startupFailureMode === 'throw'
      });
    } catch (error) {
      startupWarning = error;
    }
  }

  refreshTrayMenu(config);

  if (scheduleSyncUpload && config?.sync?.webdav?.enabled) {
    const service = await getWebDavSyncService();
    service.scheduleUpload(config);
  }

  if (startupWarning) {
    throw startupWarning;
  }

  return config;
}

function refreshTrayMenu(config = getConfig()) {
  if (!tray) {
    return;
  }

  const contextMenu = Menu.buildFromTemplate([
    {
      label: '启用',
      type: 'checkbox',
      checked: globalEnabled,
      click: (menuItem) => {
        void helperRuntime.setGlobalEnabled(menuItem.checked === true);
      }
    },
    {
      label: '开机自启',
      type: 'checkbox',
      checked: config?.startup?.launch_on_boot === true,
      click: (menuItem) => {
        void toggleLaunchOnBoot(menuItem.checked);
      }
    },
    { type: 'separator' },
    {
      label: '设置',
      click: () => {
        void settingsWindowManager.open();
      }
    },
    { type: 'separator' },
    {
      label: '退出',
      click: () => {
        app.quit();
      }
    }
  ]);

  tray.setContextMenu(contextMenu);
}

async function toggleLaunchOnBoot(enabled) {
  const nextConfig = deepClone(getConfig());
  nextConfig.startup = {
    ...(nextConfig.startup || {}),
    launch_on_boot: enabled === true
  };

  try {
    await commitConfig(nextConfig, {
      refreshRuntime: false,
      syncSettingsWindow: true,
      updateStartup: true,
      startupFailureMode: 'throw',
      successLogContext: 'startup'
    });
  } catch (error) {
    if (!(error instanceof LaunchOnBootSyncWarning)) {
      throw error;
    }

    const parentWindow = settingsWindowManager.window && !settingsWindowManager.window.isDestroyed()
      ? settingsWindowManager.window
      : undefined;
    const options = {
      type: 'warning',
      title: '开机自启写入失败',
      message: '配置已经保存，但本机注册表中的开机自启项暂未更新。',
      detail: error.message,
      buttons: ['知道了'],
      defaultId: 0,
      noLink: true,
      normalizeAccessKeys: true
    };

    if (parentWindow) {
      await dialog.showMessageBox(parentWindow, options);
      return;
    }

    await dialog.showMessageBox(options);
    return;
  }

  appLogger.error('startup', 'Failed to toggle launch-on-boot preference from tray.', error);
  dialog.showErrorBox(
    '开机自启更新失败',
    error instanceof Error ? error.message : String(error)
  );
}

function normalizePopupToolExecution(payload) {
  if (typeof payload === 'string') {
    return {
      toolId: payload,
      anchorPoint: null
    };
  }

  return {
    toolId: String(payload?.toolId || '').trim(),
    anchorPoint:
      Number.isFinite(Number(payload?.anchorPoint?.x)) && Number.isFinite(Number(payload?.anchorPoint?.y))
        ? {
            x: Number(payload.anchorPoint.x),
            y: Number(payload.anchorPoint.y)
          }
        : null
  };
}

function createAnchorBoundsFromPoint(anchorPoint) {
  if (!anchorPoint) {
    return null;
  }

  return {
    x: Math.round(anchorPoint.x),
    y: Math.round(anchorPoint.y),
    width: 0,
    height: 0
  };
}

async function executeTool(payload) {
  try {
    const { toolId, anchorPoint } = normalizePopupToolExecution(payload);
    const tool = getToolById(toolId);
    const selectedText = popupManager.getSelectedText();
    const popupBounds = popupManager.getBounds();
    popupManager.hide();

    if (!tool) {
      throw new Error('工具不存在。');
    }

    if (!selectedText) {
      appLogger.warn('tool', 'Tool execution skipped because no selected text was available.', { toolId });
      return;
    }

    appLogger.info('tool', 'Executing popup tool.', {
      toolId,
      type: tool.type,
      selectedTextLength: selectedText.length,
      copyBeforeAction: tool.copy_before_action === true
    });

    if (tool.copy_before_action === true && tool.type !== 'copy') {
      await executeCopyAction(selectedText);
    }

    switch (tool.type) {
      case 'copy':
        await executeCopyAction(selectedText);
        return;
      case 'hotkey':
        await executeHotkeyAction(tool, {
          sendKeys: (keys) => nativeClient.sendHotkey(keys),
          waitForForegroundRecovery
        });
        return;
      case 'url':
        await executeUrlAction(tool, selectedText, urlLogger);
        return;
      case 'ai':
        await (await getAiWindowManager()).openTranslation({
          text: selectedText,
          providerId: tool.provider_id,
          providerIds: Array.isArray(tool.provider_ids) ? tool.provider_ids : [],
          translationTargets: Array.isArray(tool.translation_targets) ? tool.translation_targets : [],
          prompt: typeof tool.prompt === 'string' ? tool.prompt : '',
          anchorBounds: createAnchorBoundsFromPoint(anchorPoint) || popupBounds
        });
        return;
      default:
        throw new Error(`不支持的工具类型：${tool.type}`);
    }
  } catch (error) {
    appLogger.error('tool', 'Tool execution failed.', error);
    throw error;
  }
}

async function decorateToolForUi(tool) {
  try {
    const iconService = await getIconService();
    const icon = await iconService.resolveToolIcon(tool);
    return {
      ...tool,
      icon_url: icon.url,
      icon_kind: icon.kind || 'icon'
    };
  } catch (error) {
    appLogger.warn('icons', 'Failed to resolve tool icon.', {
      toolId: tool?.id,
      iconName: tool?.icon,
      error: error instanceof Error ? error.message : String(error)
    });
    return { ...tool };
  }
}

async function refreshVisiblePopupTools() {
  if (!popupManager.isVisible()) {
    return;
  }

  const tools = await decorateToolsForUi(getEnabledTools());
  popupManager.updateTools(tools);
}

function queuePopupToolIconFetch(tool) {
  if (tool?.type !== 'url' || tool?.auto_fetch_favicon === false) {
    return;
  }

  void getIconService()
    .then((iconService) => iconService.downloadToolIcon(tool))
    .then(() => refreshVisiblePopupTools())
    .catch(() => {});
}

async function decorateToolsForUi(tools) {
  return Promise.all((tools || []).map((tool) => decorateToolForUi(tool)));
}

function createTray() {
  const trayImage = nativeImage.createFromPath(resolveAssetPath('tray-icon.png'));
  tray = new Tray(trayImage.isEmpty() ? nativeImage.createEmpty() : trayImage);

  tray.setToolTip(APP_NAME);
  refreshTrayMenu();
  tray.on('double-click', () => {
    void settingsWindowManager.open();
  });
}

function registerIpc() {
  ipcMain.handle('popup:get-tools', async () => {
    const tools = getEnabledTools();

    for (const tool of tools) {
      queuePopupToolIconFetch(tool);
    }

    return decorateToolsForUi(tools);
  });
  ipcMain.handle('popup:execute-tool', async (_event, payload) => executeTool(payload));
  ipcMain.on('popup:activity', (_event, payload) => {
    popupManager.noteActivity(payload);
  });
  ipcMain.handle('settings:get-config', () => getConfig());
  ipcMain.handle('settings:save-config', async (_event, nextConfig) => {
    return commitConfig(nextConfig, {
      startupFailureMode: 'throw'
    });
  });
  ipcMain.handle('settings:test-provider', async (_event, provider) =>
    testProviderConnectionLazy({
      ...provider,
      proxy: resolveProviderProxy(provider?.proxy, getConfig().selection?.proxy)
    })
  );
  ipcMain.handle('settings:test-webdav', async (_event, webdavConfig) =>
    (await getWebDavSyncService()).testConnection(webdavConfig)
  );
  ipcMain.handle('settings:sync-webdav-now', async (_event, webdavDraft = null) => {
    let preferredConfig = getConfig();

    if (webdavDraft && typeof webdavDraft === 'object') {
      const nextConfig = deepClone(preferredConfig);
      nextConfig.sync = {
        ...(nextConfig.sync || {}),
        webdav: {
          ...(nextConfig.sync?.webdav || {}),
          ...webdavDraft
        }
      };
      preferredConfig = await commitConfig(nextConfig, {
        preserveMetaTimestamp: true,
        refreshRuntime: false,
        scheduleSyncUpload: false,
        successLogContext: null
      });
    }

    return (await getWebDavSyncService()).syncNow({
      reason: 'manual',
      preferredConfig
    });
  });
  ipcMain.handle('settings:start-hotkey-record', async () => helperRuntime.startHotkeyRecord());
  ipcMain.handle('settings:stop-hotkey-record', () => helperRuntime.stopHotkeyRecord());
  ipcMain.handle('settings:get-diagnostics', async () => helperRuntime.requestDiagnostics());
  ipcMain.handle('settings:list-installed-apps', async () => listInstalledApps());
  ipcMain.handle('settings:pick-exe-path', async (event) => {
    const browserWindow = BrowserWindow.fromWebContents(event.sender) || undefined;
    const result = await dialog.showOpenDialog(browserWindow, {
      title: '选择程序 EXE',
      properties: ['openFile'],
      filters: [
        { name: 'Executable', extensions: ['exe'] }
      ]
    });

    if (result.canceled || !result.filePaths?.[0]) {
      return null;
    }

    const exePath = String(result.filePaths[0] || '').trim();
    const fileName = exePath.split(/[\\/]/u).pop() || '';

    return {
      exe_path: exePath,
      process_name: fileName.toLowerCase(),
      label: fileName.replace(/\.exe$/iu, '') || fileName
    };
  });
  ipcMain.handle('settings:list-icon-names', async () => (await getIconService()).listIconNames());
  ipcMain.handle('settings:resolve-icon', async (_event, iconName) => (await getIconService()).resolveIcon(iconName));
  ipcMain.handle('settings:download-icon', async (_event, iconName) => (await getIconService()).downloadIcon(iconName));
  ipcMain.handle('settings:resolve-tool-icon', async (_event, tool) => (await getIconService()).resolveToolIcon(tool));
  ipcMain.handle('settings:download-tool-icon', async (_event, tool) => (await getIconService()).downloadToolIcon(tool));
  ipcMain.handle('settings:open-external', async (_event, url) => shell.openExternal(String(url || '')));
  ipcMain.handle('settings:open-logs-directory', async () => {
    const result = await shell.openPath(portablePaths.logs);

    if (result) {
      throw new Error(result);
    }

    return true;
  });
  ipcMain.handle('ai:start', async (_event, payload) =>
    (await getAiWindowManager()).openTranslation({
      text: payload.text,
      providerId: payload.providerId,
      providerIds: payload.providerIds || [],
      translationTargets: payload.translationTargets || [],
      prompt: payload.prompt || '',
      anchorBounds: payload.anchorBounds || null
    })
  );
  ipcMain.handle('ai:copy-text', async (_event, payload) => {
    const text = String(payload?.text || '');
    const kind = String(payload?.kind || 'text');

    if (!text.trim()) {
      return false;
    }

    try {
      clipboard.writeText(text);
      appLogger.info('ai-copy', 'AI output copied to clipboard.', {
        copyType: kind,
        textLength: text.length
      });
      return true;
    } catch (error) {
      appLogger.error('ai-copy', 'Failed to copy AI output to clipboard.', {
        copyType: kind,
        message: error instanceof Error ? error.message : String(error)
      });
      throw error;
    }
  });
  ipcMain.handle('ai:render-markdown', async (_event, payload) => {
    const markdown = String(payload?.markdown || '');
    const meta = payload?.meta || {};

    try {
      const html = await renderMarkdownToHtmlLazy(markdown);

      if (meta?.silent !== true && meta?.completed === true) {
        appLogger.info('ai-markdown', 'AI markdown rendered successfully.', {
          targetId: meta?.targetId || meta?.providerId || '',
          textLength: markdown.length
        });
      }

      return html;
    } catch (error) {
      appLogger.error('ai-markdown', 'AI markdown render failed.', {
        targetId: meta?.targetId || meta?.providerId || '',
        textLength: markdown.length,
        message: error instanceof Error ? error.message : String(error)
      });
      throw error;
    }
  });
  ipcMain.handle('ai:retry', async (event, providerId) => (await getAiWindowManager()).retry(event.sender, providerId));
  ipcMain.handle('ai:abort', async (event, providerId) => (await getAiWindowManager()).abort(event.sender, providerId));
  ipcMain.on('ai:ui-diagnostic', (_event, payload) => {
    if (payload?.type === 'copy-action') {
      appLogger.info('ai-ui', 'AI window UI event.', payload);
      return;
    }

    if (payload?.type === 'copy-failed') {
      appLogger.warn('ai-ui', 'AI window copy failed.', payload);
      return;
    }

    if (payload?.type === 'markdown-render-failed') {
      appLogger.warn('ai-ui', 'AI window markdown render fell back to plain text.', payload);
      return;
    }

    appLogger.warn('ai-ui', 'AI window UI diagnostic.', payload);
  });
  ipcMain.handle('window:resize', async (event, nextBounds) => (await getAiWindowManager()).resize(event.sender, nextBounds));
  ipcMain.handle('window:pin-toggle', async (event) => (await getAiWindowManager()).togglePin(event.sender));
  ipcMain.handle('window:minimize', (event) => {
    BrowserWindow.fromWebContents(event.sender)?.minimize();
  });
  ipcMain.handle('window:close', (event) => {
    BrowserWindow.fromWebContents(event.sender)?.close();
  });
}

function startHookWorker() {
  hookWorker = new Worker(new URL('./hook.js', import.meta.url), { type: 'module' });
  hookWorker.on('message', (message) => {
    try {
      const hookPoint =
        typeof message.x === 'number' && typeof message.y === 'number'
          ? normalizeHookPoint({ x: message.x, y: message.y })
          : null;
      const point = captureLiveCursorDip(hookPoint);

      if (message.type === 'mouseup' && point) {
        rememberMouseReleaseAnchor(point);
      }

      if (!popupManager.isVisible()) {
        return;
      }

      if (message.type === 'mouseup') {
        if (popupManager.wasRecentlyShown()) {
          return;
        }

        if (point && !popupManager.containsPoint(point)) {
          appLogger.info('popup', 'Popup hidden by outside mouseup.', { point });
          popupManager.hide();
        }
        return;
      }

      if (message.type === 'escape') {
        appLogger.info('popup', 'Popup hidden by Escape.');
        popupManager.hide();
      }
    } catch (error) {
      appLogger.error('popup', 'Hook worker message handling failed.', error);
    }
  });
  hookWorker.on('error', (error) => {
    appLogger.error('popup', 'Hook worker failed.', error);
  });
}

function registerNativeEvents() {
  nativeClient.on('selection-found', async (payload = {}) => {
    const diagnostics = payload.diagnostics || {};
    if (hasBlockedRiskDiagnostics(diagnostics)) {
      appLogger.info('selection', 'Skipped popup because helper blocked a high-risk foreground.', {
        category: diagnostics.blockedRiskCategory,
        signal: diagnostics.blockedRiskSignal,
        processName: diagnostics.processName,
        processPath: diagnostics.processPath
      });
      return;
    }
    const flowId = selectionPopupController.beginFlow();
    try {
      await handleRecoveredSelection({
        helperText: payload.text,
        diagnostics,
        strategy: payload.strategy || diagnostics?.lastStrategy || '',
        mouse: payload.mouse || { x: 0, y: 0 },
        anchorRect: payload.anchorRect || null,
        flowId
      });
    } catch (error) {
      appLogger.error('popup', 'Failed to show popup from native helper.', error);
    }
  });

  nativeClient.on('hotkey-record-state', (payload) => {
    appLogger.info('hotkey', 'Hotkey recorder state updated.', payload);
    void helperRuntime.handleHotkeyRecordState(payload);
  });

  nativeClient.on('diagnostics', (payload) => {
    if (payload?.connected === false) {
      selectionPopupController.invalidate();
    }
    void helperRuntime.handleHelperDiagnostics(payload);
    if (payload?.connected === false && !globalEnabled) {
      return;
    }
    void syncDiagnosticsSnapshot(payload);
  });

  nativeClient.on('selection-failed', (payload) => {
    const diagnostics = payload?.diagnostics || payload || {};
    if (hasBlockedRiskDiagnostics(diagnostics)) {
      appLogger.info('selection', 'Skipped recovery because helper blocked a high-risk foreground.', {
        category: diagnostics.blockedRiskCategory,
        signal: diagnostics.blockedRiskSignal,
        processName: diagnostics.processName,
        processPath: diagnostics.processPath
      });
      return;
    }
    const flowId = selectionPopupController.beginFlow();
    appLogger.warn('selection', 'Selection read failed.', diagnostics);
    void handleRecoveredSelection({
      helperText: '',
      diagnostics,
      strategy: diagnostics?.lastStrategy || '',
      mouse: null,
      anchorRect: null,
      flowId
    }).catch((error) => {
      appLogger.error('selection', 'Selection recovery after helper failure failed.', error);
    });
  });
}

app.on('second-instance', () => {
  void settingsWindowManager.open();
});

app.on('window-all-closed', (event) => {
  if (!quitting) {
    event.preventDefault();
  }
});

app.whenReady().then(async () => {
  const config = initConfigStore(portablePaths);
  appLogger.setEnabled(config.logging?.enabled === true);
  appLogger.info('app', 'Application ready.', {
    portableRoot: portablePaths.root,
    loggingEnabled: config.logging?.enabled === true
  });
  registerIpc();
  registerNativeEvents();
  createTray();
  startHookWorker();
  screen.on('display-metrics-changed', handleDisplayMetricsChanged);
  await applyLaunchOnBoot(config);
  try {
    await nativeClient.start(config);
  } catch (error) {
    appLogger.error('native-helper', 'Native helper failed during application startup.', error);
    appendStartupFailureLog('Native helper failed during application startup.', error);
    dialog.showErrorBox(
      'SelectPop 启动异常',
      [
        '原生 helper 或其运行库缺失/启动失败。',
        '请确认便携包已完整解压，并检查启动日志：',
        `${portablePaths.logs}\\${STARTUP_LOG_FILE_NAME}`,
        '',
        error instanceof Error ? error.message : String(error)
      ].join('\n')
    );
    app.quit();
    return;
  }
  refreshTrayMenu(config);
  scheduleStartupIdleSample();
  triggerStartupWebDavSync();

  const foregroundWindow = await getForegroundWindow();

  if (foregroundWindow?.owner?.processId === process.pid) {
    await settingsWindowManager.open();
  }
}).catch((error) => {
  appLogger.error('app', 'Application bootstrap failed.', error);
});

app.on('before-quit', () => {
  quitting = true;
  appLogger.info('app', 'Application is shutting down.');
  if (startupMemorySampleTimer) {
    clearTimeout(startupMemorySampleTimer);
    startupMemorySampleTimer = null;
  }
  clearAiWarmCleanupTimer();
  if (markdownRendererReleaseTimer) {
    clearTimeout(markdownRendererReleaseTimer);
    markdownRendererReleaseTimer = null;
  }
  markdownRendererPromise = null;
  screen.removeListener('display-metrics-changed', handleDisplayMetricsChanged);
  popupManager.dispose();
  aiWindowManager?.dispose?.();
  translationCache?.dispose?.();
  if (aiRuntimeModule) {
    void aiRuntimeModule.releaseAiRuntime?.();
  }
  hookWorker?.terminate();
  void nativeClient.dispose();
});
