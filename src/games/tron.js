// Tron (cobrinhas de luz): cada pessoa anda sem parar e deixa um rastro; bateu em parede ou rastro, perdeu.
// Mesmo formato do Bomberman: o servidor chama tick() ~20x por segundo e manda state() para a sala.
//
// A arena é uma grade; todo mundo anda na mesma velocidade, então todos mudam de quadradinho juntos
// (quem entra no mesmo quadradinho ao mesmo tempo bate de frente e os dois perdem).

export const W = 64;
export const H = 44;
export const MAX_PLAYERS = 6;
export const COUNTDOWN_MS = 2000;   // parados, olhando o mapa, antes de largar
export const ROUND_MS = 180_000;
export const START_SPEED = 10;      // quadradinhos por segundo
const MAX_SPEED = 18;
const SPEEDUP_MS = 10_000;          // +1 de velocidade a cada 10 s (as partidas não se arrastam)

const DIRS = { up: [0, -1], down: [0, 1], left: [-1, 0], right: [1, 0] };
const OPPOSITE = { up: 'down', down: 'up', left: 'right', right: 'left' };

// Onde cada um larga e para onde começa andando
const SPAWNS = [
  [8, 11, 'right'], [W - 9, H - 12, 'left'], [8, H - 12, 'right'],
  [W - 9, 11, 'left'], [W / 2, 5, 'down'], [W / 2, H - 6, 'up'],
];

export class Tron {
  constructor(players) {
    this.grid = new Uint8Array(W * H); // 0 = livre; senão, cor + 1 de quem passou
    this.players = players.slice(0, MAX_PLAYERS).map((p, i) => {
      const [x, y, dir] = SPAWNS[i];
      this.grid[y * W + x] = i + 1;
      return {
        id: p.id, name: p.name, color: i,
        x, y, dir,
        turns: [],        // curvas pedidas e ainda não feitas (dá para apertar duas seguidas bem rápido)
        path: [[x, y]],   // cantos do rastro (o último trecho vai até a cabeça)
        alive: true,
      };
    });
    this.elapsed = 0;
    this.progress = 0; // quanto falta para o próximo quadradinho (0 a 1), igual para todos
    this.over = false;
    this.winner = null;
    this.solo = this.players.length === 1;
  }

  player(id) { return this.players.find((p) => p.id === id); }
  get speed() { return Math.min(MAX_SPEED, START_SPEED + Math.floor(Math.max(0, this.elapsed - COUNTDOWN_MS) / SPEEDUP_MS)); }

  input(id, { dir } = {}) {
    const p = this.player(id);
    if (!p || !p.alive || this.over || !DIRS[dir]) return;
    const last = p.turns[p.turns.length - 1] ?? p.dir;
    if (dir === last || dir === OPPOSITE[last] || p.turns.length >= 2) return; // não dá para voltar pelo próprio rastro
    p.turns.push(dir);
  }

  eliminate(id) {
    const p = this.player(id);
    if (p) p.alive = false;
  }

  tick(ms) {
    if (this.over) return;
    this.elapsed += ms;
    if (this.elapsed > COUNTDOWN_MS) {
      this.progress += (this.speed * ms) / 1000;
      while (this.progress >= 1 && !this.over) {
        this.progress -= 1;
        this.step();
      }
    }
    this.checkEnd();
  }

  // Todo mundo avança um quadradinho ao mesmo tempo
  step() {
    const moving = this.players.filter((p) => p.alive);
    const next = new Map(); // "x,y" -> quantos querem entrar
    for (const p of moving) {
      if (p.turns.length) {
        p.dir = p.turns.shift();
        p.path.push([p.x, p.y]); // fez a curva aqui
      }
      const [dx, dy] = DIRS[p.dir];
      p.nx = p.x + dx;
      p.ny = p.y + dy;
      const key = `${p.nx},${p.ny}`;
      next.set(key, (next.get(key) ?? 0) + 1);
    }
    for (const p of moving) {
      const outside = p.nx < 0 || p.ny < 0 || p.nx >= W || p.ny >= H;
      if (outside || this.grid[p.ny * W + p.nx] || next.get(`${p.nx},${p.ny}`) > 1) p.alive = false;
    }
    for (const p of moving) {
      if (p.alive) {
        p.x = p.nx;
        p.y = p.ny;
        this.grid[p.y * W + p.x] = p.color + 1;
      }
      delete p.nx;
      delete p.ny;
    }
    this.checkEnd();
  }

  checkEnd() {
    if (this.over) return;
    const alive = this.players.filter((p) => p.alive);
    if (this.solo ? alive.length === 0 : alive.length <= 1) {
      this.over = true;
      this.winner = this.solo ? null : alive[0]?.id ?? null; // todos bateram juntos: empate
    } else if (this.elapsed >= ROUND_MS) {
      this.over = true;
      this.winner = null;
    }
  }

  state() {
    return {
      w: W,
      h: H,
      players: this.players.map((p) => ({
        id: p.id, name: p.name, color: p.color, alive: p.alive, x: p.x, y: p.y, dir: p.dir, path: p.path,
      })),
      p: Math.round(this.progress * 100) / 100,
      speed: this.speed,
      countdown: Math.max(0, COUNTDOWN_MS - this.elapsed),
      timeLeft: Math.max(0, ROUND_MS - this.elapsed),
      over: this.over,
      winner: this.winner,
    };
  }
}
