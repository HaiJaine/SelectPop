import { BrowserWindow, screen } from 'electron';
import { resolveAppFile } from './paths.js';
import { PopupAutoHideController, normalizeAutoHideDelay } from './popup-auto-hide.js';
import { buildToolbarMetrics } from '../shared/toolbar-metrics.js';
import { calcPopupPositionForDisplay, calcPopupWidth } from './popup-layout.js';

const DEFAULT_DESTROY_AFTER_IDLE_MS = 60_000;

export function calcPopupPosition(
  mousePoint,
  winWidth,
  metrics,
  toolbarOffset = { x: 0, y: 0 }
) {
  const display = screen.getDisplayNearestPoint(mousePoint);
  return calcPopupPositionForDisplay(
    mousePoint,
    winWidth,
    metrics,
    display.workArea,
    toolbarOffset,
    display.scaleFactor
  );
}

function normalizePoint(point) {
  if (!point) {
    return null;
  }

  if (typeof screen.screenToDipPoint === 'function') {
    return screen.screenToDipPoint({ x: point.x, y: point.y });
  }

  return { x: point.x, y: point.y };
}

function normalizeAnchorRect(anchorRect) {
  if (!anchorRect) {
    return null;
  }

  const topLeft = normalizePoint({ x: anchorRect.left, y: anchorRect.top });
  const bottomRight = normalizePoint({ x: anchorRect.right, y: anchorRect.bottom });

  if (!topLeft || !bottomRight) {
    return null;
  }

  return {
    left: Math.min(topLeft.x, bottomRight.x),
    top: Math.min(topLeft.y, bottomRight.y),
    right: Math.max(topLeft.x, bottomRight.x),
    bottom: Math.max(topLeft.y, bottomRight.y)
  };
}

export class PopupManager {
  constructor(getConfig, { logger = null, destroyAfterIdleMs = DEFAULT_DESTROY_AFTER_IDLE_MS } = {}) {
    this.getConfig = getConfig;
    this.logger = logger;
    this.destroyAfterIdleMs = destroyAfterIdleMs;
    this.window = null;
    this.readyPromise = null;
    this.context = null;
    this.destroyTimer = null;
    this.autoHideController = new PopupAutoHideController({
      onTimeout: () => {
        if (!this.window || this.window.isDestroyed() || !this.window.isVisible()) {
          return;
        }

        this.logger?.info?.('Auto-hiding popup after configured timeout.', {
          autoHideMs: this.getAutoHideDelayMs()
        });
        this.hide();
      }
    });
  }

  getAutoHideDelayMs() {
    const seconds = Number(this.getConfig?.()?.selection?.toolbar_auto_hide_seconds ?? 0);
    return normalizeAutoHideDelay(seconds > 0 ? seconds * 1000 : 0);
  }

  getToolbarMetrics() {
    return buildToolbarMetrics(this.getConfig?.()?.selection);
  }

  async ensureWindow() {
    this.clearDestroyTimer();

    if (this.window && !this.window.isDestroyed()) {
      return this.window;
    }

    this.logger?.info?.('Creating popup BrowserWindow.', {
      destroyAfterIdleMs: this.destroyAfterIdleMs
    });
    this.window = new BrowserWindow({
      width: 10,
      height: this.getToolbarMetrics().windowHeight,
      useContentSize: true,
      frame: false,
      transparent: true,
      show: false,
      skipTaskbar: true,
      resizable: false,
      movable: false,
      focusable: false,
      alwaysOnTop: true,
      hasShadow: false,
      type: 'toolbar',
      webPreferences: {
        preload: resolveAppFile('preload', 'popup.cjs'),
        contextIsolation: true,
        nodeIntegration: false,
        spellcheck: false
      }
    });

    this.window.setAlwaysOnTop(true, 'screen-saver');
    this.window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    this.window.on('closed', () => {
      this.logger?.info?.('Popup BrowserWindow destroyed.');
      this.clearDestroyTimer();
      this.autoHideController.hide();
      this.window = null;
      this.readyPromise = null;
      this.context = null;
    });

    this.readyPromise = this.window.loadFile(resolveAppFile('renderer', 'popup', 'index.html'));
    await this.readyPromise;
    return this.window;
  }

  async show({
    selectedText,
    tools,
    mouse,
    anchorPoint = null,
    anchorSource = '',
    anchorRect = null,
    strategy = ''
  }) {
    this.clearDestroyTimer();
    const window = await this.ensureWindow();
    const metrics = this.getToolbarMetrics();
    const width = calcPopupWidth(tools.length, metrics);
    const height = metrics.windowHeight;
    const helperMouseDip = normalizePoint(mouse) || null;
    const resolvedAnchorPoint =
      anchorPoint && Number.isFinite(anchorPoint.x) && Number.isFinite(anchorPoint.y)
        ? { x: anchorPoint.x, y: anchorPoint.y }
        : screen.getCursorScreenPoint();
    const normalizedAnchorRect = normalizeAnchorRect(anchorRect);
    const toolbarOffset = this.getConfig?.()?.selection?.toolbar_offset || { x: 0, y: 0 };
    const position = calcPopupPosition(
      resolvedAnchorPoint,
      width,
      metrics,
      toolbarOffset
    );

    this.context = {
      selectedText,
      tools,
      mouse: helperMouseDip,
      anchorPoint: resolvedAnchorPoint,
      anchorSource: anchorSource || 'live-cursor-dip',
      anchorRect: normalizedAnchorRect,
      strategy,
      metrics,
      anchorType: 'mouse-lower-right',
      usedAnchorRect: false,
      bounds: position.visibleBounds,
      windowBounds: { x: position.x, y: position.y, width, height },
      helperLiveDelta:
        helperMouseDip && resolvedAnchorPoint
          ? {
              x: helperMouseDip.x - resolvedAnchorPoint.x,
              y: helperMouseDip.y - resolvedAnchorPoint.y
            }
          : null,
      displayScaleFactor: position.displayScaleFactor,
      shownAt: Date.now()
    };

    window.setBounds({ x: position.x, y: position.y, width, height });
    window.webContents.send('popup:state', {
      tools,
      selectedText,
      metrics
    });
    window.showInactive();
    window.moveTop();
    this.autoHideController.show(this.getAutoHideDelayMs());

    return this.context;
  }

  updateTools(tools) {
    if (!this.window || this.window.isDestroyed() || !this.context) {
      return;
    }

    this.context = {
      ...this.context,
      tools,
      metrics: this.getToolbarMetrics()
    };

    const width = calcPopupWidth(tools.length, this.context.metrics);
    const height = this.context.metrics.windowHeight;
    const toolbarOffset = this.getConfig?.()?.selection?.toolbar_offset || { x: 0, y: 0 };
    const anchorPoint = this.context.anchorPoint || screen.getCursorScreenPoint();
    const position = calcPopupPosition(anchorPoint, width, this.context.metrics, toolbarOffset);
    this.context = {
      ...this.context,
      anchorPoint,
      bounds: position.visibleBounds,
      windowBounds: { x: position.x, y: position.y, width, height },
      displayScaleFactor: position.displayScaleFactor
    };
    this.window.setBounds({ x: position.x, y: position.y, width, height });
    this.window.webContents.send('popup:state', {
      tools,
      selectedText: this.context.selectedText,
      metrics: this.context.metrics
    });
  }

  hide() {
    if (!this.window || this.window.isDestroyed()) {
      return;
    }

    this.autoHideController.hide();
    this.window.hide();
    this.context = null;
    this.scheduleDestroyAfterIdle();
  }

  isVisible() {
    return Boolean(this.window && !this.window.isDestroyed() && this.window.isVisible());
  }

  containsPoint(point) {
    if (!this.context?.bounds) {
      return false;
    }

    const { x, y, width, height } = this.context.bounds;
    return point.x >= x && point.x <= x + width && point.y >= y && point.y <= y + height;
  }

  getSelectedText() {
    return this.context?.selectedText || '';
  }

  getBounds() {
    if (this.window && !this.window.isDestroyed()) {
      return this.context?.bounds || this.window.getBounds();
    }

    return this.context?.bounds || null;
  }

  handleDisplayMetricsChanged() {
    if (!this.window || this.window.isDestroyed() || !this.context) {
      return;
    }

    const metrics = this.getToolbarMetrics();
    const width = calcPopupWidth(this.context.tools.length, metrics);
    const height = metrics.windowHeight;
    const toolbarOffset = this.getConfig?.()?.selection?.toolbar_offset || { x: 0, y: 0 };
    const anchorPoint = this.context.anchorPoint || screen.getCursorScreenPoint();
    const position = calcPopupPosition(anchorPoint, width, metrics, toolbarOffset);

    this.context = {
      ...this.context,
      anchorPoint,
      metrics,
      bounds: position.visibleBounds,
      windowBounds: { x: position.x, y: position.y, width, height },
      displayScaleFactor: position.displayScaleFactor
    };
    this.window.setBounds({ x: position.x, y: position.y, width, height });
    this.window.webContents.send('popup:state', {
      tools: this.context.tools,
      selectedText: this.context.selectedText,
      metrics
    });
  }

  getContext() {
    return this.context;
  }

  noteActivity(payload = {}) {
    this.autoHideController.activity(String(payload?.type || 'interaction'), this.getAutoHideDelayMs());
  }

  wasRecentlyShown(windowMs = 250) {
    return Boolean(this.context?.shownAt && Date.now() - this.context.shownAt <= windowMs);
  }

  scheduleDestroyAfterIdle() {
    this.clearDestroyTimer();

    if (!this.window || this.window.isDestroyed()) {
      return;
    }

    this.destroyTimer = setTimeout(() => {
      this.destroyTimer = null;

      if (!this.window || this.window.isDestroyed() || this.window.isVisible()) {
        return;
      }

      this.logger?.info?.('Destroying idle popup BrowserWindow.', {
        idleMs: this.destroyAfterIdleMs
      });
      this.window.destroy();
    }, this.destroyAfterIdleMs);
  }

  clearDestroyTimer() {
    if (this.destroyTimer) {
      clearTimeout(this.destroyTimer);
      this.destroyTimer = null;
    }
  }

  dispose() {
    this.clearDestroyTimer();
    this.autoHideController.dispose();
    this.context = null;

    if (this.window && !this.window.isDestroyed()) {
      this.window.destroy();
    }

    this.window = null;
    this.readyPromise = null;
  }
}
