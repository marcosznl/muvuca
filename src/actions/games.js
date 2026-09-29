// Ações da área de jogos (ícone fixo, igual para todos)
import {
  GAMES, listRooms, createRoom, joinRoom, leaveRoom, startGame, gameInput, weeklyLeaderboard, allTimeLeaderboard, setOptions, roomChat, syncRoom,
} from '../games/lobby.js';
import { achievements } from '../games/achievements.js';
import { db } from '../store.js';
import { underLimit } from '../util.js';

const inputTimes = new Map(); // userId -> últimos comandos (evita inundar o servidor)

export default {
  'games:list'() {
    // Mais jogados primeiro (partidas dos últimos 90 dias; empate fica na ordem de sempre).
    // Só a ordem vai para o site — a contagem não aparece para ninguém.
    const plays = db.gamePlays(90);
    const order = Object.keys(GAMES);
    const sorted = Object.entries(GAMES).sort(([a], [b]) => (plays[b] ?? 0) - (plays[a] ?? 0) || order.indexOf(a) - order.indexOf(b));
    return {
      t: 'games:rooms',
      games: sorted.map(([id, g]) => ({
        id, name: g.name, maxPlayers: g.maxPlayers, minPlayers: g.minPlayers ?? 1,
        options: Object.fromEntries(Object.entries(g.options ?? {}).map(([k, o]) => [k, { label: o.label, hint: o.hint }])),
      })),
      rooms: listRooms(),
    };
  },

  'games:leaderboard'() {
    return { t: 'games:leaderboard', week: weeklyLeaderboard(), all: allTimeLeaderboard() };
  },

  // Números e conquistas de alguém nos jogos (aparecem no perfil)
  'games:stats'(user, m) {
    const target = db.userById(String(m.userId ?? user.id)) ? String(m.userId ?? user.id) : user.id;
    const byGame = db.gameStats(target);
    return { t: 'games:stats', userId: target, byGame, achievements: achievements(byGame) };
  },

  'game:chat'(user, m) {
    roomChat(user, m.roomId, m.text);
  },

  'game:sync'(user, m) {
    return { t: 'game:sync', roomId: String(m.roomId), data: syncRoom(user, m.roomId) };
  },

  'game:create'(user, m) {
    return { t: 'game:room', room: createRoom(user, String(m.game)) };
  },

  'game:join'(user, m) {
    return { t: 'game:room', room: joinRoom(user, m.roomId, { watch: !!m.watch }) };
  },

  'game:leave'(user) {
    leaveRoom(user.id);
  },

  'game:options'(user, m) {
    setOptions(user, m.roomId, m.options);
  },

  'game:start'(user, m) {
    startGame(user, m.roomId);
  },

  // Comandos do jogo (chegam muitas vezes por segundo); cada jogo usa os que entende:
  // dir (setas/WASD, null ao soltar), bomb, fire, aim (ângulo da mira), x/y (para onde o mouse aponta), cell (casa clicada)
  'game:input'(user, m) {
    if (!underLimit(inputTimes, user.id, 40, 1000)) return;
    const input = {};
    if ('dir' in m) input.dir = m.dir === null ? null : String(m.dir).slice(0, 10);
    if (m.bomb) input.bomb = true;
    if (m.fire) input.fire = true;
    if (Number.isFinite(m.aim)) input.aim = Number(m.aim);
    if (Number.isFinite(m.x) && Number.isFinite(m.y)) { input.x = Number(m.x); input.y = Number(m.y); }
    if (Number.isInteger(m.cell)) input.cell = m.cell;
    if (Number.isInteger(m.card)) input.card = m.card;
    if (typeof m.color === 'string') input.color = m.color.slice(0, 10);
    if (typeof m.act === 'string') input.act = m.act.slice(0, 10);
    if (typeof m.target === 'string') input.target = m.target.slice(0, 20);
    if (typeof m.text === 'string') input.text = m.text.slice(0, 60);
    // Traço do desenho: pontos inteiros de 0 a 1000, cor e espessura da lista do jogo
    if (m.stroke && Array.isArray(m.stroke.p)) {
      input.stroke = {
        c: Number.isInteger(m.stroke.c) ? m.stroke.c : 0, w: Number.isInteger(m.stroke.w) ? m.stroke.w : 1,
        p: m.stroke.p.slice(0, 300).filter((pt) => Array.isArray(pt) && pt.length === 2).map(([x, y]) => [Math.max(0, Math.min(1000, x | 0)), Math.max(0, Math.min(1000, y | 0))]),
      };
    }
    // Respostas de formulário (Stop): até 10 campos de texto curto
    if (m.data && typeof m.data === 'object' && !Array.isArray(m.data)) {
      input.data = Object.fromEntries(Object.entries(m.data).slice(0, 10)
        .filter(([k]) => /^[\w-]{1,20}$/.test(k)).map(([k, v]) => [k, typeof v === 'boolean' ? v : String(v ?? '').slice(0, 40)]));
    }
    gameInput(user, m.roomId, input);
  },
};
