// Ponte entre o site do Muvuca e o app: o site descobre que está no app (window.muvucaDesktop)
// e usa o que o navegador sozinho não tem. Só funções pequenas e seguras passam por aqui.
const { contextBridge, ipcRenderer } = require('electron');

const listen = (channel) => (cb) => {
  const fn = (_e, ...args) => cb(...args);
  ipcRenderer.on(channel, fn);
  return () => ipcRenderer.removeListener(channel, fn);
};

contextBridge.exposeInMainWorld('muvucaDesktop', {
  isDesktop: true,
  platform: process.platform,
  info: () => ipcRenderer.invoke('app:info'),
  // Apertar para falar global: liga/desliga e avisa quando a tecla desce/sobe fora da janela
  setPushToTalk: (enabled, code) => ipcRenderer.invoke('ptt:set', { enabled: !!enabled, code: String(code ?? '') }),
  onPushToTalk: listen('ptt'),
  // Notificação nativa (clicar abre o canal)
  notify: (title, body, channelId, silent = false) => ipcRenderer.send('notify', { title, body, channelId, silent }),
  onOpenChannel: listen('open-channel'),
  // Ícone da barra de menus: mostrar o estado do microfone e alternar por lá
  setVoiceState: (s) => ipcRenderer.send('voice:state', { muted: !!s?.muted }),
  onToggleMute: listen('toggle-mute'),
});
