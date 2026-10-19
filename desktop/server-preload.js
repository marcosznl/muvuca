// Janela "Endereço do servidor" do app: mostra o endereço atual e troca por outro
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('servidor', {
  info: () => ipcRenderer.invoke('server:info'),
  save: (url) => ipcRenderer.invoke('server:save', String(url ?? '')),
  close: () => ipcRenderer.send('server:close'),
});
