// Página da sala de tela (tela.html): entra com o Discord, compartilha a tela e a câmera e assiste.
// Mesmos quadros, controles e qualidades da call do site (voice.js e transmissao.js), sem microfone nem chat:
// o token do servidor só permite tela e câmera (src/tela.js).
// A galera conversa no Discord: no navegador, a tela inteira levaria o som do computador todo (o Discord junto).
// Por isso a página oferece abrir a sala no app do Muvuca, que manda só o som do programa transmitido
// (ou, na tela inteira, tudo menos o Discord).
import { $, h, store, showBanner, hideBanner } from './util.js';
import { icon, applyStaticIcons } from './icons.js';
import { contextMenu } from './dialogs.js';
import { CAN_BOOST, MAX_PERSON_VOLUME, CAMERA_VIDEO, IS_SAFARI, screenShareOptions, lockScreenQuality, openScreenDialog } from './transmissao.js';
import { somDoApp } from './desktop-audio.js';

const { Room, RoomEvent, Track, VideoPresets, VideoQuality, ConnectionQuality, DisconnectReason } = LivekitClient;

const codigo = location.pathname.split('/')[2] ?? '';

const ERROS = {
  membro: 'Só membros do servidor do Discord onde a sala foi criada podem entrar.',
  cancelado: 'O login com o Discord foi cancelado.',
  discord: 'Não consegui confirmar a sua conta no Discord. Tente de novo.',
  config: 'O login com o Discord ainda não foi configurado neste Muvuca.',
};

const PODE_TELA = !!navigator.mediaDevices?.getDisplayMedia;   // celular: só assiste
const PODE_CAMERA = !!navigator.mediaDevices?.getUserMedia;
const desktop = window.muvucaDesktop;                            // aberta no app do Muvuca
const isTouch = matchMedia('(pointer: coarse)').matches;

let room = null;
let pinnedKey = null;          // quadro em destaque (clique)
const tiles = new Map();       // chave -> elemento do quadro
const stage = $('stage');
const audioSink = h('div');    // som da tela de cada pessoa toca aqui, fora dos quadros
audioSink.hidden = true;
document.body.append(audioSink);
let audioCtx = null;           // amplificador do volume acima de 100% (onde o navegador permite)

applyStaticIcons();

// ---------- Avisos (carregando, login, sala encerrada) ----------

function aviso(texto, { erro = false, botao = null } = {}) {
  $('sala').hidden = true;
  const caixa = $('aviso');
  caixa.hidden = false;
  caixa.replaceChildren(h('p', erro ? 'error' : '', texto), ...(botao ? [botao] : []));
}

function link(texto, href) {
  const a = h('a', 'btn primary', texto);
  a.href = href;
  return a;
}

function botaoEntrarDeNovo() {
  const b = h('button', 'btn primary', 'Entrar de novo');
  b.type = 'button';
  b.onclick = () => entrar();
  return b;
}

const linkLogin = (texto) => link(texto, `/tela/entrar?sala=${encodeURIComponent(codigo)}`);

// ---------- Entrar ----------

async function entrar() {
  aviso('Entrando…');
  let res;
  try {
    res = await fetch('/api/tela/entrar', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sala: codigo }),
    });
  } catch {
    return aviso('Não consegui falar com o servidor. Confira a internet.', { erro: true, botao: botaoEntrarDeNovo() });
  }
  const dados = await res.json().catch(() => ({}));
  if (res.status === 404) return aviso('Esta sala foi encerrada. Peça um link novo no Discord com /tela.');
  if (res.status === 401) return aviso('Entre com a sua conta do Discord para ver e compartilhar nesta sala.', { botao: linkLogin('Entrar com Discord') });
  if (!res.ok) return aviso(dados.error || 'Não consegui entrar na sala.', { erro: true, botao: botaoEntrarDeNovo() });

  $('nome-sala').textContent = dados.sala.nome ? `· ${dados.sala.nome}` : '';
  if (CAN_BOOST) audioCtx ??= new AudioContext();
  audioCtx?.resume().catch(() => {});
  const r = new Room({
    // Só recebe a resolução que o quadro realmente mostra ('screen' conta os pixels reais, Retina inclusive)
    adaptiveStream: { pixelDensity: 'screen' },
    dynacast: true, // para de enviar camadas de vídeo que ninguém está vendo
    videoCaptureDefaults: { resolution: VideoPresets.h720.resolution },
    webAudioMix: CAN_BOOST ? { audioContext: audioCtx } : false,
    publishDefaults: { ...CAMERA_VIDEO },
  });
  r
    .on(RoomEvent.ParticipantConnected, desenhar)
    .on(RoomEvent.ParticipantDisconnected, desenhar)
    .on(RoomEvent.ParticipantMetadataChanged, desenhar)
    .on(RoomEvent.TrackSubscribed, aoReceber)
    .on(RoomEvent.TrackUnsubscribed, aoPerder)
    .on(RoomEvent.ConnectionQualityChanged, desenhar) // aviso de conexão instável nos quadros
    .on(RoomEvent.TrackMuted, desenhar)
    .on(RoomEvent.TrackUnmuted, desenhar)
    .on(RoomEvent.LocalTrackPublished, desenhar)
    // Também quando a pessoa clica em "parar compartilhamento" na barra do navegador
    .on(RoomEvent.LocalTrackUnpublished, (pub) => {
      if (pub.source === Track.Source.ScreenShare) { appAudio.parar(); silenciarOutros(false); }
      atualizarBotoes();
      desenhar();
    })
    .on(RoomEvent.AudioPlaybackStatusChanged, () => {
      if (r === room && !r.canPlaybackAudio) {
        showBanner('O navegador bloqueou o som. Clique aqui para ativar.', { kind: 'info', onClick: () => { audioCtx?.resume(); r.startAudio(); } });
      }
    })
    .on(RoomEvent.Disconnected, (motivo) => { if (r === room) aoSair(motivo); });
  try {
    await r.connect(dados.url, dados.token);
  } catch {
    return aviso('Não consegui conectar na sala. Tente de novo.', { erro: true, botao: botaoEntrarDeNovo() });
  }
  room = r;
  $('aviso').hidden = true;
  $('sala').hidden = false;
  $('btn-screen').hidden = !PODE_TELA;
  $('btn-cam').hidden = !PODE_CAMERA;
  $('btn-app').hidden = !!desktop || !PODE_TELA || isTouch;
  atualizarBotoes();
  desenhar();
}

function aoSair(motivo) {
  appAudio.parar();
  silenciarOutros(false);
  $('btn-app').hidden = true;
  room = null;
  pinnedKey = null;
  for (const el of tiles.values()) el.remove();
  tiles.clear();
  audioSink.replaceChildren();
  hideBanner();
  $('pessoas').textContent = '';
  if (motivo === DisconnectReason.ROOM_DELETED) return aviso('Esta sala foi encerrada. Peça um link novo no Discord com /tela.');
  if (motivo === DisconnectReason.DUPLICATE_IDENTITY) return aviso('Você abriu esta sala em outra aba, em outro aparelho ou no app do Muvuca.', { botao: botaoEntrarDeNovo() });
  if (motivo === DisconnectReason.CLIENT_INITIATED) return aviso('Você saiu da sala.', { botao: botaoEntrarDeNovo() });
  aviso('A conexão com a sala caiu.', { erro: true, botao: botaoEntrarDeNovo() });
}

$('btn-leave').onclick = () => room?.disconnect();

// ---------- Abrir no app do Muvuca ----------
// O app tem login próprio: o servidor dá um passe de uso único e o app abre a sala já com o Discord conectado.
// Quando o app entra, esta aba sai da sala (a mesma pessoa não fica duas vezes).

$('btn-app').onclick = async () => {
  let res;
  try {
    res = await fetch('/api/tela/passe', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sala: codigo }) });
  } catch {
    return showBanner('Não consegui falar com o servidor. Confira a internet.', { timeout: 5000 });
  }
  const dados = await res.json().catch(() => ({}));
  if (!res.ok) return showBanner(dados.error || 'Não consegui abrir no app. Tente de novo.', { timeout: 5000 });
  location.href = `muvuca://tela?${new URLSearchParams({ servidor: location.origin, sala: codigo, passe: dados.passe })}`;
  showBanner('Abrindo no app do Muvuca… Não abriu? Clique aqui para baixar o app.', {
    kind: 'info', timeout: 15000, onClick: () => window.open('/baixar', '_blank', 'noopener'),
  });
};

// ---------- Som da live pelo app do Muvuca ----------
// Só o programa da janela transmitida; na tela inteira, tudo menos o Discord (desktop-audio.js e o app).
// No Windows o sistema só tira um programa do som: tirando o Discord, o que o Muvuca toca iria junto na live.
// Então, enquanto isso, o som das telas dos outros fica mudo para quem transmite.
const appAudio = somDoApp(desktop, {
  sala: () => room,
  aoMudar: (s) => {
    if (s.somDoMuvuca) silenciarOutros(true);
    else if (s.error || !s.running) silenciarOutros(false);
  },
});

// Texto embaixo de "Transmitir o som também", na janela "Transmitir tela"
function ajudaDoSom() {
  if (IS_SAFARI) return null; // o Safari não manda som de tela (a própria janela já avisa)
  const p = h('p', 'muted small nota-som');
  if (!desktop) {
    p.textContent = 'Pelo navegador, numa aba vai só o som da aba; na tela inteira vai o som do computador todo, inclusive o Discord. '
      + 'Para mandar só o som do jogo, use "Abrir no app do Muvuca", lá em cima.';
    return p;
  }
  p.textContent = 'Numa janela, vai só o som daquele programa. Na tela inteira, vai o som do computador sem o Discord.';
  desktop.appAudioSupported?.().then((ok) => {
    if (ok) return;
    p.textContent = desktop.platform === 'win32'
      ? 'Este Windows manda o som do computador todo, inclusive o Discord. Para não ir junto, desmarque o som ou atualize o Windows.'
      : 'Este Mac não transmite o som (precisa do macOS 13 ou mais novo).';
  }).catch(() => {});
  return p;
}

// ---------- Som da tela de cada pessoa (volume só para você, como no Discord) ----------

let outrosMudos = false; // ver silenciarOutros

function aplicarVolume(p) {
  p.setVolume(outrosMudos ? 0 : volumeSalvo(p), Track.Source.ScreenShareAudio);
}

function silenciarOutros(sim) {
  if (sim === outrosMudos) return;
  outrosMudos = sim;
  for (const p of room?.remoteParticipants.values() ?? []) aplicarVolume(p);
  if (sim) {
    showBanner('Enquanto você transmite a tela inteira, o som das telas dos outros fica mudo para você (senão ele voltaria na sua live). Para ouvir, transmita só a janela do jogo.', { kind: 'info', timeout: 10000 });
  }
}

function aoReceber(track, pub, participante) {
  if (track.kind === Track.Kind.Audio) {
    audioSink.append(track.attach());
    aplicarVolume(participante);
  }
  desenhar();
}

function aoPerder(track) {
  track.detach().forEach((el) => el.remove());
  desenhar();
}

function volumeSalvo(p) {
  const raw = store.get(`telaVolume:${p.identity}`);
  const v = Number(raw);
  return raw === null || Number.isNaN(v) ? 1 : Math.min(Math.max(v, 0), MAX_PERSON_VOLUME);
}

function salvarVolume(p, v) {
  store.set(`telaVolume:${p.identity}`, v === 1 ? null : String(v));
  aplicarVolume(p);
}

const volumeIcon = (v) => icon(v === 0 ? 'volume-off' : v < 0.5 ? 'volume-low' : 'speaker', 18);

function buildVolumeControl(el) {
  const box = h('div', 'vol');
  const btn = h('button', 'vol-btn');
  const slider = h('input');
  Object.assign(slider, { type: 'range', min: 0, max: MAX_PERSON_VOLUME * 100, step: 1 });
  box.append(btn, slider);
  // Não deixa o clique no controle fixar/soltar o quadro
  for (const ev of ['click', 'pointerdown', 'dblclick']) box.addEventListener(ev, (e) => e.stopPropagation());
  slider.oninput = () => {
    const v = Number(slider.value) / 100;
    salvarVolume(el._participant, v);
    if (v > 0) box.dataset.last = String(v);
    btn.replaceChildren(volumeIcon(v));
    box.title = `Volume da tela: ${slider.value}%`;
  };
  btn.onclick = () => {
    const atual = volumeSalvo(el._participant);
    const v = atual > 0 ? 0 : Number(box.dataset.last) || 1; // clique = mudo / volta ao anterior
    if (atual > 0) box.dataset.last = String(atual);
    salvarVolume(el._participant, v);
    syncVolumeControl(el);
  };
  return box;
}

function syncVolumeControl(el) {
  const box = el.querySelector('.vol');
  const v = volumeSalvo(el._participant);
  box.querySelector('input').value = String(Math.round(v * 100));
  box.querySelector('.vol-btn').replaceChildren(volumeIcon(v));
  const temSom = !!el._participant.getTrackPublication(Track.Source.ScreenShareAudio);
  box.classList.toggle('no-audio', !temSom);
  box.title = temSom ? `Volume da tela: ${Math.round(v * 100)}%` : 'Esta transmissão está sem som';
}

// ---------- Câmera ----------

let cameraFacing = store.get('cameraFacing') === 'environment' ? 'environment' : 'user';
let cameraCount = 0;
async function countCameras() {
  const all = await navigator.mediaDevices?.enumerateDevices?.().catch(() => []) ?? [];
  cameraCount = all.filter((d) => d.kind === 'videoinput').length;
}
const mirrorLocalCamera = () => cameraFacing === 'user'; // a traseira não é espelhada (texto legível)

function warnDevice(what) {
  return (err) => {
    console.warn(err);
    showBanner(`Não foi possível acessar a ${what}: ${err.message}`, { timeout: 5000 });
  };
}

$('btn-cam').onclick = async () => {
  if (!room) return;
  const lp = room.localParticipant;
  const turningOn = !lp.isCameraEnabled;
  // No celular, liga na câmera que a pessoa usou por último (frontal ou traseira)
  await lp.setCameraEnabled(turningOn, turningOn && isTouch ? { facingMode: cameraFacing } : undefined).catch(warnDevice('câmera'));
  if (turningOn) await countCameras(); // com a permissão dada, a lista de câmeras vem completa
  atualizarBotoes();
  desenhar();
};

// Virar câmera: frontal ↔ traseira no celular; próxima câmera no computador
$('btn-flip').onclick = async () => {
  const track = room?.localParticipant.getTrackPublication(Track.Source.Camera)?.track;
  if (!track) return;
  $('btn-flip').disabled = true;
  try {
    const caps = track.mediaStreamTrack?.getCapabilities?.() ?? {};
    if (isTouch || caps.facingMode?.length) {
      const next = cameraFacing === 'user' ? 'environment' : 'user';
      await track.restartTrack({ facingMode: next, resolution: VideoPresets.h720.resolution });
      cameraFacing = next;
      store.set('cameraFacing', next === 'environment' ? next : null);
    } else {
      const cams = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'videoinput' && d.deviceId);
      const current = track.mediaStreamTrack?.getSettings?.().deviceId;
      const next = cams[(cams.findIndex((d) => d.deviceId === current) + 1) % cams.length];
      if (next) await room.switchActiveDevice('videoinput', next.deviceId);
    }
  } catch (err) {
    warnDevice('outra câmera')(err);
  } finally {
    $('btn-flip').disabled = false;
  }
  desenhar();
};

// ---------- Tela ----------

$('btn-screen').onclick = async () => {
  if (!room) return;
  const lp = room.localParticipant;
  if (lp.isScreenShareEnabled) {
    await lp.setScreenShareEnabled(false);
    atualizarBotoes();
    desenhar();
  } else openScreenDialog({ onStart: startScreenShare, audioHelp: ajudaDoSom });
};

async function startScreenShare(opts) {
  if (!room) return;
  // App do Muvuca: o som vem à parte, do programa escolhido (no Mac só a partir do macOS 13)
  if (desktop?.wantAppAudio) desktop.wantAppAudio(!!opts.audio && (desktop.platform !== 'darwin' || await desktop.appAudioSupported()));
  try {
    await room.localParticipant.setScreenShareEnabled(true, ...screenShareOptions(opts));
    await lockScreenQuality(room.localParticipant, opts.fps);
  } catch (err) {
    if (err.name !== 'NotAllowedError') warnDevice('tela')(err); // NotAllowed = cancelou
  }
  appAudio.publicar(); // o som do app pode ter ficado pronto antes da imagem
  atualizarBotoes();
  desenhar();
}

function atualizarBotoes() {
  if (!room) return;
  const lp = room.localParticipant;
  $('btn-cam').replaceChildren(icon(lp.isCameraEnabled ? 'video' : 'video-off'));
  $('btn-cam').title = lp.isCameraEnabled ? 'Desligar câmera' : 'Ligar câmera';
  $('btn-cam').classList.toggle('on', lp.isCameraEnabled);
  // Virar câmera: só com a câmera ligada e mais de uma câmera no aparelho
  $('btn-flip').hidden = !lp.isCameraEnabled || cameraCount < 2;
  $('btn-screen').classList.toggle('on', lp.isScreenShareEnabled);
  $('btn-screen').title = lp.isScreenShareEnabled ? 'Parar transmissão' : 'Transmitir tela';
}

// ---------- Quadros (um por pessoa, com a câmera ou a foto, e um por tela compartilhada) ----------

const pessoas = () => (room ? [room.localParticipant, ...room.remoteParticipants.values()] : []);

function fotoDe(p) {
  try { return JSON.parse(p.metadata || '{}').avatar || ''; } catch { return ''; }
}

function desiredTiles() {
  const list = [];
  for (const p of pessoas()) {
    list.push({ key: `${p.identity}|cam`, p, pub: p.getTrackPublication(Track.Source.Camera), screen: false });
    const scr = p.getTrackPublication(Track.Source.ScreenShare);
    if (scr?.track) list.push({ key: `${p.identity}|screen`, p, pub: scr, screen: true });
  }
  return list;
}

function desenhar() {
  if (!room) return;
  const todas = pessoas();
  $('pessoas').textContent = `${todas.length} ${todas.length === 1 ? 'pessoa' : 'pessoas'} na sala`;
  $('pessoas').title = todas.map((p) => p.name || p.identity).join(', ');

  const list = desiredTiles();
  const keys = new Set(list.map((t) => t.key));
  if (pinnedKey && !keys.has(pinnedKey)) pinnedKey = null;
  const mainKey = pinnedKey || list.find((t) => t.screen)?.key || null;

  for (const [key, el] of tiles) {
    if (!keys.has(key)) { el.remove(); tiles.delete(key); }
  }
  for (const t of list) updateTile(tiles.get(t.key) || createTile(t.key), t, t.key === mainKey);

  // Com alguém em destaque (tela): quadro grande e os participantes embaixo, por cima da tela
  // (só as câmeras, em miniatura no canto) ou ocultos, como na call do site
  const focus = !!mainKey && list.length > 1;
  stage.classList.toggle('focus', focus);
  stage.classList.toggle('strip-over', focus && stripMode === 'over');
  if (focus) {
    const others = list.filter((t) => t.key !== mainKey);
    stage.append(tiles.get(mainKey), stripToggle, strip); // append move sem recriar (o vídeo continua tocando)
    for (const t of others) strip.append(tiles.get(t.key));
    strip.hidden = stripMode === 'hidden'; // quadros ocultos deixam de receber vídeo (economiza banda)
    paintStripModes(others.length);
  } else {
    for (const t of list) stage.append(tiles.get(t.key));
    stripToggle.remove();
    strip.remove();
  }
  layoutGrid();
}

// Grade como a do Discord: todos os quadros em 16:9, com o número de colunas que deixa cada um o maior possível
const TILE_RATIO = 16 / 9;
const GRID_GAP = 10;
function layoutGrid() {
  if (stage.classList.contains('focus')) return;
  const n = stage.querySelectorAll(':scope > .tile').length;
  if (!n) return;
  const cs = getComputedStyle(stage);
  const W = stage.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
  const H = stage.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom);
  if (W <= 0 || H <= 0) return;
  let best = { w: 0, cols: 1 };
  for (let cols = 1; cols <= n; cols++) {
    const rows = Math.ceil(n / cols);
    const w = Math.min((W - GRID_GAP * (cols - 1)) / cols, ((H - GRID_GAP * (rows - 1)) / rows) * TILE_RATIO);
    if (w > best.w) best = { w, cols };
  }
  stage.style.setProperty('--tile-w', `${Math.floor(best.w)}px`);
}
new ResizeObserver(() => layoutGrid()).observe(stage);

// Participantes durante a tela em destaque: embaixo (faixa), sobre a tela ou ocultos
const strip = h('div', 'strip');
const stripToggle = h('div', 'strip-toggle');
const STRIP_MODES = [['below', 'Embaixo'], ['over', 'Sobre a tela'], ['hidden', 'Ocultar']];
let stripMode = store.get('stripMode') ?? 'below';
if (!STRIP_MODES.some(([m]) => m === stripMode)) stripMode = 'below';
function paintStripModes(count) {
  stripToggle.replaceChildren(h('span', 'strip-label', `Participantes (${count}):`), ...STRIP_MODES.map(([mode, label]) => {
    const b = h('button', mode === stripMode ? 'strip-mode on' : 'strip-mode', label);
    b.type = 'button';
    b.setAttribute('aria-pressed', String(mode === stripMode));
    b.onclick = (e) => {
      e.stopPropagation();
      stripMode = mode;
      store.set('stripMode', mode === 'below' ? null : mode);
      desenhar();
    };
    return b;
  }));
}

function createTile(key) {
  const el = document.createElement('div');
  el.className = 'tile';
  el.innerHTML = `
    <video autoplay playsinline muted hidden></video>
    <span class="label"></span>
    <pre class="stats" hidden></pre>
    <span class="conn-warn" hidden></span>
    <button class="qual" title="Qualidade da live" hidden></button>
    <button class="fs" title="Tela cheia" hidden></button>
    <button class="pip" title="Janela flutuante (fica por cima de outros programas)" hidden></button>`;
  el.querySelector('.qual').onclick = (e) => { e.stopPropagation(); openQualityMenu(el, e.currentTarget); };
  el.querySelector('.fs').append(icon('maximize', 16));
  el.querySelector('.pip').append(icon('monitor-up', 16));
  el.append(Object.assign(buildVolumeControl(el), { hidden: true }));
  el.onclick = () => { pinnedKey = pinnedKey === key ? null : key; desenhar(); };
  el.querySelector('.fs').onclick = (e) => {
    e.stopPropagation();
    el.querySelector('video').requestFullscreen?.();
  };
  el.querySelector('.pip').onclick = async (e) => {
    e.stopPropagation();
    try { await el.querySelector('video').requestPictureInPicture(); } catch { showBanner('Este navegador não deixou abrir a janela flutuante.', { timeout: 4000 }); }
  };
  if (showStats) el.querySelector('.stats').hidden = false;
  tiles.set(key, el);
  return el;
}

function updateTile(el, { p, pub, screen }, isMain) {
  const video = el.querySelector('video');
  const track = pub?.track;
  const showVideo = !!track && !pub.isMuted;

  if (showVideo && el.dataset.trackSid !== track.sid) {
    track.attach(video);
    el.dataset.trackSid = track.sid;
  } else if (!showVideo && el.dataset.trackSid) {
    delete el.dataset.trackSid;
    video.srcObject = null;
  }

  const name = p.name || p.identity;
  video.hidden = !showVideo;
  el.classList.toggle('has-video', showVideo);
  video.style.transform = p.isLocal && !screen && mirrorLocalCamera() ? 'scaleX(-1)' : ''; // espelha só a própria câmera frontal

  // Foto do Discord quando não há vídeo
  let avatar = el.querySelector('.avatar');
  const foto = fotoDe(p);
  if (!avatar || avatar.dataset.foto !== foto) {
    avatar?.remove();
    avatar = h('img', 'avatar');
    avatar.alt = '';
    avatar.referrerPolicy = 'no-referrer';
    if (foto) avatar.src = foto;
    avatar.dataset.foto = foto;
    el.prepend(avatar);
  }
  avatar.hidden = showVideo;

  el.querySelector('.fs').hidden = !screen;
  el.querySelector('.pip').hidden = !screen || p.isLocal || !showVideo || !document.pictureInPictureEnabled || !video.requestPictureInPicture;
  // Tela de outra pessoa: mostra a qualidade que está chegando (fixa, escolhida por quem transmite)
  const qual = el.querySelector('.qual');
  qual.hidden = !screen || p.isLocal || !showVideo;
  el._pub = pub;
  if (!qual.hidden) { applyStreamQuality(pub); paintQualityButton(el); }
  // Conexão instável de quem está no quadro (é dela que vem a imagem)
  const cq = p.connectionQuality;
  const warn = el.querySelector('.conn-warn');
  warn.hidden = cq !== ConnectionQuality.Poor && cq !== ConnectionQuality.Lost;
  if (!warn.hidden) warn.replaceChildren(icon('signal', 12), p.isLocal ? ' Sua conexão está instável' : ' Conexão instável');
  el.classList.toggle('screen', screen);
  el.classList.toggle('main', isMain);
  el.dataset.identity = p.identity;
  el._track = showVideo ? track : null; // usado pelo painel de qualidade
  el._participant = p;

  const label = el.querySelector('.label');
  label.replaceChildren();
  if (screen) label.append(icon('monitor', 14), ` Tela de ${name}`);
  else label.append(name);

  // Volume do som da tela: só no quadro da tela de outra pessoa
  const vol = el.querySelector('.vol');
  vol.hidden = !screen || p.isLocal;
  if (!vol.hidden) syncVolumeControl(el);
}

// ---------- Qualidade da tela para quem assiste ----------
// Fixa: chega exatamente a qualidade que quem transmite escolheu. O botão mostra o que está chegando.

function applyStreamQuality(pub) {
  if (pub && !pub.track?.isLocal && pub.setVideoQuality) pub.setVideoQuality(VideoQuality.HIGH);
}

function paintQualityButton(el) {
  const video = el.querySelector('video');
  const vh = video?.videoHeight;
  const res = vh ? `${vh >= 1000 ? 1080 : vh >= 700 ? 720 : vh >= 520 ? 540 : vh >= 340 ? 360 : vh}p` : '';
  const fps = el._pub?.track?.mediaStreamTrack?.getSettings?.().frameRate;
  el.querySelector('.qual').textContent = res ? `${res}${fps ? ` · ${Math.round(fps)} fps` : ''}` : 'Live';
}
setInterval(() => { for (const el of tiles.values()) if (!el.querySelector('.qual').hidden) paintQualityButton(el); }, 2000);

const CONN_LABEL = { excellent: 'excelente', good: 'boa', poor: 'instável', lost: 'caindo', unknown: 'medindo…' };
function openQualityMenu(el, btn) {
  const r = btn.getBoundingClientRect();
  const who = room?.remoteParticipants.get(el.dataset.identity);
  const mine = room?.localParticipant.connectionQuality;
  contextMenu(r.left, r.bottom + 4, [
    { label: 'Qualidade fixa: a que quem transmite escolheu', icon: 'monitor', onClick: () => {} },
    'sep',
    { label: `Conexão de ${who?.name ?? 'quem transmite'}: ${CONN_LABEL[who?.connectionQuality] ?? '?'}`, icon: 'signal', onClick: () => {} },
    { label: `Sua conexão: ${CONN_LABEL[mine] ?? '?'}`, icon: 'signal', onClick: () => {} },
  ]);
}

// ---------- Painel de qualidade (botão de barras) ----------

const QUALITY_LABEL = { excellent: 'excelente', good: 'boa', poor: 'ruim', lost: 'perdida', unknown: '?' };
const LIMIT_LABEL = { bandwidth: 'banda', cpu: 'CPU', other: 'outro' };
let showStats = false;
const prevBytes = new WeakMap(); // track -> { bytes, time }

$('btn-stats').onclick = () => {
  showStats = !showStats;
  $('btn-stats').classList.toggle('on', showStats);
  for (const el of tiles.values()) el.querySelector('.stats').hidden = !showStats;
  if (showStats) updateStats();
};
setInterval(() => { if (showStats && room) updateStats(); }, 2000);

function kbps(track, bytes) {
  const now = performance.now();
  const prev = prevBytes.get(track);
  prevBytes.set(track, { bytes, time: now });
  if (!prev || bytes < prev.bytes) return null;
  return Math.round(((bytes - prev.bytes) * 8) / (now - prev.time)); // bytes/ms -> kbps
}

async function updateStats() {
  for (const el of tiles.values()) {
    const out = el.querySelector('.stats');
    const p = el._participant;
    const track = el._track;
    const lines = [`conexão: ${QUALITY_LABEL[p?.connectionQuality] ?? '?'}`];
    try {
      if (track && p.isLocal) {
        const cap = track.mediaStreamTrack.getSettings();
        lines.push(`captura: ${cap.width}x${cap.height} @ ${Math.round(cap.frameRate ?? 0)}fps`);
        const layers = (await track.getSenderStats?.()) ?? [];
        const top = layers[0];
        if (top) {
          const rate = kbps(track, layers.reduce((sum, l) => sum + (l.bytesSent ?? 0), 0));
          lines.push(`enviando: ${top.frameWidth ?? '?'}x${top.frameHeight ?? '?'} @ ${Math.round(top.framesPerSecond ?? 0)}fps`);
          if (rate !== null) lines.push(`bitrate: ${rate} kbps (${layers.length} camada${layers.length > 1 ? 's' : ''})`);
          const limit = layers.find((l) => l.qualityLimitationReason && l.qualityLimitationReason !== 'none');
          if (limit) lines.push(`atenção: limitado por ${LIMIT_LABEL[limit.qualityLimitationReason] ?? limit.qualityLimitationReason}`);
          if (top.roundTripTime) lines.push(`ping: ${Math.round(top.roundTripTime * 1000)} ms`);
        }
      } else if (track) {
        const st = await track.getReceiverStats?.();
        if (st) {
          const rate = kbps(track, st.bytesReceived ?? 0);
          lines.push(`recebendo: ${st.frameWidth ?? '?'}x${st.frameHeight ?? '?'} @ ${Math.round(st.framesPerSecond ?? 0)}fps`);
          if (rate !== null) lines.push(`bitrate: ${rate} kbps`);
          lines.push(`perdidos: ${st.packetsLost ?? 0} pacotes  descartados: ${st.framesDropped ?? 0} quadros`);
          if (st.jitter) lines.push(`jitter: ${Math.round(st.jitter * 1000)} ms`);
        }
      } else {
        lines.push('sem vídeo');
      }
    } catch (err) {
      lines.push(`erro: ${err.message}`);
    }
    out.textContent = lines.join('\n');
  }
}

// ---------- Começo ----------

// Volta do login do Discord com erro (?erro=...): mostra e limpa o endereço
const erro = new URLSearchParams(location.search).get('erro');
if (erro) history.replaceState(null, '', location.pathname);
if (erro && ERROS[erro]) aviso(ERROS[erro], { erro: true, botao: linkLogin('Tentar de novo') });
else entrar();
