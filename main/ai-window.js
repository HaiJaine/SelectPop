import { BrowserWindow, screen } from 'electron';
import { clamp, createId } from './utils.js';
import { resolveAppFile } from './paths.js';
import {
  clampWindowBoundsToDisplay,
  clampWindowBoundsToWorkArea,
  extractWindowBounds,
  normalizeWindowBounds
} from './window-bounds.js';
import { AI_SYSTEM_PROMPT } from './defaults.js';
import {
  AI_WINDOW_LAYER_FOREGROUND_TRANSIENT,
  AI_WINDOW_LAYER_NORMAL,
  AI_WINDOW_LAYER_PINNED_BACKGROUND,
  resolveAiWindowAlwaysOnTopLevel,
  shouldShowAiWindowOnAllWorkspaces
} from './ai-window-policy.js';

const AI_WINDOW_MOUSE_GAP_X = 12;
const AI_WINDOW_MOUSE_GAP_Y = 8;
const AI_WINDOW_COLLISION_SHIFT_X = 28;
const AI_WINDOW_COLLISION_SHIFT_Y = 22;
const AI_WINDOW_COLLISION_SHIFT_ATTEMPTS = 16;

function getAnchorPoint(anchorBounds) {
  const fallbackPoint = screen.getCursorScreenPoint();
  return anchorBounds || {
    x: fallbackPoint.x,
    y: fallbackPoint.y,
    width: 0,
    height: 0
  };
}

function calcAiWindowPosition(anchorBounds, requestedWidth, requestedHeight) {
  const anchor = getAnchorPoint(anchorBounds);
  const display = screen.getDisplayNearestPoint({ x: anchor.x, y: anchor.y });
  const { workArea } = display;

  let left = anchor.x + anchor.width + AI_WINDOW_MOUSE_GAP_X;
  let top = anchor.y + AI_WINDOW_MOUSE_GAP_Y;

  if (left + requestedWidth > workArea.x + workArea.width) {
    left = anchor.x + anchor.width - requestedWidth;
  }

  if (left < workArea.x) {
    left = workArea.x + 8;
  }

  if (top + requestedHeight > workArea.y + workArea.height) {
    top = workArea.y + workArea.height - requestedHeight - 8;
  }

  if (top < workArea.y) {
    top = workArea.y + 8;
  }

  return clampWindowBoundsToWorkArea(
    {
      x: Math.round(left),
      y: Math.round(top),
      width: requestedWidth,
      height: requestedHeight
    },
    workArea
  );
}

function isSameTopLeft(leftBounds, rightBounds) {
  return leftBounds.x === rightBounds.x && leftBounds.y === rightBounds.y;
}

function shiftBounds(bounds, offsetX, offsetY) {
  return {
    ...bounds,
    x: bounds.x + offsetX,
    y: bounds.y + offsetY
  };
}

function resolveEffectivePrompt(target, prompt) {
  if (target?.kind !== 'provider') {
    return '';
  }

  return String(prompt || target?.prompt || AI_SYSTEM_PROMPT).trim() || AI_SYSTEM_PROMPT;
}

function buildUiConfigPayload(config = {}) {
  return {
    aiWindowFontScale: Number(config?.ui?.aiWindowFontScale || 100)
  };
}

function buildWindowSessions(targets) {
  return targets.map((target) => ({
    targetId: target.id,
    targetName: target.name,
    targetKind: target.kind === 'service' ? 'service' : 'provider',
    model: target.kind === 'provider' ? target.model : target.driver
  }));
}

export class AiWindowManager {
  constructor(
    getConfig,
    getTranslationTargetByRef,
    {
      startTranslation,
      logger = null,
      saveBounds = null,
      translationCache = null,
      onStateChanged = null,
      onWindowFocus = null
    } = {}
  ) {
    this.getConfig = getConfig;
    this.getTranslationTargetByRef = getTranslationTargetByRef;
    this.startTranslation = startTranslation;
    this.logger = logger;
    this.saveBounds = saveBounds;
    this.translationCache = translationCache;
    this.onStateChanged = onStateChanged;
    this.onWindowFocus = onWindowFocus;
    this.records = new Map();
  }

  notifyStateChanged(reason = '') {
    this.onStateChanged?.({
      reason,
      windowCount: this.getWindowCount(),
      activeRequestCount: this.getActiveRequestCount()
    });
  }

  getWindowCount() {
    return Array.from(this.records.values())
      .filter((record) => record.window && !record.window.isDestroyed())
      .length;
  }

  getActiveRequestCount() {
    return Array.from(this.records.values())
      .reduce((total, record) => total + record.requests.size, 0);
  }

  canRelease() {
    return this.getWindowCount() === 0 && this.getActiveRequestCount() === 0;
  }

  isPresentationPinEnabled() {
    return this.getConfig()?.ui?.aiWindowPresentationPin === true;
  }

  getBaseLayer(record) {
    return record?.pinned === true ? AI_WINDOW_LAYER_PINNED_BACKGROUND : AI_WINDOW_LAYER_NORMAL;
  }

  syncPinnedWorkspaceVisibility(record) {
    if (!record?.window || record.window.isDestroyed()) {
      return;
    }

    const showOnAllWorkspaces = shouldShowAiWindowOnAllWorkspaces({
      pinned: record.pinned === true,
      presentationPin: this.isPresentationPinEnabled()
    });

    if (showOnAllWorkspaces) {
      record.window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
      return;
    }

    record.window.setVisibleOnAllWorkspaces(false);
  }

  applyLayer(record, layer, { moveTop = false } = {}) {
    if (!record?.window || record.window.isDestroyed()) {
      return;
    }

    record.layer = layer;
    const alwaysOnTopLevel = resolveAiWindowAlwaysOnTopLevel(layer, {
      pinned: record.pinned === true,
      presentationPin: this.isPresentationPinEnabled()
    });

    if (alwaysOnTopLevel) {
      record.window.setAlwaysOnTop(true, alwaysOnTopLevel);
    } else {
      record.window.setAlwaysOnTop(false);
    }

    this.syncPinnedWorkspaceVisibility(record);

    if (moveTop) {
      record.window.moveTop();
    }
  }

  restoreBaseLayer(record, options = {}) {
    this.applyLayer(record, this.getBaseLayer(record), options);
  }

  demoteForegroundRecords(excludeWindowId = null) {
    for (const record of this.records.values()) {
      if (!record?.window || record.window.isDestroyed() || record.window.webContents.id === excludeWindowId) {
        continue;
      }

      if (record.layer === AI_WINDOW_LAYER_FOREGROUND_TRANSIENT) {
        this.restoreBaseLayer(record);
      }
    }
  }

  promoteRecord(record, { moveTop = true } = {}) {
    if (!record?.window || record.window.isDestroyed()) {
      return;
    }

    this.demoteForegroundRecords(record.window.webContents.id);
    this.applyLayer(record, AI_WINDOW_LAYER_FOREGROUND_TRANSIENT, { moveTop });
  }

  getVisibleWindowBounds({ excludeWindowId = null } = {}) {
    return Array.from(this.records.values())
      .filter((record) =>
        record.window
        && !record.window.isDestroyed()
        && record.window.webContents.id !== excludeWindowId
        && record.window.isVisible()
      )
      .map((record) => extractWindowBounds(record.window));
  }

  getVisibleWindowBoundsForDisplay(display, { excludeWindowId = null } = {}) {
    return this.getVisibleWindowBounds({ excludeWindowId }).filter((bounds) => {
      const centerPoint = {
        x: bounds.x + Math.round(bounds.width / 2),
        y: bounds.y + Math.round(bounds.height / 2)
      };
      return screen.getDisplayNearestPoint(centerPoint).id === display.id;
    });
  }

  resolveWindowBounds(anchorBounds, requestedWidth, requestedHeight, excludeWindowId = null) {
    const anchor = getAnchorPoint(anchorBounds);
    const display = screen.getDisplayNearestPoint({ x: anchor.x, y: anchor.y });
    const occupiedBounds = this.getVisibleWindowBoundsForDisplay(display, { excludeWindowId });
    let nextBounds = calcAiWindowPosition(anchorBounds, requestedWidth, requestedHeight);

    for (let attempt = 0; attempt < AI_WINDOW_COLLISION_SHIFT_ATTEMPTS; attempt += 1) {
      const hasSameTopLeft = occupiedBounds.some((existingBounds) => isSameTopLeft(nextBounds, existingBounds));

      if (!hasSameTopLeft) {
        return nextBounds;
      }

      nextBounds = clampWindowBoundsToWorkArea(
        shiftBounds(nextBounds, AI_WINDOW_COLLISION_SHIFT_X, AI_WINDOW_COLLISION_SHIFT_Y)
        ,
        display.workArea
      );
    }

    return nextBounds;
  }

  positionRecordNearAnchor(record, anchorBounds) {
    if (!record?.window || record.window.isDestroyed()) {
      return;
    }

    const bounds = extractWindowBounds(record.window);
    const nextBounds = this.resolveWindowBounds(
      anchorBounds,
      bounds.width,
      bounds.height,
      record.window.webContents.id
    );

    record.suspendPersist = true;
    record.window.setBounds(nextBounds);
    setTimeout(() => {
      if (!record.window || record.window.isDestroyed()) {
        return;
      }

      record.suspendPersist = false;
    }, 0);
  }

  async createWindow(anchorBounds) {
    const config = this.getConfig();
    const requestedBounds = normalizeWindowBounds(config.ui.aiWindowBounds, {
      minWidth: 320,
      minHeight: 260,
      width: config.ui.aiWindowBounds.width,
      height: config.ui.aiWindowBounds.height
    });
    const positionedBounds = this.resolveWindowBounds(
      anchorBounds,
      requestedBounds.width,
      requestedBounds.height
    );
    const window = new BrowserWindow({
      ...positionedBounds,
      minWidth: 320,
      minHeight: 260,
      frame: false,
      show: false,
      resizable: true,
      movable: true,
      backgroundColor: '#f7f4ef',
      webPreferences: {
        preload: resolveAppFile('preload', 'ai-window.cjs'),
        contextIsolation: true,
        nodeIntegration: false,
        spellcheck: false
      }
    });

    const record = {
      window,
      pinned: false,
      layer: AI_WINDOW_LAYER_NORMAL,
      requests: new Map(),
      currentPayload: null,
      persistTimer: null,
      suspendPersist: true,
      blurCloseUntil: 0,
      readyPromise: window.loadFile(resolveAppFile('renderer', 'ai-window', 'index.html'))
    };

    this.records.set(window.webContents.id, record);
    this.notifyStateChanged('window-created');
    this.logger?.info('AI BrowserWindow created.', {
      windowId: window.webContents.id,
      bounds: positionedBounds
    });

    window.on('close', () => {
      this.flushPersist(record);
    });
    window.on('closed', () => {
      this.abortAll(record);
      if (record.persistTimer) {
        clearTimeout(record.persistTimer);
      }
      this.logger?.info('AI BrowserWindow closed.', {
        windowId: window.webContents.id
      });
      this.records.delete(window.webContents.id);
      this.notifyStateChanged('window-closed');
    });
    window.on('move', () => this.schedulePersist(record));
    window.on('resize', () => this.schedulePersist(record));
    window.on('focus', () => {
      if (record.window.isDestroyed()) {
        return;
      }

      this.promoteRecord(record, { moveTop: true });
      this.onWindowFocus?.();
    });
    window.on('blur', () => {
      if (record.window.isDestroyed()) {
        return;
      }

      if (Date.now() < record.blurCloseUntil) {
        return;
      }

      if (record.pinned) {
        this.restoreBaseLayer(record, { moveTop: this.isPresentationPinEnabled() });
        return;
      }

      if (this.getConfig()?.ui?.aiWindowCloseOnBlur !== true) {
        return;
      }

      record.window.close();
    });

    await record.readyPromise;
    window.webContents.send('ai:ui-config', buildUiConfigPayload(config));
    setTimeout(() => {
      record.suspendPersist = false;
    }, 0);
    return record;
  }

  getReusableRecord() {
    for (const record of this.records.values()) {
      if (!record.window.isDestroyed() && !record.pinned) {
        return record;
      }
    }

    return null;
  }

  getRecordByWebContents(webContents) {
    return this.records.get(webContents.id) || null;
  }

  async openTranslation({ text, providerId, providerIds = [], translationTargets = [], prompt = '', anchorBounds }) {
    const resolvedTargetRefs = Array.from(
      new Map(
        (
          Array.isArray(translationTargets) && translationTargets.length
            ? translationTargets
            : (Array.isArray(providerIds) && providerIds.length ? providerIds : [providerId]).map((id) => ({
                kind: 'provider',
                id
              }))
        )
          .map((target) => ({
            kind: target?.kind === 'service' ? 'service' : 'provider',
            id: String(target?.id || '').trim()
          }))
          .filter((target) => target.id)
          .map((target) => [`${target.kind}:${target.id}`, target])
      ).values()
    );

    const targets = resolvedTargetRefs
      .map((target) => this.getTranslationTargetByRef(target))
      .filter(Boolean);

    if (!targets.length) {
      throw new Error('未找到可用的翻译目标，请先在设置中配置。');
    }

    let record = this.getReusableRecord();

    if (!record) {
      record = await this.createWindow(anchorBounds);
    } else {
      this.positionRecordNearAnchor(record, anchorBounds);
    }

    this.abortAll(record);
    const sessionId = createId('ai-session');
    const promptText = String(prompt || '');
    record.currentPayload = {
      sessionId,
      text,
      activeTargetId: targets[0].id,
      orderedTargets: targets.map((target) => ({
        kind: target.kind,
        id: target.id
      })),
      sessions: targets.map((target) => ({
        targetId: target.id,
        targetKind: target.kind,
        prompt: promptText
      }))
    };

    record.blurCloseUntil = Date.now() + 450;
    this.promoteRecord(record, { moveTop: true });
    record.window.show();
    record.window.focus();
    this.notifyStateChanged('translation-opened');
    this.logger?.info('Opening AI translation window.', {
      sessionId,
      targetIds: targets.map((target) => `${target.kind}:${target.id}`),
      sessionCount: targets.length,
      activeTargetId: targets[0].id,
      textLength: text.length
    });
    record.window.webContents.send('ai:session', {
      sessionId,
      text,
      activeTargetId: targets[0].id,
      pinned: record.pinned,
      sessions: buildWindowSessions(targets)
    });

    for (const target of targets) {
      void this.startRequest(record, sessionId, target, text, promptText, {
        useCache: true,
        preserveExistingOnStart: false,
        orderedTargets: record.currentPayload.orderedTargets
      });
    }
  }

  async startRequest(
    record,
    sessionId,
    target,
    text,
    prompt,
    { attempt = 1, useCache = true, preserveExistingOnStart = false, orderedTargets = [] } = {}
  ) {
    if (!record || record.window.isDestroyed()) {
      return;
    }

    if (typeof this.startTranslation !== 'function') {
      throw new Error('Translation runner is not available.');
    }

    const previousRequest = record.requests.get(target.id);
    previousRequest?.abortController?.abort();

    const abortController = new AbortController();
    const startedAt = Date.now();
    record.requests.set(target.id, { abortController, sessionId, text, prompt });
    this.notifyStateChanged('request-started');

    const effectivePrompt = resolveEffectivePrompt(target, prompt);
    const cacheKey = this.translationCache?.createKey({
      text,
      target,
      orderedTargets,
      prompt: effectivePrompt
    });

    if (useCache && cacheKey) {
      const cachedEntry = this.translationCache?.get(cacheKey);

      if (cachedEntry?.markdown) {
        this.logger?.info('Translation cache hit.', {
          sessionId,
          targetId: target.id,
          targetKind: target.kind,
          textLength: text.length
        });
        this.#sendIfCurrent(record, sessionId, 'ai:stream-start', {
          targetId: target.id,
          targetName: target.name,
          targetKind: target.kind,
          model: target.kind === 'provider' ? target.model : target.driver,
          startedAt,
          attempt,
          cached: true,
          preserveExisting: false
        });
        this.#sendIfCurrent(record, sessionId, 'ai:chunk', {
          targetId: target.id,
          chunk: cachedEntry.markdown,
          cached: true
        });
        this.#sendIfCurrent(record, sessionId, 'ai:done', {
          targetId: target.id,
          timeMs: 0,
          tokens: cachedEntry.tokens || 0,
          cached: true
        });
        record.requests.delete(target.id);
        return;
      }
    }

    this.logger?.info('Starting translation request.', {
      sessionId,
      targetId: target.id,
      targetKind: target.kind,
      model: target.kind === 'provider' ? target.model : target.driver,
      textLength: text.length,
      attempt
    });
    this.#sendIfCurrent(record, sessionId, 'ai:stream-start', {
      targetId: target.id,
      targetName: target.name,
      targetKind: target.kind,
      model: target.kind === 'provider' ? target.model : target.driver,
      startedAt,
      attempt,
      preserveExisting: preserveExistingOnStart === true
    });
    let emittedMarkdown = '';
    let firstChunkAt = 0;

    try {
      await this.startTranslation(
        target,
        text,
        target.kind === 'provider' ? prompt : '',
        {
          onChunk: (chunk) => {
            if (!firstChunkAt) {
              firstChunkAt = Date.now();
              this.logger?.info('Translation first chunk received.', {
                sessionId,
                targetId: target.id,
                targetKind: target.kind,
                firstChunkMs: firstChunkAt - startedAt
              });
            }
            emittedMarkdown += chunk;
            this.#sendIfCurrent(record, sessionId, 'ai:chunk', {
              targetId: target.id,
              chunk
            });
          },
          onDone: (tokens) => {
            if (cacheKey && emittedMarkdown.trim()) {
              this.translationCache?.set(cacheKey, {
                targetId: target.id,
                targetKind: target.kind,
                targetName: target.name,
                orderedTargets,
                text,
                markdown: emittedMarkdown,
                tokens,
                model: target.kind === 'provider' ? target.model : target.driver
              });
            }
            this.logger?.info('Translation request completed.', {
              sessionId,
              targetId: target.id,
              targetKind: target.kind,
              timeMs: Date.now() - startedAt,
              tokens
            });
            this.#sendIfCurrent(record, sessionId, 'ai:done', {
              targetId: target.id,
              timeMs: Date.now() - startedAt,
              tokens
            });
          }
        },
        abortController.signal,
        {
          proxy: target.kind === 'service' ? this.getConfig()?.selection?.proxy : undefined
        }
      );
    } catch (error) {
      if (abortController.signal.aborted) {
        this.logger?.warn('Translation request aborted.', {
          sessionId,
          targetId: target.id,
          targetKind: target.kind
        });
        this.#sendIfCurrent(record, sessionId, 'ai:aborted', {
          targetId: target.id
        });
        return;
      }

      if (attempt === 1) {
        this.logger?.warn('Translation request failed, retrying.', {
          sessionId,
          targetId: target.id,
          targetKind: target.kind,
          message: error instanceof Error ? error.message : String(error)
        });
        this.#sendIfCurrent(record, sessionId, 'ai:retrying', {
          targetId: target.id,
          message: '首次请求失败，正在自动重试...'
        });
        await this.startRequest(record, sessionId, target, text, prompt, {
          attempt: 2,
          useCache: false,
          preserveExistingOnStart,
          orderedTargets
        });
        return;
      }

      this.logger?.error('Translation request failed.', {
        sessionId,
        targetId: target.id,
        targetKind: target.kind,
        message: error instanceof Error ? error.message : String(error)
      });
      this.#sendIfCurrent(record, sessionId, 'ai:error', {
        targetId: target.id,
        message: error instanceof Error ? error.message : String(error)
      });
    } finally {
      const activeRequest = record.requests.get(target.id);

      if (activeRequest?.abortController === abortController) {
        record.requests.delete(target.id);
        this.notifyStateChanged('request-finished');
      }
    }
  }

  async retry(webContents, targetId) {
    const record = this.getRecordByWebContents(webContents);

    if (!record?.currentPayload) {
      return;
    }

    const effectiveTargetId =
      String(targetId || '').trim() || record.currentPayload.activeTargetId || record.currentPayload.sessions[0]?.targetId;

    const session = record.currentPayload.sessions.find((item) => item.targetId === effectiveTargetId);

    if (!session) {
      throw new Error('翻译会话不存在。');
    }

    const target = this.getTranslationTargetByRef({
      kind: session.targetKind,
      id: session.targetId
    });

    if (!target) {
      throw new Error('翻译目标不存在。');
    }

    record.currentPayload.activeTargetId = session.targetId;
    await this.startRequest(record, record.currentPayload.sessionId, target, record.currentPayload.text, session.prompt, {
      attempt: 1,
      useCache: false,
      preserveExistingOnStart: true,
      orderedTargets: record.currentPayload.orderedTargets || []
    });
  }

  abort(webContents, targetId = null) {
    const record = this.getRecordByWebContents(webContents);

    if (!record) {
      return;
    }

    if (targetId) {
      record.requests.get(targetId)?.abortController?.abort();
      return;
    }

    this.abortAll(record);
  }

  abortAll(record) {
    if (!record) {
      return;
    }

    for (const request of record.requests.values()) {
      request.abortController?.abort();
    }

    record.requests.clear();
  }

  resize(webContents, nextBounds) {
    const record = this.getRecordByWebContents(webContents);

    if (!record) {
      return;
    }

    const bounds = record.window.getBounds();
    const width = clamp(Number(nextBounds?.width || bounds.width), 320, 960);
    const height = clamp(Number(nextBounds?.height || bounds.height), 260, 760);
    record.window.setSize(width, height);
  }

  togglePin(webContents) {
    const record = this.getRecordByWebContents(webContents);

    if (!record) {
      return false;
    }

    record.pinned = !record.pinned;
    if (record.window.isFocused() || record.layer === AI_WINDOW_LAYER_FOREGROUND_TRANSIENT) {
      this.promoteRecord(record, { moveTop: true });
    } else {
      this.restoreBaseLayer(record, { moveTop: true });
    }
    record.blurCloseUntil = Date.now() + 250;
    record.window.webContents.send('ai:pinned', { pinned: record.pinned });
    return record.pinned;
  }

  minimize(webContents) {
    const record = this.getRecordByWebContents(webContents);

    if (!record) {
      return;
    }

    record.blurCloseUntil = Date.now() + 250;
    record.window.minimize();
  }

  close(webContents) {
    this.getRecordByWebContents(webContents)?.window.close();
  }

  handleDisplayMetricsChanged() {
    for (const record of this.records.values()) {
      if (!record.window || record.window.isDestroyed()) {
        continue;
      }

      const nextBounds = clampWindowBoundsToDisplay(extractWindowBounds(record.window));
      record.window.setBounds(nextBounds);
      this.applyLayer(record, record.layer, {
        moveTop: record.pinned === true && this.isPresentationPinEnabled()
      });
      this.saveBounds?.(extractWindowBounds(record.window));
    }
  }

  syncUiConfig(config) {
    const payload = buildUiConfigPayload(config);

    for (const record of this.records.values()) {
      if (!record.window || record.window.isDestroyed()) {
        continue;
      }

      record.window.webContents.send('ai:ui-config', payload);
      this.applyLayer(record, record.layer, {
        moveTop: record.pinned === true && config?.ui?.aiWindowPresentationPin === true
      });
    }
  }

  dispose() {
    for (const record of this.records.values()) {
      this.abortAll(record);

      if (record.persistTimer) {
        clearTimeout(record.persistTimer);
        record.persistTimer = null;
      }

      if (record.window && !record.window.isDestroyed()) {
        record.window.destroy();
      }
    }

    this.records.clear();
    this.notifyStateChanged('disposed');
  }

  #sendIfCurrent(record, sessionId, channel, payload) {
    if (!record || record.window.isDestroyed()) {
      return;
    }

    if (record.currentPayload?.sessionId !== sessionId) {
      return;
    }

    record.window.webContents.send(channel, payload);
  }

  schedulePersist(record) {
    if (!record || record.suspendPersist || !record.window || record.window.isDestroyed()) {
      return;
    }

    if (record.persistTimer) {
      clearTimeout(record.persistTimer);
    }

    record.persistTimer = setTimeout(() => {
      this.flushPersist(record);
    }, 160);
  }

  flushPersist(record) {
    if (!record) {
      return;
    }

    if (record.persistTimer) {
      clearTimeout(record.persistTimer);
      record.persistTimer = null;
    }

    if (record.suspendPersist || !record.window || record.window.isDestroyed()) {
      return;
    }

    this.saveBounds?.(extractWindowBounds(record.window));
  }
}
