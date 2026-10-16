// Área de jogos: salas (criar, entrar, assistir, começar, sair) e a partida rodando no servidor
import crypto from 'node:crypto';
import { sockets, sendToUser, broadcastPresence, setActivityProvider } from '../realtime.js';
import { fail } from '../util.js';
import { db } from '../store.js';
import { announceGameRoom } from '../welcome.js';
import * as bomberman from './bomberman.js';
import * as desenho from './desenho.js';
import * as stop from './stop.js';

// Jogos disponíveis (o site mostra nome e descrição na lista).
// Cada jogo é uma classe com input(), tick(ms), eliminate(id), state(), over e winner.
export const GAMES = {
  bomberman: {
    name: 'Bomberman', maxPlayers: bomberman.MAX_PLAYERS, options: bomberman.OPTIONS,
    create: (players, { options }) => new bomberman.Bomberman(players, { options }),
  },
  desenho: {
    name: 'Desenha aí', maxPlayers: desenho.MAX_PLAYERS, minPlayers: 2, options: desenho.OPTIONS,
    create: (players, { options }) => new desenho.Desenho(players, { options, customWords: db.gameWords() }),
  },
  stop: { name: 'Stop', maxPlayers: stop.MAX_PLAYERS, create: (players) => new stop.Stop(players) },
};

const TICK_MS = 50;       // 20 atualizações por segundo
const CHAT_KEEP = 50;     // últimas mensagens do chat da sala
const MAX_ROOMS = 10;
const END_PAUSE_MS = 2500; // mostra o resultado antes de voltar para a sala
const SERIES_NEXT_MS = 6000; // série: a próxima partida começa sozinha depois disso

const rooms = new Map(); // id -> sala

function publicRoom(r) {
  return {
    id: r.id,
    game: r.game,
    maxPlayers: GAMES[r.game].maxPlayers,
    options: r.options,
    hostId: r.hostId,
    players: r.players.map((p) => ({ id: p.id, name: p.name })),
    spectators: r.spectators.size,
    status: r.status, // 'waiting' (esperando), 'playing' (jogando)
    scores: r.scores,
    round: r.round,
    lastWinner: r.lastWinner,
    // Série (melhor de 3/5): vitórias de cada um nesta série
    series: seriesTarget(r) > 1 ? { target: seriesTarget(r), wins: r.seriesWins ?? {} } : null,
  };
}

// Série: jogos com a opção "serie" (ex.: Bomberman); 1 = partida única
const seriesTarget = (r) => (GAMES[r.game].options?.serie ? Number(r.options?.serie) || 1 : 1);

// Fim de uma partida numa série: soma a vitória; se alguém fechou a série, anuncia e zera; senão, a próxima começa sozinha
function afterSeriesMatch(r, winner) {
  const target = seriesTarget(r);
  if (target <= 1) return;
  r.seriesWins ??= {};
  const nameOf = (id) => r.engine?.players.find((p) => p.id === id)?.name ?? 'Alguém';
  if (winner) r.seriesWins[winner] = (r.seriesWins[winner] ?? 0) + 1;
  const need = Math.ceil(target / 2);
  const score = Object.entries(r.seriesWins).sort((a, b) => b[1] - a[1]).map(([id, n]) => `${nameOf(id)} ${n}`).join(' × ');
  if (winner && r.seriesWins[winner] >= need) {
    pushLine(r, { kind: 'good', text: `🏆 ${nameOf(winner)} venceu a série (melhor de ${target})! Placar: ${score}` });
    r.seriesWins = {};
    return;
  }
  pushLine(r, { kind: 'info', text: `Série (melhor de ${target}): ${score || 'ninguém venceu essa'} — a próxima começa em ${SERIES_NEXT_MS / 1000} s` });
  clearTimeout(r.nextTimer);
  r.nextTimer = setTimeout(() => {
    if (!rooms.has(r.id) || r.status !== 'waiting' || !r.players.length) return;
    if (r.players.length < (GAMES[r.game].minPlayers ?? 1)) return;
    beginMatch(r);
  }, END_PAUSE_MS + SERIES_NEXT_MS);
}

export const listRooms = () => [...rooms.values()].map(publicRoom);

// Todo mundo online vê a lista de salas (ícone fixo de jogos, igual para todos)
function broadcastRooms() {
  const data = JSON.stringify({ t: 'games:rooms', rooms: listRooms() });
  for (const id of sockets.keys()) sendToUser(id, data);
}

const members = (r) => [...r.players.map((p) => p.id), ...r.spectators];
const sendToRoom = (r, msg) => { const data = JSON.stringify(msg); for (const id of members(r)) sendToUser(id, data); };
// Jogos com informação escondida (stateFor, ex.: a palavra do Desenha aí): cada um recebe a sua versão
const stateOf = (r, userId) => (r.engine.stateFor ? r.engine.stateFor(userId) : r.engine.state());
function sendState(r) {
  if (!r.engine.stateFor) return sendToRoom(r, { t: 'game:state', roomId: r.id, state: r.engine.state() });
  for (const id of members(r)) sendToUser(id, { t: 'game:state', roomId: r.id, state: r.engine.stateFor(id) });
}

function changed(r) {
  sendToRoom(r, { t: 'game:room', room: publicRoom(r) });
  broadcastRooms();
  broadcastPresence(); // "Jogando…" de quem entrou/saiu
}

// "Jogando Stop": quem está numa sala como jogador
setActivityProvider(() => {
  const out = {};
  for (const r of rooms.values()) {
    for (const p of r.players) out[p.id] = { game: r.game, name: GAMES[r.game].name, roomId: r.id, playing: r.status === 'playing' };
  }
  return out;
});

// ---------- Chat da sala ----------

let lineSeq = 0;
function pushLine(r, line, onlyTo = null) {
  const full = { id: ++lineSeq, ts: Date.now(), ...line };
  if (onlyTo) return sendToUser(onlyTo, { t: 'game:chat', roomId: r.id, line: full });
  r.chat.push(full);
  if (r.chat.length > CHAT_KEEP) r.chat.shift();
  sendToRoom(r, { t: 'game:chat', roomId: r.id, line: full });
}

// O jogo pode "pegar" a mensagem (ex.: palpite certo no desenho não aparece para os outros)
export function roomChat(user, roomId, text) {
  const r = requireRoom(roomId);
  if (!members(r).includes(user.id)) fail('Entre na sala para conversar.');
  const clean = String(text ?? '').replace(/\s+/g, ' ').trim().slice(0, 200);
  if (!clean) return;
  const handled = r.status === 'playing' && r.engine?.chat?.(user.id, clean);
  if (handled?.private) pushLine(r, { kind: 'private', text: handled.private }, user.id);
  if (handled?.hide) return;
  pushLine(r, { userId: user.id, name: user.name, text: clean });
}

// Eventos do jogo que vão na hora (traços do desenho, avisos no chat)
function flushEvents(r) {
  const events = r.engine.drainEvents?.() ?? [];
  const draw = [];
  for (const ev of events) {
    if (ev.type === 'line') pushLine(r, { kind: ev.kind ?? 'info', text: ev.text }, ev.to ?? null);
    else draw.push(ev);
  }
  if (draw.length) sendToRoom(r, { t: 'game:events', roomId: r.id, events: draw });
}

// Quem chegou no meio: o jogo manda o que precisa (ex.: o desenho inteiro)
export function syncRoom(user, roomId) {
  const r = requireRoom(roomId);
  if (!members(r).includes(user.id) || !r.engine) return null;
  return r.engine.fullState?.(user.id) ?? null;
}

export function roomOf(userId) {
  for (const r of rooms.values()) if (r.players.some((p) => p.id === userId) || r.spectators.has(userId)) return r;
  return null;
}

function requireRoom(roomId) {
  const r = rooms.get(String(roomId));
  if (!r) fail('Essa sala não existe mais.');
  return r;
}

export function createRoom(user, game) {
  if (!GAMES[game]) fail('Jogo desconhecido.');
  if (rooms.size >= MAX_ROOMS) fail('Já tem salas demais abertas. Entre numa delas!');
  leaveRoom(user.id);
  const r = {
    id: `g-${crypto.randomBytes(4).toString('hex')}`,
    game,
    hostId: user.id,
    players: [{ id: user.id, name: user.name }],
    spectators: new Set(),
    status: 'waiting',
    scores: {},
    round: 0,
    lastWinner: null,
    engine: null,
    timer: null,
    chat: [],
    // Opções do jogo (regras da casa, tema, tempo…), cada uma com o valor padrão.
    // Liga/desliga, ou uma escolha entre valores (choices: [[valor, rótulo], …])
    options: Object.fromEntries(Object.entries(GAMES[game].options ?? {}).map(([k, o]) => [k, o.choices ? o.default : !!o.default])),
  };
  rooms.set(r.id, r);
  changed(r);
  announceGameRoom(user, r, GAMES[game].name); // "fulano abriu uma sala" no chat dos servidores dele
  return publicRoom(r);
}

// Entra como jogador (se a sala está esperando e tem vaga) ou como plateia
export function joinRoom(user, roomId, { watch = false } = {}) {
  const r = requireRoom(roomId);
  const already = roomOf(user.id);
  if (already && already !== r) leaveRoom(user.id);
  const isPlayer = r.players.some((p) => p.id === user.id);
  if (!isPlayer) {
    const canPlay = !watch && r.status === 'waiting' && r.players.length < GAMES[r.game].maxPlayers;
    if (canPlay) {
      r.spectators.delete(user.id); // quem estava assistindo passa a jogar
      r.players.push({ id: user.id, name: user.name });
      if (!r.hostId) r.hostId = user.id; // sala sem ninguém mandando: quem entra assume
    } else r.spectators.add(user.id);
  }
  changed(r);
  if (r.engine) sendToUser(user.id, { t: 'game:state', roomId: r.id, state: stateOf(r, user.id) });
  sendToUser(user.id, { t: 'game:chatlog', roomId: r.id, lines: r.chat });
  return publicRoom(r);
}

export function leaveRoom(userId) {
  const r = roomOf(userId);
  if (!r) return;
  r.spectators.delete(userId);
  const wasPlayer = r.players.some((p) => p.id === userId);
  r.players = r.players.filter((p) => p.id !== userId);
  // Saiu no meio da partida: conta como eliminado
  if (wasPlayer && r.engine && !r.engine.over) r.engine.eliminate(userId);
  sendToUser(userId, { t: 'game:left', roomId: r.id });
  if (!r.players.length && !r.spectators.size) {
    clearInterval(r.timer);
    clearTimeout(r.nextTimer); // série esperando a próxima partida
    rooms.delete(r.id);
    broadcastRooms();
    return;
  }
  if (r.hostId === userId) r.hostId = r.players[0]?.id ?? null; // a sala passa para o próximo
  changed(r);
}

// Quem manda na sala liga/desliga as opções (só antes de começar)
export function setOptions(user, roomId, options) {
  const r = requireRoom(roomId);
  if (r.hostId !== user.id) fail('Só quem manda na sala muda as regras.');
  if (r.status === 'playing') fail('Espere a partida acabar para mudar as regras.');
  const defs = GAMES[r.game].options ?? {};
  if (options?.serie !== undefined && options.serie !== r.options.serie) r.seriesWins = {}; // série nova
  for (const k of Object.keys(r.options)) {
    const v = options?.[k];
    if (v === undefined) continue;
    if (defs[k]?.choices ? defs[k].choices.some(([c]) => c === v) : typeof v === 'boolean') r.options[k] = v;
  }
  changed(r);
}

// Só quem criou (ou herdou) a sala começa; a partida roda aqui no servidor
export function startGame(user, roomId) {
  const r = requireRoom(roomId);
  if (r.hostId !== user.id) fail('Só quem manda na sala pode começar.');
  if (r.status === 'playing') fail('A partida já está rolando.');
  if (!r.players.length) fail('A sala está sem jogadores.');
  const min = GAMES[r.game].minPlayers ?? 1;
  if (r.players.length < min) fail(`${GAMES[r.game].name} precisa de pelo menos ${min} pessoas.`);
  clearTimeout(r.nextTimer); // começou na mão antes da série começar sozinha
  beginMatch(r);
}

function beginMatch(r) {
  r.engine = GAMES[r.game].create(r.players, { round: r.round, options: r.options });
  r.status = 'playing';
  r.round += 1;
  r.lastWinner = null;
  changed(r);
  clearInterval(r.timer);
  r.timer = setInterval(() => tick(r), TICK_MS);
}

function tick(r) {
  r.engine.tick(TICK_MS);
  flushEvents(r);
  // Jogos por turno avisam quando nada mudou (dirty = false) e não mandam a mesma coisa 20x por segundo
  if (r.engine.dirty !== false) {
    sendState(r);
    if ('dirty' in r.engine) r.engine.dirty = false;
  }
  if (!r.engine.over) return;
  clearInterval(r.timer);
  r.timer = null;
  const winner = r.engine.winner;
  const winners = r.engine.winners ?? (winner ? [winner] : []); // jogos em que várias pessoas ganham juntas
  for (const w of winners) r.scores[w] = (r.scores[w] ?? 0) + 1;
  r.lastWinner = winner;
  recordResult(r, winners);
  afterSeriesMatch(r, winner);
  setTimeout(() => {
    if (!rooms.has(r.id)) return;
    r.status = 'waiting';
    changed(r);
  }, END_PAUSE_MS);
}

// Placar da semana: só conta partida com pelo menos 2 pessoas de verdade (robô e treino não contam)
const isPerson = (id) => /^u\d+$/.test(String(id));
function recordResult(r, winners) {
  const people = r.engine.players.map((p) => p.id).filter(isPerson);
  if (people.length < 2) return;
  db.addGameResult(r.game, winners.filter(isPerson), people);
  const msg = { t: 'games:leaderboard', week: weeklyLeaderboard(), all: allTimeLeaderboard() };
  for (const id of sockets.keys()) sendToUser(id, msg);
}

export const weeklyLeaderboard = () => db.leaderboard(Date.now() - 7 * 86_400_000);
export const allTimeLeaderboard = () => db.leaderboard(0);

export function gameInput(user, roomId, input) {
  const r = rooms.get(String(roomId));
  if (!r || r.status !== 'playing' || !r.engine) return;
  r.engine.input(user.id, input);
}
