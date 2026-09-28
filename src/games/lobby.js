// Área de jogos: salas (criar, entrar, assistir, começar, sair) e a partida rodando no servidor
import crypto from 'node:crypto';
import { sockets, sendToUser } from '../realtime.js';
import { fail } from '../util.js';
import { db } from '../store.js';
import { announceGameRoom } from '../welcome.js';
import * as bomberman from './bomberman.js';
import * as tron from './tron.js';
import * as tanks from './tanks.js';
import * as agar from './agar.js';
import * as velha from './velha.js';
import * as cartas from './cartas.js';

// Jogos disponíveis (o site mostra nome e descrição na lista).
// Cada jogo é uma classe com input(), tick(ms), eliminate(id), state(), over e winner.
export const GAMES = {
  bomberman: { name: 'Bomberman', maxPlayers: bomberman.MAX_PLAYERS, create: (players) => new bomberman.Bomberman(players) },
  tron: { name: 'Tron', maxPlayers: tron.MAX_PLAYERS, create: (players) => new tron.Tron(players) },
  tanks: { name: 'Tanquinhos', maxPlayers: tanks.MAX_PLAYERS, create: (players) => new tanks.Tanks(players) },
  agar: { name: 'Agar', maxPlayers: agar.MAX_PLAYERS, create: (players) => new agar.Agar(players) },
  velha: { name: 'Jogo da velha', maxPlayers: velha.MAX_PLAYERS, create: (players, opts) => new velha.Velha(players, opts) },
  cartas: {
    name: 'Última!', maxPlayers: cartas.MAX_PLAYERS, options: cartas.RULES,
    create: (players, { options }) => new cartas.Cartas(players, { rules: options }),
  },
};

const TICK_MS = 50;       // 20 atualizações por segundo
const MAX_ROOMS = 10;
const END_PAUSE_MS = 2500; // mostra o resultado antes de voltar para a sala

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
  };
}

export const listRooms = () => [...rooms.values()].map(publicRoom);

// Todo mundo online vê a lista de salas (ícone fixo de jogos, igual para todos)
function broadcastRooms() {
  const msg = { t: 'games:rooms', rooms: listRooms() };
  for (const id of sockets.keys()) sendToUser(id, msg);
}

const members = (r) => [...r.players.map((p) => p.id), ...r.spectators];
const sendToRoom = (r, msg) => { for (const id of members(r)) sendToUser(id, msg); };
// Jogos de cartas: cada um vê só a própria mão (stateFor); os outros jogos mandam o mesmo para todos
const stateOf = (r, userId) => (r.engine.stateFor ? r.engine.stateFor(userId) : r.engine.state());
function sendState(r) {
  if (!r.engine.stateFor) return sendToRoom(r, { t: 'game:state', roomId: r.id, state: r.engine.state() });
  for (const id of members(r)) sendToUser(id, { t: 'game:state', roomId: r.id, state: r.engine.stateFor(id) });
}

function changed(r) {
  sendToRoom(r, { t: 'game:room', room: publicRoom(r) });
  broadcastRooms();
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
    // Opções do jogo (ex.: regras da casa), cada uma com o valor padrão
    options: Object.fromEntries(Object.entries(GAMES[game].options ?? {}).map(([k, o]) => [k, !!o.default])),
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
  for (const k of Object.keys(r.options)) if (typeof options?.[k] === 'boolean') r.options[k] = options[k];
  changed(r);
}

// Só quem criou (ou herdou) a sala começa; a partida roda aqui no servidor
export function startGame(user, roomId) {
  const r = requireRoom(roomId);
  if (r.hostId !== user.id) fail('Só quem manda na sala pode começar.');
  if (r.status === 'playing') fail('A partida já está rolando.');
  if (!r.players.length) fail('A sala está sem jogadores.');
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
  // Jogos por turno avisam quando nada mudou (dirty = false) e não mandam a mesma coisa 20x por segundo
  if (r.engine.dirty !== false) {
    sendState(r);
    if ('dirty' in r.engine) r.engine.dirty = false;
  }
  if (!r.engine.over) return;
  clearInterval(r.timer);
  r.timer = null;
  const winner = r.engine.winner;
  if (winner) r.scores[winner] = (r.scores[winner] ?? 0) + 1;
  r.lastWinner = winner;
  recordResult(r, winner);
  setTimeout(() => {
    if (!rooms.has(r.id)) return;
    r.status = 'waiting';
    changed(r);
  }, END_PAUSE_MS);
}

// Placar da semana: só conta partida com pelo menos 2 pessoas de verdade (robô e treino não contam)
const isPerson = (id) => /^u\d+$/.test(String(id));
function recordResult(r, winner) {
  const people = r.engine.players.map((p) => p.id).filter(isPerson);
  if (people.length < 2) return;
  db.addGameResult(r.game, isPerson(winner) ? winner : null, people);
  const msg = { t: 'games:leaderboard', week: weeklyLeaderboard() };
  for (const id of sockets.keys()) sendToUser(id, msg);
}

export const weeklyLeaderboard = () => db.leaderboard(Date.now() - 7 * 86_400_000);

export function gameInput(user, roomId, input) {
  const r = rooms.get(String(roomId));
  if (!r || r.status !== 'playing' || !r.engine) return;
  r.engine.input(user.id, input);
}
