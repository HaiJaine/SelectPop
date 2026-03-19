const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('popupApi', {
  getTools: () => ipcRenderer.invoke('popup:get-tools'),
  executeTool: (payload) => ipcRenderer.invoke('popup:execute-tool', payload),
  notifyActivity: (payload) => ipcRenderer.send('popup:activity', payload),
  onState: (listener) => {
    const wrapped = (_event, payload) => listener(payload);
    ipcRenderer.on('popup:state', wrapped);
    return () => ipcRenderer.removeListener('popup:state', wrapped);
  }
});
