// Área de jogos (ícone fixo 🎮): lista de jogos e salas, a sala (jogadores, placar, começar)
// e a partida desenhada num <canvas>. A partida roda no servidor; aqui só desenha e manda os comandos.
// Cada jogo fica em js/games/<nome>.js (desenho, controles e textos).
import { $, h, showBanner, makeAvatar } from './util.js';
import { icon } from './icons.js';
import { state } from './state.js';
import { request, send } from './net.js';
import { colorOf } from './games/common.js';
import { confetti } from './confetti.js';
import { gameSounds, gameSoundsOn, setGameSounds, gameVolume, setGameVolume, sfx } from './games/sfx.js';
import bomberman from './games/bomberman.js';
import tron from './games/tron.js';
import tanks from './games/tanks.js';
import agar from './games/agar.js';
import velha from './games/velha.js';
import cartas from './games/cartas.js';
import desenho from './games/desenho.js';
import stop from './games/stop.js';
import impostor from './games/impostor.js';

const GAME_INFO = { bomberman, tron, tanks, agar, velha, cartas, desenho, stop, impostor };

const games = { list: [], rooms: [], room: null, snaps: [], loaded: false, week: [], all: [], lbTab: 'week', chat: [] };

export const inGames = () => !!state.view.games;
const amPlayer = () => !!games.room?.players.some((p) => p.id === state.me?.id);
const fail = (err) => showBanner(err.message, { timeout: 4000 });

// ---------- Eventos do servidor ----------

export function onGamesRooms(m) {
  if (m.games) games.list = m.games;
  games.rooms = m.rooms;
  games.loaded = true;
  if (inGames()) { renderGamesSidebar(); if (!games.room) renderGamesView(); }
}

export function onGameRoom(m) {
  if (games.room && m.room.id !== games.room.id) return;
  const started = m.room.status === 'playing' && games.room?.status !== 'playing';
  games.room = m.room;
  if (started) { games.snaps = []; GAME_INFO[m.room.game]?.reset?.(); }
  if (inGames()) { renderGamesSidebar(); renderGamesView(); }
}

export function onGameState(m) {
  if (!games.room || m.roomId !== games.room.id) return;
  // Sons: compara com o estado anterior (só com a sala na tela)
  const prev = games.snaps[games.snaps.length - 1]?.s;
  if (inGames()) gameSounds(games.room.game, prev, m.state, state.me?.id);
  games.snaps.push({ at: performance.now(), s: m.state });
  if (games.snaps.length > 3) games.snaps.shift();
  if (GAME_INFO[games.room.game]?.dom) scheduleDom(); // jogos de tela comum (não canvas) redesenham quando muda
}

// Eventos na hora (traços do desenho)
export function onGameEvents(m) {
  if (!games.room || m.roomId !== games.room.id) return;
  GAME_INFO[games.room.game]?.onEvents?.(m.events, domCtx());
}

// ---------- Chat da sala ----------

export function onGameChatlog(m) {
  if (games.room?.id !== m.roomId) return;
  games.chat = m.lines;
  renderChatLog();
}

export function onGameChat(m) {
  if (games.room?.id !== m.roomId) return;
  games.chat.push(m.line);
  if (games.chat.length > 80) games.chat.shift();
  renderChatLog();
}

function renderChatLog() {
  const log = document.getElementById('game-chat-log');
  if (!log) return;
  const atBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 40;
  log.replaceChildren();
  for (const l of games.chat) {
    const row = h('div', `game-chat-line ${l.kind ?? ''}`.trim());
    if (l.userId) row.append(h('strong', '', `${l.name}: `));
    row.append(l.text);
    log.append(row);
  }
  if (atBottom || games.chat.at(-1)?.userId === state.me?.id) log.scrollTop = log.scrollHeight;
}

function chatPanel(r) {
  const panel = h('div', 'game-chat');
  const log = h('div', 'game-chat-log');
  log.id = 'game-chat-log';
  const form = h('form', 'game-chat-form');
  const input = h('input');
  input.id = 'game-chat-input';
  input.maxLength = 200;
  input.autocomplete = 'off';
  input.placeholder = GAME_INFO[r.game]?.chatPlaceholder ?? 'Conversar na sala…';
  form.append(input);
  form.onsubmit = (e) => {
    e.preventDefault();
    const text = input.value.trim();
    if (!text) return;
    input.value = '';
    request({ t: 'game:chat', roomId: r.id, text }).catch(fail);
  };
  panel.append(h('div', 'game-chat-title', 'Chat da sala'), log, form);
  return panel;
}

// ---------- Jogos de tela comum (Stop, Impostor, Desenha aí) ----------

const domCtx = () => ({
  room: games.room,
  send: (input) => send({ t: 'game:input', roomId: games.room.id, ...input }),
  request,
  me: state.me?.id,
  isPlayer: amPlayer(),
  focusChat: () => document.getElementById('game-chat-input')?.focus(),
});
let domPending = false;
function scheduleDom() {
  if (domPending) return;
  domPending = true;
  requestAnimationFrame(() => { domPending = false; renderDom(); });
}
function renderDom() {
  const el = document.getElementById('game-dom');
  const s = games.snaps.at(-1)?.s;
  if (!el || !s || !games.room) return;
  const out = GAME_INFO[games.room.game].render(el, s, domCtx());
  updateStatus(out ?? {});
}

export function onGameLeft(m) {
  if (games.room?.id !== m.roomId) return;
  games.room = null;
  games.snaps = [];
  games.chat = [];
  if (inGames()) { renderGamesSidebar(); renderGamesView(); }
}

// Placar da semana e de sempre (chega ao abrir os jogos e sempre que uma partida com 2+ pessoas termina)
export function onLeaderboard(m) {
  games.week = m.week ?? [];
  games.all = m.all ?? games.all;
  if (inGames() && !games.room) renderGamesView();
}

// Abriu a área de jogos: busca a lista de salas e o placar
export function openGames() {
  request({ t: 'games:list' }).then(onGamesRooms).catch(fail);
  request({ t: 'games:leaderboard' }).then(onLeaderboard).catch(() => {});
  renderGamesSidebar();
  renderGamesView();
}

// ---------- Ações ----------

async function createRoom(game) {
  try { games.room = (await request({ t: 'game:create', game })).room; games.snaps = []; games.chat = []; } catch (err) { return fail(err); }
  renderGamesSidebar();
  renderGamesView();
}

// Botão "Entrar na sala" do aviso no chat
export const enterRoom = (roomId) => joinRoom(roomId);

async function joinRoom(roomId, watch = false) {
  if (games.room?.id === roomId) return renderGamesView();
  try { games.chat = []; games.room = (await request({ t: 'game:join', roomId, watch })).room; games.snaps = []; } catch (err) { return fail(err); }
  renderGamesSidebar();
  renderGamesView();
}

function leaveRoom() {
  request({ t: 'game:leave' }).catch(fail);
  games.room = null;
  games.snaps = [];
  renderGamesSidebar();
  renderGamesView();
}

// ---------- Coluna da esquerda (no lugar dos canais) ----------

// No celular a coluna é uma gaveta: escolheu algo, fecha
function closeDrawer() {
  $('app').classList.remove('show-sidebar');
  $('scrim').hidden = true;
}

function categoryTitle(text) {
  const row = h('div', 'category');
  row.append(h('span', '', text));
  return row;
}

export function renderGamesSidebar() {
  const header = $('server-name');
  header.replaceChildren(h('span', 'server-title', 'Jogos'));
  header.onclick = null;
  const box = $('channel-list');
  box.replaceChildren();
  // Um item só para a lista de jogos; o resto da coluna é das salas
  const list = h('ul', 'channel-list');
  const lobby = h('button', 'channel');
  lobby.classList.toggle('active', !games.room);
  lobby.append(h('span', 'game-emoji', '🎮'), h('span', 'name', 'Todos os jogos'));
  lobby.onclick = () => { closeDrawer(); if (games.room) leaveRoom(); else renderGamesView(); };
  const li = h('li');
  li.append(lobby);
  list.append(li);
  box.append(h('div', 'games-gap'), list, categoryTitle(`Salas abertas — ${games.rooms.length}`));
  const rooms = h('ul', 'channel-list');
  for (const r of games.rooms) {
    const b = h('button', 'channel');
    b.classList.toggle('active', games.room?.id === r.id);
    const host = r.players.find((p) => p.id === r.hostId)?.name ?? r.players[0]?.name ?? 'sala';
    b.append(h('span', 'game-emoji', GAME_INFO[r.game]?.emoji ?? '🎮'), h('span', 'name', `Sala de ${host}`),
      h('span', r.status === 'playing' ? 'count live' : 'count', r.status === 'playing' ? 'jogando' : `${r.players.length}/${r.maxPlayers}`));
    b.title = GAME_INFO[r.game]?.title ?? '';
    b.onclick = () => { closeDrawer(); joinRoom(r.id); };
    const li = h('li');
    li.append(b);
    rooms.append(li);
  }
  if (!games.rooms.length) rooms.append(h('li', 'muted small games-empty', 'Nenhuma sala aberta. Crie uma!'));
  box.append(rooms);
}

// ---------- Área principal ----------

export function renderGamesView() {
  const view = $('games-view');
  if (!inGames()) return;
  $('view-icon').replaceChildren(icon('gamepad', 22));
  $('view-title').textContent = games.room ? `Sala de ${roomHost(games.room)} — ${GAME_INFO[games.room.game]?.title}` : 'Jogos';
  view.replaceChildren(games.room ? roomView(games.room) : lobbyView());
  if (games.room) {
    renderChatLog();
    if (GAME_INFO[games.room.game]?.dom) { GAME_INFO[games.room.game].mount?.(domCtx()); renderDom(); } else startDrawing();
  }
}

const roomHost = (r) => r.players.find((p) => p.id === r.hostId)?.name ?? 'alguém';

// Quem mais venceu nos últimos 7 dias (partidas com pelo menos 2 pessoas)
function leaderboardCard() {
  const card = h('div', 'leaderboard');
  const head = h('div', 'leaderboard-head');
  const tabs = h('div', 'lb-tabs');
  for (const [id, label] of [['week', 'Semana'], ['all', 'Sempre']]) {
    const b = h('button', games.lbTab === id ? 'lb-tab on' : 'lb-tab', label);
    b.type = 'button';
    b.onclick = () => { games.lbTab = id; renderGamesView(); };
    tabs.append(b);
  }
  head.append(icon('trophy', 18), h('strong', '', 'Placar'), tabs);
  card.append(head);
  const rows = games.lbTab === 'all' ? games.all : games.week;
  if (!rows.length) {
    card.append(h('p', 'muted small', games.lbTab === 'all'
      ? 'Ninguém venceu uma partida com 2 ou mais pessoas ainda. Seja o primeiro!'
      : 'Ninguém venceu uma partida com 2 ou mais pessoas nesta semana. Seja o primeiro!'));
    return card;
  }
  const list = h('ol', 'leaderboard-list');
  rows.forEach((r, i) => {
    const li = h('li', r.userId === state.me?.id ? 'me' : '');
    li.append(h('span', 'rank', ['🥇', '🥈', '🥉'][i] ?? `${i + 1}º`), makeAvatar(r.name, 'sm', r.userId), h('span', 'lb-name', r.name),
      h('span', 'lb-score', `${r.wins} ${r.wins === 1 ? 'vitória' : 'vitórias'}`), h('span', 'muted small', `${r.played} ${r.played === 1 ? 'partida' : 'partidas'}`));
    list.append(li);
  });
  card.append(list);
  return card;
}

function lobbyView() {
  const wrap = h('div', 'games-lobby');
  wrap.append(leaderboardCard());
  const cards = h('div', 'game-cards'); // duas colunas (uma no celular)
  wrap.append(cards);
  // Ordem que o servidor manda (mais jogados primeiro); jogos que ele não listou vão para o fim
  const order = games.list.map((g) => g.id);
  const rank = (id) => (order.includes(id) ? order.indexOf(id) : order.length);
  for (const [id, info] of Object.entries(GAME_INFO).sort(([a], [b]) => rank(a) - rank(b))) {
    const card = h('div', 'game-card');
    const art = h('div', 'game-art', info.emoji);
    const body = h('div', 'game-card-body');
    body.append(h('h2', '', info.title), h('p', 'muted', info.desc), controlsHelp(id));
    const create = h('button', 'btn primary', 'Criar sala');
    create.onclick = () => createRoom(id);
    body.append(create);
    card.append(art, body);
    cards.append(card);
  }
  wrap.append(h('h3', 'games-subtitle', 'Salas abertas'));
  if (!games.rooms.length) wrap.append(h('p', 'muted', 'Nenhuma sala aberta agora. Crie uma e chame a galera!'));
  for (const r of games.rooms) {
    const row = h('div', 'room-row');
    const names = r.players.map((p) => p.name).join(', ') || 'ninguém';
    const info = h('div', 'room-info');
    info.append(h('strong', '', `${GAME_INFO[r.game]?.emoji ?? ''} Sala de ${roomHost(r)}`),
      h('span', 'muted small', `${r.players.length}/${r.maxPlayers} jogadores: ${names}${r.spectators ? ` · ${r.spectators} assistindo` : ''}`));
    const actions = h('div', 'room-actions');
    const canJoin = r.status === 'waiting' && r.players.length < r.maxPlayers;
    if (canJoin) {
      const join = h('button', 'btn primary', 'Entrar');
      join.onclick = () => joinRoom(r.id);
      actions.append(join);
    }
    const watch = h('button', 'btn secondary', r.status === 'playing' ? 'Assistir a partida' : 'Assistir');
    watch.onclick = () => joinRoom(r.id, true);
    actions.append(watch);
    row.append(info, actions);
    wrap.append(row);
  }
  return wrap;
}

// Regras da casa do jogo (ex.: cartas): quem manda na sala liga/desliga antes de começar; os outros só veem
function optionsBox(r) {
  const meta = games.list.find((g) => g.id === r.game)?.options ?? {};
  const keys = Object.keys(meta);
  if (!keys.length || !r.options) return null;
  const box = h('div', 'game-options');
  const editable = r.hostId === state.me?.id && r.status === 'waiting';
  if (r.status === 'playing') {
    const on = keys.filter((k) => r.options[k]).map((k) => meta[k].label);
    box.append(h('span', 'muted small', on.length ? `Regras da casa: ${on.join(', ')}` : 'Sem regras da casa'));
    return box;
  }
  box.append(h('span', 'game-options-title', 'Regras da casa'));
  for (const k of keys) {
    const label = h('label', 'game-option');
    label.title = meta[k].hint;
    const box2 = h('input');
    box2.type = 'checkbox';
    box2.checked = !!r.options[k];
    box2.disabled = !editable;
    box2.onchange = () => request({ t: 'game:options', roomId: r.id, options: { [k]: box2.checked } }).catch(fail);
    label.append(box2, h('span', '', meta[k].label));
    box.append(label);
  }
  if (!editable) box.append(h('span', 'muted small', `(quem escolhe é ${roomHost(r)})`));
  return box;
}

const touchScreen = () => matchMedia('(pointer: coarse)').matches;

function controlsHelp(game) {
  const info = GAME_INFO[game];
  const help = h('div', 'game-help');
  if (touchScreen() && info.touchHelp) help.append(info.touchHelp);
  else help.append(...info.help());
  return help;
}

// Setas e botão de ação na tela, para quem joga pelo celular (viram as mesmas teclas do teclado)
function touchControls(info) {
  const box = h('div', 'game-touch');
  if (info.touch.dpad) {
    const pad = h('div', 'dpad');
    for (const [dir, code, glyph] of [['up', 'ArrowUp', '▲'], ['left', 'ArrowLeft', '◀'], ['right', 'ArrowRight', '▶'], ['down', 'ArrowDown', '▼']]) {
      const b = h('button', `dpad-btn ${dir}`, glyph);
      holdKey(b, code);
      pad.append(b);
    }
    box.append(pad);
  }
  if (info.touch.action) {
    const b = h('button', 'touch-action', info.touch.action);
    holdKey(b, 'Space');
    box.append(b);
  }
  return box;
}

function holdKey(b, code) {
  b.type = 'button';
  const up = () => {
    if (!b.classList.contains('on')) return;
    b.classList.remove('on');
    current()?.keyup?.({ code }, api);
  };
  b.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    if (!playing()) return;
    try { b.setPointerCapture(e.pointerId); } catch { /* sem captura: solta no pointerup mesmo */ }
    b.classList.add('on');
    current()?.keydown?.({ code, repeat: false }, api);
  });
  for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) b.addEventListener(type, up);
  b.addEventListener('contextmenu', (e) => e.preventDefault());
}

function roomView(r) {
  const wrap = h('div', 'game-room');
  const top = h('div', 'game-top');
  const players = h('div', 'game-players');
  r.players.forEach((p, i) => {
    const chip = h('div', 'game-player');
    const avatar = makeAvatar(p.name, 'sm', p.id);
    avatar.classList.add('game-avatar');
    avatar.style.setProperty('--ring', colorOf(i));
    chip.append(avatar, h('span', 'game-name', p.name));
    if (p.id === r.hostId) chip.append(icon('crown', 14));
    chip.append(h('span', 'game-score', `🏆 ${r.scores[p.id] ?? 0}`));
    players.append(chip);
  });
  const free = r.maxPlayers - r.players.length;
  if (free > 0 && r.status === 'waiting') players.append(h('div', 'game-player empty', free === 1 ? '1 vaga livre' : `${free} vagas livres`));
  const side = h('div', 'game-top-actions');
  const status = h('span', 'game-status muted small');
  status.id = 'game-status';
  if (r.status === 'waiting' && r.hostId === state.me?.id) {
    const start = h('button', 'btn primary', r.round ? 'Jogar de novo' : 'Começar partida');
    start.onclick = () => request({ t: 'game:start', roomId: r.id }).catch(fail);
    side.append(start);
  } else if (r.status === 'waiting') {
    status.textContent = `Esperando ${roomHost(r)} começar…`;
  }
  // Assistindo, com a sala esperando e vaga livre: dá para entrar no jogo
  if (!amPlayer() && r.status === 'waiting' && r.players.length < r.maxPlayers) {
    const play = h('button', 'btn primary', 'Entrar para jogar');
    play.onclick = () => request({ t: 'game:join', roomId: r.id }).then((res) => { games.room = res.room; renderGamesView(); renderGamesSidebar(); }).catch(fail);
    side.append(play);
  }
  const leave = h('button', 'btn link', 'Sair da sala');
  leave.onclick = leaveRoom;
  side.append(status, soundControl(), leave);
  top.append(players, side);

  const stage = h('div', 'game-stage');
  const overlay = h('div', 'game-overlay');
  overlay.id = 'game-overlay';
  if (GAME_INFO[r.game]?.dom) {
    const dom = h('div', 'game-dom');
    dom.id = 'game-dom';
    stage.classList.add('dom');
    stage.append(dom, overlay);
  } else {
    const canvas = h('canvas', 'game-canvas');
    canvas.id = 'game-canvas';
    stage.append(canvas, overlay);
  }
  if (r.status === 'waiting' && !games.snaps.length) {
    overlay.append(h('div', 'game-overlay-box', r.players.length < 2
      ? 'Chame alguém para jogar (dá para começar sozinho para treinar).'
      : `${r.players.length} jogadores prontos. ${r.hostId === state.me?.id ? 'Clique em "Começar partida"!' : 'Esperando começar…'}`));
  }
  const foot = h('div', 'game-foot');
  foot.append(controlsHelp(r.game), h('span', 'muted small', r.spectators ? `👀 ${r.spectators} assistindo` : ''),
    h('span', 'muted small', amPlayer() ? '' : 'Você está assistindo'));
  const info = GAME_INFO[r.game];
  const rules = optionsBox(r);
  const body = h('div', 'game-body');
  body.append(stage, chatPanel(r));
  const parts = [top, ...(rules ? [rules] : []), body];
  if (touchScreen() && info?.touch && amPlayer()) wrap.append(...parts, touchControls(info), foot);
  else wrap.append(...parts, foot);
  return wrap;
}

// ---------- Desenho da partida (60 quadros por segundo; cada jogo desenha do seu jeito) ----------

let drawing = false;

function startDrawing() {
  if (drawing) return;
  drawing = true;
  requestAnimationFrame(frame);
}

function frame() {
  const canvas = document.getElementById('game-canvas');
  if (!inGames() || !games.room || !canvas) { drawing = false; return; }
  const info = GAME_INFO[games.room.game];
  updateStatus(info?.draw(canvas, games.snaps, games.room));
  requestAnimationFrame(frame);
}

// Som dos jogos: liga/desliga e volume (fica salvo; vale para todos os jogos)
function soundControl() {
  const box = h('div', 'game-sound');
  const btn = h('button', 'icon-btn');
  btn.type = 'button';
  const range = h('input');
  Object.assign(range, { type: 'range', min: 0, max: 100, step: 5, value: Math.round(gameVolume() * 100), title: 'Volume dos sons do jogo' });
  const paint = () => {
    const on = gameSoundsOn() && Number(range.value) > 0;
    btn.replaceChildren(icon(on ? 'speaker' : 'volume-off', 18));
    btn.title = on ? 'Silenciar os sons do jogo' : 'Ligar os sons do jogo';
    btn.classList.toggle('off', !on);
    range.hidden = !gameSoundsOn();
    range.style.setProperty('--fill', `${range.value}%`);
  };
  btn.onclick = () => { setGameSounds(!gameSoundsOn()); paint(); if (gameSoundsOn()) sfx.pop(); };
  range.oninput = () => { setGameVolume(range.value); paint(); };
  range.onchange = () => sfx.pop(); // ouve como ficou
  box.append(btn, range);
  paint();
  return box;
}

// Relógio e números do jogo em cima; no meio, o resultado no fim (ou o recado que o jogo pedir)
let lastStatus = '';
let celebrated = null;
function updateStatus(out) {
  const s = games.snaps[games.snaps.length - 1]?.s;
  if (!s || !out) return;
  const text = games.room?.status === 'playing' ? out.status ?? '' : '';
  const el = document.getElementById('game-status');
  if (el && text !== lastStatus && games.room?.status === 'playing') { el.textContent = text; lastStatus = text; }
  const overlay = document.getElementById('game-overlay');
  if (!overlay) return;
  let msg = out.overlay ?? '';
  const matchKey = `${games.room?.id}:${games.room?.round}`;
  if (s.over && celebrated !== matchKey) {
    celebrated = matchKey; // uma festa por partida
    if (s.winner === state.me?.id && s.players.length > 1) confetti(); // o som da vitória vem do games/sfx.js
  }
  if (s.over) {
    const winner = s.players.find((p) => p.id === s.winner);
    if (winner) msg = `🏆 ${winner.id === state.me?.id ? 'Você venceu!' : `${winner.name} venceu!`}`;
    else msg = out.end ?? (s.players.length === 1 ? 'Fim do treino!' : 'Empate!');
  }
  if (overlay.dataset.msg !== msg) {
    overlay.dataset.msg = msg;
    overlay.replaceChildren(...(msg ? [h('div', 'game-overlay-box big', msg)] : []));
  }
}

// ---------- Controles (cada jogo diz o que fazer com as teclas e o mouse) ----------

const playing = () => inGames() && games.room?.status === 'playing' && amPlayer();
const typing = (e) => ['INPUT', 'TEXTAREA'].includes(e.target?.tagName) || e.target?.isContentEditable;
const current = () => GAME_INFO[games.room?.game];
const api = { send: (input) => { if (playing()) send({ t: 'game:input', roomId: games.room.id, ...input }); } };

window.addEventListener('keydown', (e) => {
  if (!playing() || typing(e)) return;
  if (current()?.keydown?.(e, api)) e.preventDefault();
});

window.addEventListener('keyup', (e) => { current()?.keyup?.(e, api); });

// Trocou de aba ou de janela: solta tudo (senão a pessoa sai andando sozinha)
window.addEventListener('blur', () => { current()?.blur?.(api); });

// Mouse no palco do jogo (mira, para onde ir, casa clicada)
for (const type of ['pointermove', 'pointerdown', 'pointerup']) {
  window.addEventListener(type, (e) => {
    const canvas = document.getElementById('game-canvas');
    if (!canvas || !playing() || !current()?.pointer) return;
    if (e.pointerType !== 'mouse' && e.target !== canvas) return; // dedo nas setas da tela não é mira
    const rect = canvas.getBoundingClientRect();
    current().pointer(type, { x: (e.clientX - rect.left) / rect.width, y: (e.clientY - rect.top) / rect.height, button: e.button, target: e.target, canvas }, api);
  });
}
