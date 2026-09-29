// Canais de música: player do YouTube sincronizado, cabine de DJs, fila pessoal, busca e reações.
// O player fica montado o tempo todo (fora da tela quando você está em outro canal), então a música
// continua tocando enquanto você navega — como a voz.
import { $, h, store, makeAvatar, showBanner } from './util.js';
import { icon } from './icons.js';
import { state, findChannel, canIn, PERMS } from './state.js';
import { nameColor } from './permissions.js';
import { send, request } from './net.js';
import { selectChannel } from './app.js';
import { renderChannels } from './sidebar.js';

const DRIFT_TOLERANCE_S = 1.5; // desvio aceito antes de reposicionar o vídeo
const SYNC_EVERY_MS = 1000;

const m = {
  channelId: null,   // canal de música que você está ouvindo
  room: null,        // estado da sala (vem do servidor)
  queue: [],         // sua fila pessoal
  recent: [],        // últimas músicas tocadas
  results: null,     // resultado da busca
  openResult: null,  // resultado com a prévia aberta
  added: new Set(),  // vídeos da busca atual que você já adicionou
  searching: false,
  offset: 0,         // relógio do servidor - relógio daqui (ms)
  player: null,
  playerReady: false,
  loadedVideo: null,
  needsClick: false, // navegador bloqueou o som: precisa de um clique
  volume: Number(store.get('musicVolume') ?? 60),
  muted: store.get('musicMuted') === '1',
};

export const musicChannelId = () => m.channelId;
const serverNow = () => Date.now() + m.offset;
const myId = () => state.me?.id;

// ---------- Entrar e sair ----------

export async function joinMusic(channelId) {
  if (m.channelId === channelId) return;
  try {
    ensurePlayer();
    const res = await request({ t: 'music:join', channelId });
    m.channelId = channelId;
    m.room = res.state;
    m.queue = res.queue;
    m.recent = res.recent;
    m.results = null;
    m.loadedVideo = null;
    syncClock();
    renderAllMusic();
  } catch (err) {
    showBanner(err.message, { timeout: 4000 });
  }
}

export function leaveMusic() {
  if (!m.channelId) return;
  send({ t: 'music:leave', channelId: m.channelId });
  closeMusic();
}

function closeMusic() {
  m.channelId = null;
  m.room = null;
  m.queue = [];
  m.results = null;
  m.loadedVideo = null;
  try { m.player?.stopVideo(); } catch {}
  renderAllMusic();
  // Estava olhando o canal de música: fica nele, mas sem ouvir (ao clicar de novo, entra)
}

// Reconectou (queda de internet): volta para a mesma sala
export function rejoinMusic() {
  const id = m.channelId;
  if (!id) return;
  m.channelId = null;
  if (findChannel(id).channel) joinMusic(id);
  else closeMusic();
}

// Canal excluído ou saiu do servidor
export function musicChannelGone() {
  if (m.channelId && !findChannel(m.channelId).channel) closeMusic();
}

// ---------- Mensagens do servidor ----------

export function onMusicState(msg) {
  if (msg.channelId !== m.channelId) return;
  m.room = msg.state;
  sync();
  renderAllMusic();
}

export function onMusicQueue(msg) {
  if (msg.channelId !== m.channelId) return;
  m.queue = msg.queue;
  renderSide();
}

// ---------- Relógio: mede a diferença para o servidor (como um ping) ----------

async function syncClock() {
  let best = null;
  for (let i = 0; i < 5; i++) {
    const t0 = Date.now();
    try {
      const res = await request({ t: 'time' });
      const t1 = Date.now();
      const rtt = t1 - t0;
      if (!best || rtt < best.rtt) best = { rtt, offset: res.now - (t0 + rtt / 2) };
    } catch { break; }
  }
  if (best) m.offset = best.offset;
}
setInterval(() => { if (m.channelId) syncClock(); }, 60_000);

// ---------- Player do YouTube ----------

let apiPromise = null;
function loadYoutubeApi() {
  apiPromise ??= new Promise((resolve) => {
    window.onYouTubeIframeAPIReady = () => resolve(window.YT);
    const s = document.createElement('script');
    s.src = 'https://www.youtube.com/iframe_api';
    document.head.append(s);
  });
  return apiPromise;
}

function ensurePlayer() {
  if (m.player) return;
  const frame = h('div');
  frame.id = 'music-player-frame';
  $('music-player').replaceChildren(frame);
  m.player = { pending: true };
  loadYoutubeApi().then((YT) => {
    m.player = new YT.Player('music-player-frame', {
      width: '100%',
      height: '100%',
      playerVars: { autoplay: 1, controls: 0, disablekb: 1, rel: 0, playsinline: 1, iv_load_policy: 3, modestbranding: 1 },
      events: {
        onReady: () => { m.playerReady = true; applyVolume(); sync(); },
        onStateChange: onPlayerState,
        onError: (e) => {
          const t = m.room?.track;
          if (t) send({ t: 'music:error', channelId: m.channelId, videoId: t.videoId, code: e.data });
        },
      },
    });
  });
}

function onPlayerState(e) {
  const YT = window.YT;
  const t = m.room?.track;
  if (!t) return;
  if (e.data === YT.PlayerState.PLAYING) {
    if (m.needsClick) { m.needsClick = false; renderStage(); }
    // Sem duração pela API: o player do DJ informa
    if (!t.duration && t.djId === myId()) {
      const d = m.player.getDuration();
      if (d > 0) send({ t: 'music:duration', channelId: m.channelId, videoId: t.videoId, duration: d });
    }
  }
  if (e.data === YT.PlayerState.ENDED && t.djId === myId()) {
    send({ t: 'music:ended', channelId: m.channelId, videoId: t.videoId });
  }
}

export function applyVolume() {
  if (!m.playerReady) return;
  m.player.setVolume(m.volume);
  if (m.muted || state.deafened) m.player.mute(); else m.player.unMute();
}

let startTimer = null;
// Coloca o player no vídeo e no segundo certos
function sync() {
  if (!m.playerReady) return;
  const t = m.channelId && m.room?.track;
  if (!t) {
    if (m.loadedVideo) { m.player.stopVideo(); m.loadedVideo = null; }
    return;
  }
  const elapsed = (serverNow() - t.startedAt) / 1000;
  if (m.loadedVideo !== t.videoId) {
    m.loadedVideo = t.videoId;
    clearTimeout(startTimer);
    if (elapsed < 0) {
      // Começa daqui a pouco (folga para todos carregarem juntos)
      m.player.cueVideoById({ videoId: t.videoId, startSeconds: 0 });
      startTimer = setTimeout(() => m.player.playVideo(), -elapsed * 1000);
    } else {
      m.player.loadVideoById({ videoId: t.videoId, startSeconds: elapsed });
    }
    // Se depois de alguns segundos não estiver tocando, o navegador bloqueou o som
    setTimeout(checkAutoplay, Math.max(0, -elapsed * 1000) + 3000);
    return;
  }
  if (elapsed < 0) return;
  const st = m.player.getPlayerState?.();
  if (st === window.YT.PlayerState.PLAYING || st === window.YT.PlayerState.BUFFERING) {
    if (Math.abs(m.player.getCurrentTime() - elapsed) > DRIFT_TOLERANCE_S) m.player.seekTo(elapsed, true);
  } else if (!m.needsClick && (st === window.YT.PlayerState.PAUSED || st === window.YT.PlayerState.CUED)) {
    m.player.seekTo(elapsed, true);
    m.player.playVideo();
  }
}
setInterval(() => { if (m.channelId) { sync(); updateProgress(); } }, SYNC_EVERY_MS);

function checkAutoplay() {
  if (!m.playerReady || !m.room?.track) return;
  const st = m.player.getPlayerState();
  if (st !== window.YT.PlayerState.PLAYING && st !== window.YT.PlayerState.BUFFERING) {
    m.needsClick = true;
    renderStage();
  }
}

// ---------- Tela do canal de música ----------

export function renderAllMusic() {
  renderStage();
  renderSide();
  renderMusicPanel();
  renderChannels();
}

const djName = (userId) => {
  const s = serverOf();
  return s?.members.find((x) => x.id === userId)?.name ?? 'Alguém';
};
const serverOf = () => findChannel(m.channelId ?? state.view.channelId).server;
const viewingJoined = () => state.view.channelId === m.channelId && !!m.channelId;
const fmt = (s) => (Number.isFinite(s) && s >= 0 ? `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}` : '–:––');

// A área do player fica visível só quando você está olhando o canal que está ouvindo
export function placeMusicView() {
  const { channel } = findChannel(state.view.channelId);
  const onMusic = channel?.type === 'music';
  $('music-view').classList.toggle('offscreen', !onMusic);
}

function renderStage() {
  const info = $('music-info');
  const overlay = $('music-overlay');
  if (!info) return;
  const { channel } = findChannel(state.view.channelId);
  const t = viewingJoined() ? m.room?.track : null;

  overlay.replaceChildren();
  overlay.hidden = false;
  if (channel?.type === 'music' && !viewingJoined()) {
    const b = h('button', 'btn primary', 'Entrar e ouvir');
    b.onclick = () => joinMusic(channel.id);
    overlay.append(icon('headphones', 36), h('div', '', 'Você não está ouvindo este canal.'), b);
  } else if (!t) {
    overlay.append(icon('headphones', 36), h('div', '', 'Nenhuma música tocando. Entre na cabine e adicione uma!'));
  } else if (m.needsClick) {
    const b = h('button', 'btn primary', 'Clique para ouvir');
    b.onclick = () => { m.needsClick = false; m.player.playVideo(); sync(); renderStage(); };
    overlay.append(icon('volume-off', 36), h('div', '', 'O navegador bloqueou o som.'), b);
  } else overlay.hidden = true;

  info.replaceChildren();
  if (!t) return;
  const s = serverOf();
  const left = h('div', 'music-title-box');
  left.append(h('div', 'music-title', t.title));
  const by = h('div', 'muted small', 'tocada por ');
  const dj = h('span', '', djName(t.djId));
  const color = nameColor(s, t.djId);
  if (color) dj.style.color = color;
  by.append(dj);
  left.append(by);

  const actions = h('div', 'music-actions');
  for (const [kind, ic, label] of [['up', 'thumb-up', 'Curti'], ['down', 'thumb-down', 'Não curti'], ['heart', 'heart', 'Amei']]) {
    const list = t.reactions?.[kind] ?? [];
    const b = h('button', list.includes(myId()) ? `reaction on ${kind}` : `reaction ${kind}`);
    b.title = label;
    b.append(icon(ic, 16), h('span', '', String(list.length)));
    b.onclick = () => send({ t: 'music:react', channelId: m.channelId, kind });
    actions.append(b);
  }
  if (t.djId === myId() || canIn(s, PERMS.MUSIC_MANAGE)) {
    const skip = h('button', 'reaction');
    skip.title = t.djId === myId() ? 'Pular minha música' : 'Pular esta música';
    skip.append(icon('skip', 16), h('span', '', 'Pular'));
    skip.onclick = () => request({ t: 'music:skip', channelId: m.channelId }).catch((err) => showBanner(err.message, { timeout: 4000 }));
    actions.append(skip);
  }
  const row = h('div', 'music-row');
  row.append(left, actions);

  const progress = h('div', 'music-progress');
  progress.append(h('span', 'music-time', '0:00'), h('div', 'bar', ''), h('span', 'music-duration', fmt(t.duration)));
  progress.querySelector('.bar').append(h('div', 'fill'));
  const vol = h('div', 'music-volume');
  const mute = h('button', 'icon-btn');
  mute.title = m.muted ? 'Ativar som da música' : 'Silenciar música';
  mute.append(icon(m.muted ? 'volume-off' : m.volume < 50 ? 'volume-low' : 'speaker', 18));
  mute.onclick = toggleMute;
  const slider = h('input');
  Object.assign(slider, { type: 'range', min: 0, max: 100, step: 1, value: m.volume });
  slider.title = 'Volume da música (só para você)';
  slider.oninput = () => {
    m.volume = Number(slider.value);
    store.set('musicVolume', String(m.volume));
    if (m.muted && m.volume > 0) { m.muted = false; store.set('musicMuted', null); }
    applyVolume();
  };
  vol.append(mute, slider);
  progress.append(vol);
  info.append(row, progress);
  updateProgress();
}

function updateProgress() {
  const t = m.room?.track;
  const bar = document.querySelector('#music-info .fill');
  if (!t || !bar) return;
  const elapsed = Math.max(0, (serverNow() - t.startedAt) / 1000);
  document.querySelector('#music-info .music-time').textContent = fmt(t.duration ? Math.min(elapsed, t.duration) : elapsed);
  document.querySelector('#music-info .music-duration').textContent = fmt(t.duration);
  bar.style.width = t.duration ? `${Math.min(100, (elapsed / t.duration) * 100)}%` : '0%';
}

function toggleMute() {
  m.muted = !m.muted;
  store.set('musicMuted', m.muted ? '1' : null);
  applyVolume();
  renderStage();
  renderMusicPanel();
}

// ---------- Painel da direita: cabine, fila, busca, ouvintes ----------

// Arrastar para reordenar a fila (mouse e dedo): enquanto arrasta, os redesenhos esperam o fim
let dragging = null;  // { list, row, from, pointerId }

function startQueueDrag(e, row, list, from) {
  if (e.button > 0 || m.queue.length < 2) return;
  e.preventDefault();
  dragging = { list, row, from, pointerId: e.pointerId };
  row.classList.add('dragging');
  list.classList.add('sorting');
  // Escuta na janela: a linha muda de lugar no meio do arraste e perderia o "soltar"
  window.addEventListener('pointermove', moveQueueDrag);
  window.addEventListener('pointerup', endQueueDrag);
  window.addEventListener('pointercancel', endQueueDrag);
}

function moveQueueDrag(e) {
  if (!dragging || e.pointerId !== dragging.pointerId) return;
  const { list, row } = dragging;
  // Vai trocando de lugar até ficar entre as músicas certas (um movimento rápido pode pular várias)
  const rows = () => [...list.querySelectorAll('.queue-row')];
  for (let moved = true; moved;) {
    moved = false;
    const i = rows().indexOf(row);
    const prev = rows()[i - 1];
    const next = rows()[i + 1];
    if (prev && e.clientY < prev.getBoundingClientRect().top + prev.offsetHeight / 2) { list.insertBefore(row, prev); moved = true; }
    else if (next && e.clientY > next.getBoundingClientRect().top + next.offsetHeight / 2) { next.after(row); moved = true; }
  }
  // Perto das bordas da lista, rola sozinho
  const scroller = list.closest('.members, .music-side') ?? list.parentElement;
  const box = scroller.getBoundingClientRect();
  if (e.clientY < box.top + 30) scroller.scrollTop -= 8;
  else if (e.clientY > box.bottom - 30) scroller.scrollTop += 8;
}

function endQueueDrag(e) {
  if (!dragging || (e && e.pointerId !== dragging.pointerId)) return;
  const { list, row, from } = dragging;
  window.removeEventListener('pointermove', moveQueueDrag);
  window.removeEventListener('pointerup', endQueueDrag);
  window.removeEventListener('pointercancel', endQueueDrag);
  const to = [...list.querySelectorAll('.queue-row')].indexOf(row);
  row.classList.remove('dragging');
  list.classList.remove('sorting');
  dragging = null;
  if (to >= 0 && to !== from) {
    m.queue.splice(to, 0, ...m.queue.splice(from, 1)); // já mostra no lugar novo (o servidor confirma em seguida)
    send({ t: 'music:move', channelId: m.channelId, from, to });
  }
  renderSide();
}

export function renderSide(container = $('member-list')) {
  const { server, channel } = findChannel(state.view.channelId);
  if (!container || channel?.type !== 'music') return;
  if (dragging) return; // termina de arrastar e redesenha
  // Redesenhar não pode apagar o que a pessoa está digitando na busca
  const typing = document.activeElement?.closest?.('.music-search');
  const caret = typing ? document.activeElement.selectionStart : null;
  container.replaceChildren();
  if (typing) queueMicrotask(() => {
    const input = container.querySelector('.music-search input');
    if (input) { input.focus(); input.setSelectionRange(caret, caret); }
  });
  if (!viewingJoined()) return;
  const room = m.room;
  const inBooth = room.booth.includes(myId());
  const canManage = canIn(server, PERMS.MUSIC_MANAGE);

  container.append(h('div', 'category', 'Cabine de DJs'));
  const booth = h('div', 'booth');
  if (!room.booth.length) booth.append(h('div', 'muted small side-pad', 'Ninguém na cabine ainda.'));
  room.booth.forEach((id, i) => {
    const row = h('div', id === room.djId ? 'booth-row current' : 'booth-row');
    row.append(id === room.djId ? icon('player-play', 14) : h('span', 'booth-pos', String(i + 1)));
    const member = server.members.find((x) => x.id === id);
    row.append(makeAvatar(member?.name ?? '?', 'sm', member?.id));
    const name = h('span', 'name', member?.name ?? '?');
    const color = nameColor(server, id);
    if (color) name.style.color = color;
    row.append(name);
    if (id === server.ownerId) row.append(icon('crown', 12));
    if (canManage && id !== myId()) {
      const kick = h('button', 'icon-btn tiny');
      kick.title = 'Tirar da cabine';
      kick.append(icon('close', 14));
      kick.onclick = () => request({ t: 'music:kick', channelId: m.channelId, userId: id }).catch((err) => showBanner(err.message, { timeout: 4000 }));
      row.append(kick);
    }
    booth.append(row);
  });
  container.append(booth);

  if (inBooth || canIn(server, PERMS.MUSIC_DJ)) {
    const b = h('button', inBooth ? 'btn danger block side-btn' : 'btn primary block side-btn', inBooth ? 'Sair da cabine' : 'Entrar na cabine');
    b.onclick = () => request({ t: 'music:booth', channelId: m.channelId, join: !inBooth }).catch((err) => showBanner(err.message, { timeout: 4000 }));
    container.append(b);
  }

  if (inBooth) {
    container.append(h('div', 'category', 'Minha fila'));
    const list = h('div', 'my-queue');
    if (!m.queue.length) list.append(h('div', 'muted small side-pad', 'Sua fila está vazia. Busque ou cole um link abaixo.'));
    m.queue.forEach((item, i) => {
      const row = h('div', 'queue-row');
      const grip = h('span', 'queue-grip');
      grip.title = 'Arraste para mudar a ordem';
      grip.append(icon('grip', 14));
      grip.onpointerdown = (e) => startQueueDrag(e, row, list, i);
      row.append(grip, h('span', 'booth-pos', String(i + 1)), h('span', 'queue-title', item.title));
      row.title = item.title;
      const tools = h('span', 'queue-tools');
      if (i > 0) tools.append(tool('arrow-up', 'Subir', () => send({ t: 'music:move', channelId: m.channelId, from: i, to: i - 1 })));
      tools.append(tool('close', 'Remover', () => send({ t: 'music:remove', channelId: m.channelId, index: i })));
      row.append(tools);
      list.append(row);
    });
    container.append(list, searchBox());
  }

  if (m.recent.length) {
    container.append(h('div', 'category', 'Tocadas recentemente'));
    const rec = h('div', 'recent');
    for (const p of m.recent.slice(0, 5)) {
      const row = h('div', 'recent-row');
      row.title = `${p.title} — ${p.dj}`;
      row.append(h('span', 'queue-title', p.title), h('span', 'muted small', p.dj));
      rec.append(row);
    }
    container.append(rec);
  }

  container.append(h('div', 'category', `Ouvintes — ${room.listeners.length}`));
  const listeners = h('div', 'listeners');
  for (const id of room.listeners) {
    const member = server.members.find((x) => x.id === id);
    const av = makeAvatar(member?.name ?? '?', 'sm', member?.id);
    av.title = member?.name ?? '?';
    listeners.append(av);
  }
  container.append(listeners);
}

async function addResult(r) {
  if (m.added.has(r.videoId)) return;
  try {
    await request({ t: 'music:add', channelId: m.channelId, videoId: r.videoId, title: r.title });
    m.added.add(r.videoId);
    m.openResult = null;
  } catch (err) {
    showBanner(err.message, { timeout: 4000 });
  }
  renderSide();
}

function tool(ic, title, onClick) {
  const b = h('button', 'icon-btn tiny');
  b.title = title;
  b.append(icon(ic, 14));
  b.onclick = onClick;
  return b;
}

// Campo "Buscar ou colar link": link vai direto para a fila; texto busca no YouTube
function searchBox() {
  const box = h('div', 'music-search');
  const form = h('form', 'search-form');
  const input = h('input');
  Object.assign(input, { placeholder: 'Buscar ou colar link do YouTube', maxLength: 300 });
  input.value = m.lastQuery ?? '';
  input.oninput = () => { m.lastQuery = input.value; };
  form.append(icon('search', 16), input);
  form.onsubmit = async (e) => {
    e.preventDefault();
    const text = input.value.trim();
    if (!text) return;
    m.lastQuery = text;
    const looksLikeLink = /youtu\.?be|^[a-zA-Z0-9_-]{11}$/.test(text);
    try {
      if (looksLikeLink) {
        await request({ t: 'music:add', channelId: m.channelId, url: text });
        m.lastQuery = '';
        input.value = '';
      } else {
        m.searching = true;
        renderSide();
        const res = await request({ t: 'music:search', q: text });
        m.results = res.results;
        m.openResult = null;
        m.added = new Set();
      }
    } catch (err) {
      showBanner(err.message, { timeout: 5000 });
    } finally {
      m.searching = false;
      renderSide();
    }
  };
  box.append(form);
  if (m.searching) box.append(h('div', 'muted small side-pad', 'Buscando…'));
  if (m.results) {
    const list = h('div', 'results');
    if (!m.results.length) list.append(h('div', 'muted small side-pad', 'Nada encontrado.'));
    for (const r of m.results) {
      const added = m.added.has(r.videoId);
      const open = m.openResult === r.videoId;
      const item = h('div', `result${open ? ' open' : ''}${added ? ' added' : ''}`);

      // Linha compacta: clicar abre a prévia com o botão de adicionar
      const row = h('button', 'result-row');
      row.type = 'button';
      row.title = open ? 'Fechar prévia' : 'Ver detalhes';
      if (r.thumbnail) {
        const img = h('img');
        img.src = r.thumbnail;
        img.alt = '';
        row.append(img);
      }
      const txt = h('div', 'result-text');
      txt.append(h('div', 'queue-title', r.title), h('div', 'muted small', r.channel));
      row.append(txt);
      row.onclick = () => { m.openResult = open ? null : r.videoId; m.scrollToPreview = !open; renderSide(); };

      // Atalho: adicionar direto, sem abrir a prévia
      const quick = h('button', 'result-add');
      quick.type = 'button';
      quick.title = added ? 'Já está na sua fila' : 'Adicionar à minha fila';
      quick.append(icon(added ? 'check' : 'plus', 16));
      quick.onclick = () => addResult(r);
      const line = h('div', 'result-line');
      line.append(row, quick);
      item.append(line);

      // Prévia: miniatura grande, título completo e botão grande de adicionar
      if (open) {
        const preview = h('div', 'result-preview');
        const img = h('img');
        img.src = `https://i.ytimg.com/vi/${r.videoId}/mqdefault.jpg`;
        img.alt = '';
        const addBtn = h('button', added ? 'btn secondary block' : 'btn primary block', added ? 'Na sua fila ✓' : 'Adicionar à minha fila');
        addBtn.type = 'button';
        addBtn.onclick = () => addResult(r);
        const yt = h('a', 'link small', 'Abrir no YouTube');
        yt.href = `https://www.youtube.com/watch?v=${r.videoId}`;
        yt.target = '_blank';
        yt.rel = 'noopener noreferrer';
        preview.append(img, h('div', 'preview-title', r.title), h('div', 'muted small', r.channel), addBtn, yt);
        item.append(preview);
        // Acabou de abrir: rola o painel até a prévia (com o botão de adicionar) ficar inteira à vista
        if (m.scrollToPreview) {
          m.scrollToPreview = false;
          requestAnimationFrame(() => preview.scrollIntoView({ block: 'nearest', behavior: 'smooth' }));
        }
      }
      list.append(item);
    }
    const close = h('button', 'link small', 'Fechar resultados');
    close.onclick = () => { m.results = null; renderSide(); };
    box.append(list, close);
  }
  return box;
}

// ---------- Painel "Tocando agora" na barra de canais ----------

export function renderMusicPanel() {
  const panel = $('music-panel');
  panel.hidden = !m.channelId;
  if (!m.channelId) return;
  const { server, channel } = findChannel(m.channelId);
  $('mp-title').textContent = m.room?.track?.title ?? 'Nenhuma música tocando';
  $('mp-title').title = $('mp-title').textContent;
  $('mp-channel').textContent = `${channel?.name ?? '?'} / ${server?.name ?? '?'}`;
  $('mp-mute').replaceChildren(icon(m.muted ? 'volume-off' : 'speaker', 18));
  $('mp-mute').classList.toggle('off', m.muted);
  $('mp-mute').title = m.muted ? 'Ativar som da música' : 'Silenciar música';
}

$('mp-mute').onclick = toggleMute;
$('mp-leave').onclick = () => leaveMusic();
$('mp-channel').onclick = () => { if (m.channelId) selectChannel(m.channelId); };

// Diagnóstico: em que segundo o player está e em que segundo deveria estar (pelo relógio do servidor)
export function musicTiming() {
  const t = m.room?.track;
  if (!t || !m.playerReady) return null;
  return {
    videoId: t.videoId,
    player: m.player.getCurrentTime(),
    expected: (serverNow() - t.startedAt) / 1000,
    offsetMs: Math.round(m.offset),
    state: m.player.getPlayerState(),
  };
}

// ---------- Divisória entre o vídeo e o chat (arrastar para redimensionar) ----------

const VIDEO_MIN = 200;      // altura mínima do vídeo (px): o YouTube exige pelo menos 200 px para tocar
const CHAT_MIN = 150;       // espaço mínimo que sobra para o chat (px)

function setVideoHeight(px, save = true) {
  const view = $('music-view');
  if (px === null) {
    view.style.removeProperty('--music-video-h');
    if (save) store.set('musicVideoHeight', null);
    return;
  }
  // Limites: nem sumir com o vídeo, nem esmagar o chat
  const info = $('music-info').offsetHeight + 40; // título, reações e barra de progresso
  const max = view.clientHeight - info - CHAT_MIN;
  const h = Math.round(Math.max(VIDEO_MIN, Math.min(px, max)));
  view.style.setProperty('--music-video-h', `${h}px`);
  if (save) store.set('musicVideoHeight', String(h));
}

{
  const handle = $('music-resizer');
  const saved = Number(store.get('musicVideoHeight'));
  if (saved) $('music-view').style.setProperty('--music-video-h', `${saved}px`);

  handle.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    handle.setPointerCapture(e.pointerId);
    const screen = document.querySelector('.music-screen');
    const startY = e.clientY;
    const startH = screen.getBoundingClientRect().height;
    $('music-view').classList.add('resizing'); // o iframe do YouTube não "rouba" o mouse durante o arraste
    const move = (ev) => setVideoHeight(startH + ev.clientY - startY, false);
    const up = () => {
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', up);
      handle.removeEventListener('pointercancel', up);
      $('music-view').classList.remove('resizing');
      setVideoHeight(document.querySelector('.music-screen').getBoundingClientRect().height);
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', up);
    handle.addEventListener('pointercancel', up);
  });

  handle.addEventListener('dblclick', () => setVideoHeight(null));

  handle.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
    e.preventDefault();
    const current = document.querySelector('.music-screen').getBoundingClientRect().height;
    setVideoHeight(current + (e.key === 'ArrowDown' ? 30 : -30));
  });
}
