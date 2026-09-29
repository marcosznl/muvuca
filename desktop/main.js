// Muvuca para Mac (Electron): uma janela com o site do Muvuca e o que o navegador não faz sozinho —
// apertar para falar com o app em segundo plano, ícone na barra de menus, contador no Dock,
// notificações nativas, abrir junto com o Mac e escolher tela/janela para a live.
const {
  app, BrowserWindow, Menu, Tray, Notification, desktopCapturer, ipcMain, nativeImage, session, shell, systemPreferences,
} = require('electron');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');
const fs = require('node:fs');

// Endereço do servidor: o link público por padrão; dá para trocar no menu (ex.: http://localhost:3000 em casa)
const DEFAULT_URL = 'https://seu-dominio.duckdns.org:8443';
const settingsFile = () => path.join(app.getPath('userData'), 'configuracoes.json');
function loadSettings() {
  let saved = {};
  try { saved = JSON.parse(fs.readFileSync(settingsFile(), 'utf8')); } catch {}
  // MUVUCA_URL (variável de ambiente) vence tudo: usado para testar contra outro servidor
  return { url: DEFAULT_URL, ...saved, ...(process.env.MUVUCA_URL ? { url: process.env.MUVUCA_URL } : {}) };
}
function saveSettings() { fs.writeFileSync(settingsFile(), JSON.stringify(settings, null, 2)); }
let settings = { url: DEFAULT_URL };
const origin = () => new URL(settings.url).origin;

let win = null;
let tray = null;
let quitting = false;

// Um app só aberto: abrir de novo traz a janela para frente
if (!app.requestSingleInstanceLock()) app.quit();
app.on('second-instance', () => showWindow());

function showWindow() {
  if (!win) return createWindow();
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

function createWindow() {
  win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 900,
    minHeight: 600,
    title: 'Muvuca',
    titleBarStyle: 'hiddenInset', // barra de título integrada, como no Discord
    trafficLightPosition: { x: 12, y: 8 }, // centralizados na faixa de 30 px do topo
    backgroundColor: '#1e1f22',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false, // a voz e os jogos continuam fluindo com a janela escondida
    },
  });
  win.once('ready-to-show', () => win.show());
  win.loadURL(settings.url);

  // Fechar a janela só esconde (a voz continua); sair de verdade é pelo menu ou ⌘Q
  win.on('close', (e) => {
    if (!quitting) { e.preventDefault(); win.hide(); }
  });
  win.on('closed', () => { win = null; });

  // Contador no Dock: o site já põe "(3) Muvuca" no título quando há não lidas
  win.on('page-title-updated', (_e, title) => {
    const n = Number(/^\((\d+)\)/.exec(title)?.[1] ?? 0);
    app.dock?.setBadge(n ? String(n) : '');
  });

  // Links para fora do Muvuca abrem no navegador; dentro, na própria janela
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (!url.startsWith(origin())) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith(origin())) { e.preventDefault(); shell.openExternal(url); }
  });

  // Sem internet ou servidor fora do ar: tela simples com "tentar de novo"
  win.webContents.on('did-fail-load', (_e, code, desc, url, isMainFrame) => {
    if (!isMainFrame || code === -3) return; // -3 = navegação cancelada (normal)
    win.loadFile(path.join(__dirname, 'offline.html'), { query: { url: settings.url, erro: desc } });
  });
}

// ---------- Permissões: microfone, câmera, notificações e tela só para o Muvuca ----------

function setupPermissions() {
  const ses = session.defaultSession;
  const trusted = (url) => { try { return new URL(url).origin === origin(); } catch { return false; } };
  const ALLOWED = new Set(['media', 'notifications', 'display-capture', 'fullscreen', 'clipboard-sanitized-write', 'speaker-selection', 'pointerLock']);
  ses.setPermissionRequestHandler(async (wc, permission, callback, details) => {
    if (!ALLOWED.has(permission) || !trusted(details.requestingUrl ?? wc.getURL())) return callback(false);
    // Microfone/câmera: o macOS pergunta na primeira vez que o site pede (entrar na call, ligar a câmera)
    if (permission === 'media' && process.platform === 'darwin') {
      const kinds = (details.mediaTypes ?? []).map((t) => ({ audio: 'microphone', video: 'camera' }[t])).filter(Boolean);
      for (const kind of kinds) {
        if (systemPreferences.getMediaAccessStatus(kind) === 'not-determined') await systemPreferences.askForMediaAccess(kind).catch(() => {});
      }
    }
    callback(true);
  });
  ses.setPermissionCheckHandler((_wc, permission, requestingOrigin) => ALLOWED.has(permission) && requestingOrigin === origin());

  // "Transmitir tela": o seletor nativo do macOS quando existe; senão, a nossa janelinha de escolha
  ses.setDisplayMediaRequestHandler(async (request, callback) => {
    try {
      const sources = await desktopCapturer.getSources({ types: ['screen', 'window'], thumbnailSize: { width: 320, height: 200 }, fetchWindowIcons: true });
      const chosen = await pickSource(sources);
      if (!chosen) return callback({});
      callback({ video: chosen });
      // Som da live no Mac: o Electron não captura; o muvuca-audio (ScreenCaptureKit) pega o som do app da janela
      if (wantAppAudio && canCaptureAppAudio()) startAppAudio(chosen.id);
    } catch (err) {
      console.error('captura de tela', err);
      callback({});
    }
  }); // o seletor próprio (e não o do sistema) diz qual janela foi escolhida, para pegar o som do app certo
}

// Janelinha para escolher tela ou janela (quando o seletor do sistema não aparece)
function pickSource(sources) {
  return new Promise((resolve) => {
    const picker = new BrowserWindow({
      parent: win ?? undefined,
      modal: !!win,
      width: 760,
      height: 560,
      resizable: false,
      minimizable: false,
      title: 'Transmitir tela',
      backgroundColor: '#2b2d31',
      webPreferences: { preload: path.join(__dirname, 'picker-preload.js'), contextIsolation: true, sandbox: true },
    });
    let done = false;
    const finish = (id) => {
      if (done) return;
      done = true;
      ipcMain.removeHandler('picker:sources');
      ipcMain.removeAllListeners('picker:choose');
      resolve(sources.find((s) => s.id === id) ?? null);
      if (!picker.isDestroyed()) picker.close();
    };
    ipcMain.handle('picker:sources', () => sources.map((s) => ({
      id: s.id, name: s.name, screen: s.id.startsWith('screen:'),
      thumb: s.thumbnail.toDataURL(), icon: s.appIcon?.toDataURL() ?? null,
    })));
    ipcMain.on('picker:choose', (_e, id) => finish(id));
    picker.on('closed', () => finish(null));
    picker.setMenu(null);
    picker.loadFile(path.join(__dirname, 'picker.html'));
  });
}

// ---------- Som da live no Mac (som só do app da janela transmitida) ----------
// O site avisa se a pessoa quer transmitir o som (opção da janela "Transmitir tela"); ao escolher a janela,
// o muvuca-audio começa e o áudio (float32, 48 kHz, estéreo) vai em pedaços para o site publicar na call.

let wantAppAudio = false;
let audioProc = null;
const canCaptureAppAudio = () => process.platform === 'darwin' && Number(os.release().split('.')[0]) >= 22; // macOS 13+
const helperPath = () => (app.isPackaged ? path.join(process.resourcesPath, 'bin', 'muvuca-audio') : path.join(__dirname, 'build', 'bin', 'muvuca-audio'));

function stopAppAudio() {
  if (!audioProc) return;
  const p = audioProc;
  audioProc = null;
  try { p.stdin.end(); } catch {}
  setTimeout(() => { try { p.kill(); } catch {} }, 500);
}

function startAppAudio(sourceId) {
  stopAppAudio();
  const [kind, id] = sourceId.split(':');
  const args = kind === 'window' ? ['--window', id] : ['--display', id];
  if (kind !== 'window') {
    // Tela inteira: tira o som do próprio Muvuca (senão a galera ouve a call de volta)
    for (const m of app.getAppMetrics()) args.push('--exclude-pid', String(m.pid));
    args.push('--exclude-bundle', app.isPackaged ? 'br.malegna.muvuca' : 'com.github.Electron');
  }
  const p = spawn(helperPath(), args, { stdio: ['pipe', 'pipe', 'pipe'] });
  audioProc = p;
  let rest = Buffer.alloc(0);
  let pending = [];
  let pendingBytes = 0;
  p.stdout.on('data', (chunk) => {
    if (audioProc !== p) return;
    // Só manda quadros inteiros (8 bytes = esquerda + direita em float32), em pedaços de ~20 ms
    const all = rest.length ? Buffer.concat([rest, chunk]) : chunk;
    const usable = all.length - (all.length % 8);
    rest = all.subarray(usable);
    pending.push(all.subarray(0, usable));
    pendingBytes += usable;
    if (pendingBytes >= 7680) { // 960 quadros = 20 ms
      win?.webContents.send('app-audio:data', Buffer.concat(pending));
      pending = [];
      pendingBytes = 0;
    }
  });
  p.stderr.on('data', (d) => {
    for (const line of String(d).split('\n').filter(Boolean)) {
      if (line === 'ok') win?.webContents.send('app-audio:state', { running: true });
      else if (line.startsWith('info:')) win?.webContents.send('app-audio:state', { running: true, info: line.slice(5).trim() });
      else if (line.startsWith('erro:')) win?.webContents.send('app-audio:state', { running: false, error: line.slice(5).trim() });
    }
  });
  p.on('exit', () => {
    if (audioProc === p) { audioProc = null; win?.webContents.send('app-audio:state', { running: false }); }
  });
  p.on('error', (err) => win?.webContents.send('app-audio:state', { running: false, error: err.message }));
}

ipcMain.handle('app-audio:supported', () => canCaptureAppAudio());
ipcMain.on('app-audio:want', (_e, on) => { wantAppAudio = !!on; });
ipcMain.on('app-audio:stop', () => stopAppAudio());

// ---------- Apertar para falar com o app em segundo plano (teclado global) ----------
// Com a janela em foco, o próprio site cuida da tecla; fora dela, este gancho avisa o site.
// No macOS precisa da permissão de "Monitoramento de Entrada" (pedida só quando o PTT é ligado).

const DOM_TO_HOOK = (code) => {
  if (/^Key[A-Z]$/.test(code)) return code.slice(3);
  if (/^Digit\d$/.test(code)) return code.slice(5);
  return {
    ControlLeft: 'Ctrl', ControlRight: 'CtrlRight', AltLeft: 'Alt', AltRight: 'AltRight', ShiftLeft: 'Shift', ShiftRight: 'ShiftRight',
    MetaLeft: 'Meta', MetaRight: 'MetaRight',
  }[code] ?? code; // Space, CapsLock, Backquote, F1…, setas: mesmo nome
};

let hook = null;
let pttKeycode = null;
let pttDown = false;
function sendPtt(down) {
  if (down === pttDown) return;
  pttDown = down;
  win?.webContents.send('ptt', down);
}
function setPtt({ enabled, code }) {
  const want = enabled && code;
  if (!want) {
    pttKeycode = null;
    if (pttDown) sendPtt(false);
    return { ok: true };
  }
  if (process.platform === 'darwin' && !systemPreferences.isTrustedAccessibilityClient(false)) {
    systemPreferences.isTrustedAccessibilityClient(true); // abre o pedido de permissão do macOS
    return { ok: false, reason: 'permissao' };
  }
  try {
    const { uIOhook, UiohookKey } = require('uiohook-napi');
    const key = UiohookKey[DOM_TO_HOOK(code)];
    if (key === undefined) return { ok: false, reason: 'tecla' };
    pttKeycode = key;
    if (!hook) {
      hook = uIOhook;
      hook.on('keydown', (e) => { if (e.keycode === pttKeycode && !win?.isFocused()) sendPtt(true); });
      hook.on('keyup', (e) => { if (e.keycode === pttKeycode) sendPtt(false); });
      hook.start();
    }
    return { ok: true };
  } catch (err) {
    console.error('ptt global', err);
    return { ok: false, reason: 'erro' };
  }
}
ipcMain.handle('ptt:set', (_e, opts) => setPtt(opts ?? {}));
// A janela ganhou foco no meio da fala: solta (o site assume a tecla dali em diante)
app.on('browser-window-focus', () => { if (pttDown) sendPtt(false); });

// ---------- Notificações nativas (o site pede quando a janela não está em foco) ----------

ipcMain.on('notify', (_e, { title, body, channelId, silent }) => {
  if (!Notification.isSupported()) return;
  if (process.env.MUVUCA_DEBUG) console.log('[notificação]', title, '|', body, '|', channelId);
  const n = new Notification({ title: String(title ?? 'Muvuca').slice(0, 120), body: String(body ?? '').slice(0, 300), silent: !!silent });
  n.on('click', () => { showWindow(); if (channelId) win?.webContents.send('open-channel', channelId); });
  n.show();
});
ipcMain.handle('app:info', () => ({ version: app.getVersion(), platform: process.platform }));

// ---------- Barra de menus (ícone ao lado do relógio) e menu do app ----------

let voiceMuted = false;
ipcMain.on('voice:state', (_e, s) => { voiceMuted = !!s?.muted; buildTray(); });

function openAtLogin() { return app.getLoginItemSettings().openAtLogin; }
function toggleOpenAtLogin() { app.setLoginItemSettings({ openAtLogin: !openAtLogin(), openAsHidden: true }); buildTray(); buildMenu(); }

function buildTray() {
  if (!tray) {
    const icon = nativeImage.createFromPath(path.join(__dirname, 'build', 'trayTemplate.png'));
    icon.setTemplateImage(true);
    tray = new Tray(icon);
    tray.setToolTip('Muvuca');
  }
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Abrir o Muvuca', click: showWindow },
    { label: voiceMuted ? 'Ativar microfone' : 'Silenciar microfone', click: () => win?.webContents.send('toggle-mute') },
    { type: 'separator' },
    { label: 'Abrir junto com o Mac', type: 'checkbox', checked: openAtLogin(), click: toggleOpenAtLogin },
    { type: 'separator' },
    { label: 'Sair do Muvuca', click: () => { quitting = true; app.quit(); } },
  ]));
}

async function chooseServer() {
  const { dialog } = require('electron');
  const choices = [DEFAULT_URL, 'http://localhost:3000'];
  const current = choices.indexOf(settings.url);
  const r = await dialog.showMessageBox(win, {
    type: 'question',
    message: 'Qual endereço do Muvuca abrir?',
    detail: 'O link público funciona de qualquer lugar. O "localhost" só neste Mac, com o servidor rodando nele (útil fora de casa, no modo local).',
    buttons: ['Link público', 'Neste Mac (localhost)', 'Cancelar'],
    defaultId: current >= 0 ? current : 0,
    cancelId: 2,
  });
  if (r.response > 1) return;
  settings.url = choices[r.response];
  saveSettings();
  setupPermissions();
  win?.loadURL(settings.url);
}

function buildMenu() {
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    {
      label: 'Muvuca',
      submenu: [
        { role: 'about', label: 'Sobre o Muvuca' },
        { type: 'separator' },
        { label: 'Abrir junto com o Mac', type: 'checkbox', checked: openAtLogin(), click: toggleOpenAtLogin },
        { label: 'Endereço do servidor…', click: chooseServer },
        { label: 'Procurar atualizações', click: () => { offered = null; checkUpdate(true); } },
        { type: 'separator' },
        { role: 'hide', label: 'Ocultar o Muvuca' },
        { role: 'hideOthers', label: 'Ocultar outros' },
        { role: 'unhide', label: 'Mostrar tudo' },
        { type: 'separator' },
        { label: 'Sair do Muvuca', accelerator: 'Cmd+Q', click: () => { quitting = true; app.quit(); } },
      ],
    },
    {
      label: 'Editar',
      submenu: [
        { role: 'undo', label: 'Desfazer' }, { role: 'redo', label: 'Refazer' }, { type: 'separator' },
        { role: 'cut', label: 'Recortar' }, { role: 'copy', label: 'Copiar' }, { role: 'paste', label: 'Colar' },
        { role: 'selectAll', label: 'Selecionar tudo' },
      ],
    },
    {
      label: 'Visualizar',
      submenu: [
        { role: 'reload', label: 'Recarregar' },
        { role: 'toggleDevTools', label: 'Ferramentas de desenvolvedor' },
        { type: 'separator' },
        { role: 'resetZoom', label: 'Tamanho normal' }, { role: 'zoomIn', label: 'Aumentar' }, { role: 'zoomOut', label: 'Diminuir' },
        { type: 'separator' },
        { role: 'togglefullscreen', label: 'Tela cheia' },
      ],
    },
    { role: 'windowMenu', label: 'Janela' },
  ]));
}

// ---------- Começo ----------

app.setAboutPanelOptions({ applicationName: 'Muvuca', applicationVersion: app.getVersion(), copyright: 'Feito pela galera da Malegna' });
app.on('before-quit', () => { quitting = true; });
app.on('activate', () => showWindow()); // clicar no ícone do Dock com a janela escondida
// Sem janelas o app continua vivo (barra de menus e Dock), como o Discord; sair é pelo menu ou ⌘Q
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });

// ---------- Versão nova: o servidor diz qual é a mais recente (downloads/latest.json) ----------
const newer = (a, b) => {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0);
  return false;
};
let offered = null; // não pergunta de novo pela mesma versão enquanto o app estiver aberto
async function checkUpdate(manual = false) {
  try {
    const res = await fetch(`${origin()}/downloads/latest.json`, { cache: 'no-cache' });
    if (!res.ok) return;
    const { version } = await res.json();
    const { dialog } = require('electron');
    if (manual && version && !newer(version, app.getVersion())) {
      dialog.showMessageBox(win ?? undefined, { type: 'info', message: 'Você já está com a versão mais nova', detail: `Muvuca ${app.getVersion()}` });
      return;
    }
    if (!version || !newer(version, app.getVersion()) || offered === version) return;
    offered = version;
    const r = await dialog.showMessageBox(win ?? undefined, {
      type: 'info',
      message: `Tem versão nova do Muvuca (${version})`,
      detail: `Você está com a ${app.getVersion()}. Baixe a nova e arraste para Aplicativos, substituindo a antiga.`,
      buttons: ['Baixar', 'Depois'],
      defaultId: 0,
      cancelId: 1,
    });
    if (r.response === 0) shell.openExternal(`${origin()}/baixar`);
  } catch {}
}

app.whenReady().then(() => {
  settings = loadSettings();
  setupPermissions();
  buildMenu();
  buildTray();
  createWindow();
  setTimeout(checkUpdate, 15_000);
  setInterval(checkUpdate, 6 * 3600_000);
});

app.on('will-quit', () => { try { hook?.stop(); } catch {} stopAppAudio(); });
