// Ações da área de jogos (ícone fixo, igual para todos)
import { GAMES, listRooms, createRoom, joinRoom, leaveRoom, startGame, gameInput, weeklyLeaderboard, setOptions } from '../games/lobby.js';
import { underLimit } from '../util.js';

const inputTimes = new Map(); // userId -> últimos comandos (evita inundar o servidor)

export default {
  'games:list'() {
    return {
      t: 'games:rooms',
      games: Object.entries(GAMES).map(([id, g]) => ({
        id, name: g.name, maxPlayers: g.maxPlayers,
        options: Object.fromEntries(Object.entries(g.options ?? {}).map(([k, o]) => [k, { label: o.label, hint: o.hint }])),
      })),
      rooms: listRooms(),
    };
  },

  'games:leaderboard'() {
    return { t: 'games:leaderboard', week: weeklyLeaderboard() };
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
    gameInput(user, m.roomId, input);
  },
};
