import { BrowserWindow } from 'electron';
import { resolveAppFile } from './paths.js';
import { clampWindowBoundsToDisplay, extractWindowBounds, normalizeWindowBounds } from './window-bounds.js';

export class SettingsWindowManager {
  constructor(getConfig, saveBounds) {
    this.getConfig = getConfig;
    this.saveBounds = saveBounds;
    this.window = null;
    this.readyPromise = null;
    this.persistTimer = null;
    this.suspendPersist = false;
  }

  async ensureWindow() {
    if (this.window && !this.window.isDestroyed()) {
      return this.window;
    }

    const config = this.getConfig();
    const normalizedBounds = normalizeWindowBounds(config.ui.settingsBounds, {
      minWidth: 720,
      minHeight: 560,
      width: config.ui.settingsBounds.width,
      height: config.ui.settingsBounds.height
    });
    const clampedBounds = clampWindowBoundsToDisplay(normalizedBounds);
    this.suspendPersist = true;

    this.window = new BrowserWindow({
      ...clampedBounds,
      minWidth: 720,
      minHeight: 560,
      frame: false,
      resizable: true,
      movable: true,
      show: false,
      backgroundColor: '#f2eee7',
      webPreferences: {
        preload: resolveAppFile('preload', 'settings.cjs'),
        contextIsolation: true,
        nodeIntegration: false,
        spellcheck: false
      }
    });

    this.window.on('closed', () => {
      this.window = null;
      this.readyPromise = null;
      if (this.persistTimer) {
        clearTimeout(this.persistTimer);
        this.persistTimer = null;
      }
    });
    this.window.on('move', () => this.schedulePersist());
    this.window.on('resize', () => this.schedulePersist());

    this.readyPromise = this.window.loadFile(resolveAppFile('renderer', 'settings', 'index.html'));
    await this.readyPromise;
    setTimeout(() => {
      this.suspendPersist = false;
    }, 0);
    this.window.webContents.send('settings:config', this.getConfig());
    return this.window;
  }

  async open() {
    const window = await this.ensureWindow();
    if (window.isMinimized()) {
      window.restore();
    }
    window.show();
    window.focus();
  }

  syncConfig(config) {
    if (!this.window || this.window.isDestroyed()) {
      return;
    }

    this.window.webContents.send('settings:config', config);
  }

  syncHotkeyRecordState(payload) {
    if (!this.window || this.window.isDestroyed()) {
      return;
    }

    this.window.webContents.send('settings:hotkey-record-state', payload);
  }

  syncDiagnostics(payload) {
    if (!this.window || this.window.isDestroyed()) {
      return;
    }

    this.window.webContents.send('settings:diagnostics', payload);
  }

  syncIconResolved(payload) {
    if (!this.window || this.window.isDestroyed()) {
      return;
    }

    this.window.webContents.send('settings:icon-resolved', payload);
  }

  syncIconFailed(payload) {
    if (!this.window || this.window.isDestroyed()) {
      return;
    }

    this.window.webContents.send('settings:icon-failed', payload);
  }

  minimize() {
    this.window?.minimize();
  }

  close() {
    this.window?.close();
  }

  handleDisplayMetricsChanged() {
    if (!this.window || this.window.isDestroyed()) {
      return;
    }

    const nextBounds = clampWindowBoundsToDisplay(extractWindowBounds(this.window));
    this.window.setBounds(nextBounds);
    this.saveBounds?.(extractWindowBounds(this.window));
  }

  schedulePersist() {
    if (this.suspendPersist || !this.window || this.window.isDestroyed()) {
      return;
    }

    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
    }

    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;

      if (!this.window || this.window.isDestroyed()) {
        return;
      }

      this.saveBounds?.(extractWindowBounds(this.window));
    }, 160);
  }
}
