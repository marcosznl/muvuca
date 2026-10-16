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
  opensFiles: true, // desde a 1.4.5: "nova aba" com arquivo do Muvuca abre no navegador
  platform: process.platform,
  macLook: process.platform === 'darwin', // desde a 1.4.7: janela translúcida com cara de app do Mac
  setAppearance: (mode, glass) => ipcRenderer.send('appearance', { mode: String(mode), glass: !!glass }),
  info: () => ipcRenderer.invoke('app:info'),
  // Apertar para falar global: liga/desliga e avisa quando a tecla desce/sobe fora da janela
  setPushToTalk: (enabled, code) => ipcRenderer.invoke('ptt:set', { enabled: !!enabled, code: String(code ?? '') }),
  onPushToTalk: listen('ptt'),
  // Notificação nativa (clicar abre o canal)
  notify: (title, body, channelId, silent = false) => ipcRenderer.send('notify', { title, body, channelId, silent }),
  onOpenChannel: listen('open-channel'),
  // Ícone da barra de menus: mostrar o estado do microfone e alternar por lá
  setVoiceState: (s) => ipcRenderer.send('voice:state', { muted: !!s?.muted, inCall: !!s?.inCall }),
  onToggleMute: listen('toggle-mute'),
  // Som da live no Mac (som só do app da janela transmitida, via ScreenCaptureKit)
  appAudioSupported: () => ipcRenderer.invoke('app-audio:supported'),
  wantAppAudio: (on) => ipcRenderer.send('app-audio:want', !!on),
  stopAppAudio: () => ipcRenderer.send('app-audio:stop'),
  onAppAudioData: listen('app-audio:data'),
  onAppAudioState: listen('app-audio:state'),
});
