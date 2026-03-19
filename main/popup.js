import { BrowserWindow, screen } from 'electron';
import { resolveAppFile } from './paths.js';
import { PopupAutoHideController, normalizeAutoHideDelay } from './popup-auto-hide.js';

const TOOL_BUTTON_SIZE = 36;
const TOOLBAR_GAP = 4;
const TOOLBAR_PADDING = 6;
const TOOLBAR_SHELL_PADDING = 4;
const TOOLTIP_SAFE_HEIGHT = 70;
const TOOLBAR_INNER_HEIGHT = TOOLBAR_PADDING * 2 + TOOL_BUTTON_SIZE;
const TOOLBAR_WINDOW_HEIGHT = TOOLBAR_SHELL_PADDING * 2 + TOOLBAR_INNER_HEIGHT + TOOLTIP_SAFE_HEIGHT;
const POPUP_MOUSE_GAP_X = 10;
const POPUP_MOUSE_GAP_Y = 8;

const DEFAULT_DESTROY_AFTER_IDLE_MS = 60_000;

function calcPopupWidth(toolCount) {
  const buttonWidth = toolCount * TOOL_BUTTON_SIZE;
  const gapWidth = Math.max(0, toolCount - 1) * TOOLBAR_GAP;
  const chromeWidth = TOOLBAR_SHELL_PADDING * 2 + TOOLBAR_PADDING * 2;
  return Math.max(TOOLBAR_INNER_HEIGHT, chromeWidth + buttonWidth + gapWidth);
}

function clampHorizontal(left, displayX, displayWidth, visibleWidth) {
  let nextLeft = left;

  if (nextLeft < displayX) {
    nextLeft = displayX + 4;
  }

  if (nextLeft + visibleWidth > displayX + displayWidth) {
    nextLeft = displayX + displayWidth - visibleWidth - 4;
  }

  return nextLeft;
}

function clampVertical(top, displayY, displayHeight, visibleHeight) {
  let nextTop = top;

  if (nextTop < displayY) {
    nextTop = displayY + 4;
  }

  if (nextTop + visibleHeight > displayY + displayHeight) {
    nextTop = displayY + displayHeight - visibleHeight - 4;
  }

  return nextTop;
}

export function calcPopupPosition(
  mousePoint,
  winWidth,
  windowHeight,
  toolbarOffset = { x: 0, y: 0 }
) {
  const display = screen.getDisplayNearestPoint(mousePoint);
  const { x, y, width, height } = display.workArea;
  const offsetX = Number.isFinite(Number(toolbarOffset?.x)) ? Number(toolbarOffset.x) : 0;
  const offsetY = Number.isFinite(Number(toolbarOffset?.y)) ? Number(toolbarOffset.y) : 0;
  const visibleWidth = Math.max(1, winWidth - TOOLBAR_SHELL_PADDING * 2);
  const visibleHeight = TOOLBAR_INNER_HEIGHT;

  let visibleLeft = Math.round(mousePoint.x + POPUP_MOUSE_GAP_X + offsetX);
  let visibleTop = Math.round(mousePoint.y + POPUP_MOUSE_GAP_Y + offsetY);

  visibleLeft = clampHorizontal(visibleLeft, x, width, visibleWidth);
  visibleTop = clampVertical(visibleTop, y, height, visibleHeight);

  return {
    x: Math.round(visibleLeft - TOOLBAR_SHELL_PADDING),
    y: Math.round(visibleTop - TOOLBAR_SHELL_PADDING),
    visibleBounds: {
      x: visibleLeft,
      y: visibleTop,
      width: visibleWidth,
      height: visibleHeight
    },
    displayScaleFactor: display.scaleFactor
  };
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
      height: TOOLBAR_WINDOW_HEIGHT,
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
    const width = calcPopupWidth(tools.length);
    const height = TOOLBAR_WINDOW_HEIGHT;
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
      height,
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
      selectedText
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
      tools
    };

    this.window.webContents.send('popup:state', {
      tools,
      selectedText: this.context.selectedText
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

    const width = calcPopupWidth(this.context.tools.length);
    const height = TOOLBAR_WINDOW_HEIGHT;
    const toolbarOffset = this.getConfig?.()?.selection?.toolbar_offset || { x: 0, y: 0 };
    const anchorPoint = this.context.anchorPoint || screen.getCursorScreenPoint();
    const position = calcPopupPosition(anchorPoint, width, height, toolbarOffset);

    this.context = {
      ...this.context,
      anchorPoint,
      bounds: position.visibleBounds,
      windowBounds: { x: position.x, y: position.y, width, height },
      displayScaleFactor: position.displayScaleFactor
    };
    this.window.setBounds({ x: position.x, y: position.y, width, height });
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
