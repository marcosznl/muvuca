// Tanquinhos: arena vista de cima; anda com as setas/WASD, mira com o mouse e atira.
// A bala quica uma vez na parede (dá para acertar dobrando a esquina). 3 tiros e o tanque estoura.
// Sozinho, aparece um robô para treinar.
//
// Tudo em "ladrilhos" (a arena tem W×H); posições com vírgula, sem grade.

export const W = 20;
export const H = 13;
export const MAX_PLAYERS = 4;
export const COUNTDOWN_MS = 1500;
export const ROUND_MS = 180_000;
export const TANK_R = 0.45;
export const SPEED = 3.5;          // ladrilhos por segundo
export const BULLET_SPEED = 9;
export const BULLET_R = 0.12;
export const MAX_BOUNCES = 1;
export const RELOAD_MS = 450;
export const MAX_BULLETS = 3;      // no ar ao mesmo tempo, por tanque
export const HP = 3;
const BULLET_LIFE_MS = 3000;
const SAFE_MS = 120;               // a bala acabou de sair do cano: não acerta quem atirou

// Obstáculos (x, y, largura, altura), espelhados para ninguém ter vantagem
export const WALLS = [
  [8.5, 5, 3, 3],
  [4.5, 2, 1, 4], [14.5, 7, 1, 4],
  [2, 9.5, 4, 1], [14, 2.5, 4, 1],
  [9.5, 0, 1, 2], [9.5, 11, 1, 2],
];

const SPAWNS = [[1.5, 1.5, 0], [W - 1.5, H - 1.5, Math.PI], [W - 1.5, 1.5, Math.PI], [1.5, H - 1.5, 0]];
const DIRS = {
  up: [0, -1], down: [0, 1], left: [-1, 0], right: [1, 0],
  'up-left': [-Math.SQRT1_2, -Math.SQRT1_2], 'up-right': [Math.SQRT1_2, -Math.SQRT1_2],
  'down-left': [-Math.SQRT1_2, Math.SQRT1_2], 'down-right': [Math.SQRT1_2, Math.SQRT1_2],
};

// Bate numa parede (ou sai da arena)?
function circleHitsWall(x, y, r) {
  if (x - r < 0 || y - r < 0 || x + r > W || y + r > H) return true;
  return WALLS.some(([wx, wy, ww, wh]) => {
    const nx = Math.max(wx, Math.min(x, wx + ww));
    const ny = Math.max(wy, Math.min(y, wy + wh));
    return (x - nx) ** 2 + (y - ny) ** 2 < r * r;
  });
}

const round2 = (v) => Math.round(v * 100) / 100;

export class Tanks {
  constructor(players, { bot = players.length === 1, random = Math.random } = {}) {
    this.random = random;
    const list = players.slice(0, MAX_PLAYERS).map((p) => ({ id: p.id, name: p.name }));
    if (bot) list.push({ id: 'bot', name: 'Robô', bot: true });
    this.players = list.map((p, i) => ({
      ...p, color: i,
      x: SPAWNS[i][0], y: SPAWNS[i][1], angle: SPAWNS[i][2], aim: SPAWNS[i][2],
      dir: null, reload: 0, hp: HP, kills: 0, alive: true,
      think: 0, // só o robô usa: tempo até decidir de novo
    }));
    this.bullets = []; // { x, y, vx, vy, owner, bounces, age }
    this.elapsed = 0;
    this.over = false;
    this.winner = null;
  }

  player(id) { return this.players.find((p) => p.id === id); }

  input(id, { dir, aim, fire } = {}) {
    const p = this.player(id);
    if (!p || !p.alive || this.over) return;
    if (dir !== undefined) p.dir = DIRS[dir] ? dir : null;
    if (aim !== undefined) p.aim = aim;
    if (fire) this.fire(p);
  }

  eliminate(id) {
    const p = this.player(id);
    if (p) p.alive = false;
  }

  fire(p) {
    if (this.elapsed < COUNTDOWN_MS || p.reload > 0) return;
    if (this.bullets.filter((b) => b.owner === p.id).length >= MAX_BULLETS) return;
    const dx = Math.cos(p.aim);
    const dy = Math.sin(p.aim);
    const x = p.x + dx * (TANK_R + 0.2);
    const y = p.y + dy * (TANK_R + 0.2);
    if (circleHitsWall(x, y, BULLET_R)) return; // cano encostado na parede
    this.bullets.push({ x, y, vx: dx * BULLET_SPEED, vy: dy * BULLET_SPEED, owner: p.id, bounces: 0, age: 0 });
    p.reload = RELOAD_MS;
  }

  tick(ms) {
    if (this.over) return;
    this.elapsed += ms;
    if (this.elapsed >= COUNTDOWN_MS) {
      for (const p of this.players) {
        if (!p.alive) continue;
        p.reload = Math.max(0, p.reload - ms);
        if (p.bot) this.botThink(p, ms);
        this.move(p, ms);
      }
      this.moveBullets(ms);
    }
    this.checkEnd();
  }

  move(p, ms) {
    if (!p.dir) return;
    const [dx, dy] = DIRS[p.dir];
    p.angle = Math.atan2(dy, dx);
    const step = (SPEED * ms) / 1000;
    // Anda em x e em y separados: encostado na parede, desliza em vez de travar
    for (const [ax, ay] of [[dx * step, 0], [0, dy * step]]) {
      const nx = p.x + ax;
      const ny = p.y + ay;
      const blocked = circleHitsWall(nx, ny, TANK_R) || this.players.some((o) => o !== p && o.alive
        && (o.x - nx) ** 2 + (o.y - ny) ** 2 < (TANK_R * 2) ** 2);
      if (!blocked) { p.x = nx; p.y = ny; }
    }
  }

  moveBullets(ms) {
    const dt = ms / 1000;
    const keep = [];
    for (const b of this.bullets) {
      b.age += ms;
      // Anda em passinhos (a bala é rápida e não pode atravessar parede fina)
      const steps = Math.ceil((Math.hypot(b.vx, b.vy) * dt) / 0.2);
      let alive = b.age < BULLET_LIFE_MS;
      for (let i = 0; i < steps && alive; i++) {
        const nx = b.x + (b.vx * dt) / steps;
        const ny = b.y + (b.vy * dt) / steps;
        if (circleHitsWall(nx, ny, BULLET_R)) {
          if (b.bounces >= MAX_BOUNCES) { alive = false; break; }
          b.bounces += 1;
          // Quica no eixo que bateu
          const hitX = circleHitsWall(nx, b.y, BULLET_R);
          const hitY = circleHitsWall(b.x, ny, BULLET_R);
          if (hitX || !hitY) b.vx = -b.vx; // bateu bem na quina: volta pelo mesmo caminho
          if (hitY || !hitX) b.vy = -b.vy;
          continue;
        }
        b.x = nx;
        b.y = ny;
        const hit = this.players.find((p) => p.alive && (p.id !== b.owner || b.age > SAFE_MS || b.bounces)
          && (p.x - b.x) ** 2 + (p.y - b.y) ** 2 < (TANK_R + BULLET_R) ** 2);
        if (hit) {
          alive = false;
          hit.hp -= 1;
          if (hit.hp <= 0) {
            hit.alive = false;
            const shooter = this.player(b.owner);
            if (shooter && shooter !== hit) shooter.kills += 1;
          }
        }
      }
      if (alive) keep.push(b);
    }
    this.bullets = keep;
  }

  // Robô de treino: anda meio sem rumo, mira em quem está mais perto (errando um pouco) e atira
  botThink(p, ms) {
    p.think -= ms;
    const target = this.players.filter((o) => o.alive && o !== p)
      .sort((a, b) => Math.hypot(a.x - p.x, a.y - p.y) - Math.hypot(b.x - p.x, b.y - p.y))[0];
    if (target) p.aim = Math.atan2(target.y - p.y, target.x - p.x) + (this.random() - 0.5) * 0.6;
    if (p.think > 0) return;
    p.think = 600 + this.random() * 900;
    const dirs = Object.keys(DIRS);
    p.dir = this.random() < 0.2 ? null : dirs[Math.floor(this.random() * dirs.length)];
    if (target && this.random() < 0.5) this.fire(p);
  }

  checkEnd() {
    const alive = this.players.filter((p) => p.alive);
    if (alive.length <= 1) {
      this.over = true;
      this.winner = alive[0]?.id ?? null;
    } else if (this.elapsed >= ROUND_MS) {
      this.over = true;
      this.winner = null;
    }
  }

  state() {
    return {
      w: W,
      h: H,
      walls: WALLS,
      players: this.players.map((p) => ({
        id: p.id, name: p.name, color: p.color, alive: p.alive, bot: !!p.bot,
        x: round2(p.x), y: round2(p.y), angle: round2(p.angle), aim: round2(p.aim), hp: p.hp, kills: p.kills,
      })),
      bullets: this.bullets.map((b) => [round2(b.x), round2(b.y)]),
      countdown: Math.max(0, COUNTDOWN_MS - this.elapsed),
      timeLeft: Math.max(0, ROUND_MS - this.elapsed),
      over: this.over,
      winner: this.winner,
    };
  }
}
