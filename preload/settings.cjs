const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('settingsApi', {
  getConfig: () => ipcRenderer.invoke('settings:get-config'),
  saveConfig: (config) => ipcRenderer.invoke('settings:save-config', config),
  testProvider: (provider) => ipcRenderer.invoke('settings:test-provider', provider),
  testWebDav: (webdavConfig) => ipcRenderer.invoke('settings:test-webdav', webdavConfig),
  syncWebDavNow: (webdavConfig) => ipcRenderer.invoke('settings:sync-webdav-now', webdavConfig),
  listIconNames: () => ipcRenderer.invoke('settings:list-icon-names'),
  resolveIcon: (iconName) => ipcRenderer.invoke('settings:resolve-icon', iconName),
  downloadIcon: (iconName) => ipcRenderer.invoke('settings:download-icon', iconName),
  openExternal: (url) => ipcRenderer.invoke('settings:open-external', url),
  startHotkeyRecord: () => ipcRenderer.invoke('settings:start-hotkey-record'),
  stopHotkeyRecord: () => ipcRenderer.invoke('settings:stop-hotkey-record'),
  getDiagnostics: () => ipcRenderer.invoke('settings:get-diagnostics'),
  listInstalledApps: () => ipcRenderer.invoke('settings:list-installed-apps'),
  pickExePath: () => ipcRenderer.invoke('settings:pick-exe-path'),
  resolveToolIcon: (tool) => ipcRenderer.invoke('settings:resolve-tool-icon', tool),
  downloadToolIcon: (tool) => ipcRenderer.invoke('settings:download-tool-icon', tool),
  openLogsDirectory: () => ipcRenderer.invoke('settings:open-logs-directory'),
  minimizeWindow: () => ipcRenderer.invoke('window:minimize'),
  closeWindow: () => ipcRenderer.invoke('window:close'),
  onConfig: (listener) => {
    const wrapped = (_event, payload) => listener(payload);
    ipcRenderer.on('settings:config', wrapped);
    return () => ipcRenderer.removeListener('settings:config', wrapped);
  },
  onHotkeyRecordState: (listener) => {
    const wrapped = (_event, payload) => listener(payload);
    ipcRenderer.on('settings:hotkey-record-state', wrapped);
    return () => ipcRenderer.removeListener('settings:hotkey-record-state', wrapped);
  },
  onDiagnostics: (listener) => {
    const wrapped = (_event, payload) => listener(payload);
    ipcRenderer.on('settings:diagnostics', wrapped);
    return () => ipcRenderer.removeListener('settings:diagnostics', wrapped);
  },
  onIconResolved: (listener) => {
    const wrapped = (_event, payload) => listener(payload);
    ipcRenderer.on('settings:icon-resolved', wrapped);
    return () => ipcRenderer.removeListener('settings:icon-resolved', wrapped);
  },
  onIconFailed: (listener) => {
    const wrapped = (_event, payload) => listener(payload);
    ipcRenderer.on('settings:icon-failed', wrapped);
    return () => ipcRenderer.removeListener('settings:icon-failed', wrapped);
  }
});
