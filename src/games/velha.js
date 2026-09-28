// Jogo da velha: 2 pessoas (ou 1 contra o robô). Quem começa alterna a cada partida.
// Cada vez tem 20 s; se o tempo acabar, a jogada sai sozinha numa casa livre.
// Por turno: só avisa o servidor que mudou algo (dirty) para não mandar a mesma coisa 20x por segundo.

export const MAX_PLAYERS = 2;
export const TURN_MS = 20_000;
export const BOT_DELAY_MS = 700;
const BOT_MISTAKE = 0.25; // o robô às vezes joga qualquer coisa (senão ninguém ganha dele)

export const LINES = [[0, 1, 2], [3, 4, 5], [6, 7, 8], [0, 3, 6], [1, 4, 7], [2, 5, 8], [0, 4, 8], [2, 4, 6]];

export function lineOf(board) {
  return LINES.find(([a, b, c]) => board[a] !== null && board[a] === board[b] && board[a] === board[c]) ?? null;
}

// Melhor casa para quem joga com `me` (minimax: o tabuleiro é pequeno, dá para ver tudo)
export function bestMove(board, me) {
  const other = 1 - me;
  function score(b, turn, depth) {
    const line = lineOf(b);
    if (line) return b[line[0]] === me ? 10 - depth : depth - 10;
    if (b.every((v) => v !== null)) return 0;
    let best = turn === me ? -Infinity : Infinity;
    for (let i = 0; i < 9; i++) {
      if (b[i] !== null) continue;
      b[i] = turn;
      const s = score(b, turn === me ? other : me, depth + 1);
      b[i] = null;
      best = turn === me ? Math.max(best, s) : Math.min(best, s);
    }
    return best;
  }
  let pick = null;
  let best = -Infinity;
  for (let i = 0; i < 9; i++) {
    if (board[i] !== null) continue;
    board[i] = me;
    const s = score(board, other, 1);
    board[i] = null;
    if (s > best) { best = s; pick = i; }
  }
  return pick;
}

export class Velha {
  constructor(players, { round = 0, random = Math.random } = {}) {
    this.random = random;
    const list = players.slice(0, MAX_PLAYERS).map((p) => ({ id: p.id, name: p.name }));
    if (list.length === 1) list.push({ id: 'bot', name: 'Robô', bot: true });
    this.players = list.map((p, i) => ({ ...p, color: i, mark: i === 0 ? 'X' : 'O', alive: true }));
    this.board = Array(9).fill(null); // null ou o número (0/1) de quem marcou
    this.turn = round % 2;            // quem começa alterna
    this.turnLeft = TURN_MS;
    this.line = null;
    this.over = false;
    this.winner = null;
    this.dirty = true;
  }

  player(id) { return this.players.find((p) => p.id === id); }

  input(id, { cell } = {}) {
    const p = this.player(id);
    if (!p || this.over || this.players[this.turn] !== p) return;
    if (!Number.isInteger(cell) || cell < 0 || cell > 8 || this.board[cell] !== null) return;
    this.play(cell);
  }

  eliminate(id) {
    const p = this.player(id);
    if (!p || this.over) return;
    p.alive = false;
    this.over = true;
    this.winner = this.players.find((o) => o !== p)?.id ?? null; // saiu: o outro vence
    this.dirty = true;
  }

  play(cell) {
    this.board[cell] = this.turn;
    this.line = lineOf(this.board);
    if (this.line) {
      this.over = true;
      this.winner = this.players[this.turn].id;
    } else if (this.board.every((v) => v !== null)) {
      this.over = true; // deu velha
    } else {
      this.turn = 1 - this.turn;
      this.turnLeft = TURN_MS;
    }
    this.dirty = true;
  }

  tick(ms) {
    if (this.over) return;
    this.turnLeft -= ms;
    const p = this.players[this.turn];
    if (p.bot && this.turnLeft <= TURN_MS - BOT_DELAY_MS) {
      const free = this.board.map((v, i) => (v === null ? i : -1)).filter((i) => i >= 0);
      const cell = this.random() < BOT_MISTAKE ? free[Math.floor(this.random() * free.length)] : bestMove(this.board, this.turn);
      this.play(cell);
    } else if (this.turnLeft <= 0) {
      const free = this.board.map((v, i) => (v === null ? i : -1)).filter((i) => i >= 0);
      this.play(free[Math.floor(this.random() * free.length)]); // tempo esgotado: joga sozinho
    }
  }

  state() {
    return {
      board: this.board,
      players: this.players.map((p) => ({ id: p.id, name: p.name, color: p.color, mark: p.mark, alive: p.alive, bot: !!p.bot })),
      turn: this.over ? null : this.players[this.turn].id,
      turnLeft: Math.max(0, Math.round(this.turnLeft)),
      line: this.line,
      over: this.over,
      winner: this.winner,
    };
  }
}
