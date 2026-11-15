const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('api', {
  price: t => ipcRenderer.invoke('price', t),
  scan: t => ipcRenderer.invoke('scan', t)
});
