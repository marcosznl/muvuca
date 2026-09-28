// Agar-lite: cada pessoa é uma bolinha que segue o mouse, come comidinhas e engole quem for bem menor.
// Quem é engolido volta pequeno depois de um instante. Ganha quem estiver maior quando o tempo acabar.
// Com pouca gente, entram robôs para a arena não ficar vazia.

export const WORLD = 80;           // a arena é um quadrado WORLD×WORLD
export const MAX_PLAYERS = 8;
export const COUNTDOWN_MS = 1500;
export const ROUND_MS = 150_000;
export const START_MASS = 10;
export const PELLETS = 300;
export const EAT_RATIO = 1.2;      // precisa ser 20% maior para engolir
const PELLET_RESPAWN_MS = 4000;
const RESPAWN_MS = 2500;
const MAX_MASS = 2000;
const DECAY = 0.004;               // gordas perdem 0,4% por segundo (ninguém dispara sozinho para sempre)
const MIN_CELLS = 4;               // com menos gente que isso, completa com robôs
const MAX_REACH = 30;              // até onde vale o mouse (em unidades da arena)

export const radius = (mass) => Math.sqrt(mass) * 0.35;
export const speedOf = (mass) => 10 * radius(mass) ** -0.45;

// Onde fica cada comidinha: fixo pelo número dela (o site calcula igual, sem precisar mandar)
export function pelletPos(i) {
  const f = (n) => { const v = Math.sin(n * 12.9898 + 78.233) * 43758.5453; return v - Math.floor(v); };
  return [1 + f(i * 2 + 1) * (WORLD - 2), 1 + f(i * 2 + 2) * (WORLD - 2)];
}

const round1 = (v) => Math.round(v * 10) / 10;

export class Agar {
  constructor(players, { bots = true, random = Math.random } = {}) {
    this.random = random;
    const list = players.slice(0, MAX_PLAYERS).map((p) => ({ id: p.id, name: p.name }));
    const botCount = bots ? Math.max(0, MIN_CELLS - list.length) : 0;
    for (let i = 1; i <= botCount; i++) list.push({ id: `bot${i}`, name: `Robô ${i}`, bot: true });
    this.players = list.map((p, i) => ({
      ...p, color: i, x: 0, y: 0, mass: START_MASS, alive: true, gone: false,
      dx: 0, dy: 0, respawn: 0, best: START_MASS, eaten: 0, think: 0,
    }));
    for (const p of this.players) this.place(p);
    this.pellets = Array.from({ length: PELLETS }, () => 0); // 0 = tem comida; senão, ms até voltar
    this.elapsed = 0;
    this.over = false;
    this.winner = null;
  }

  player(id) { return this.players.find((p) => p.id === id); }

  // Nasce num lugar longe de quem pode engolir
  place(p) {
    let best = null;
    for (let i = 0; i < 12; i++) {
      const x = 5 + this.random() * (WORLD - 10);
      const y = 5 + this.random() * (WORLD - 10);
      const danger = Math.min(99, ...this.players.filter((o) => o !== p && o.alive && !o.gone)
        .map((o) => Math.hypot(o.x - x, o.y - y) - radius(o.mass)));
      if (!best || danger > best.danger) best = { x, y, danger };
    }
    p.x = best.x;
    p.y = best.y;
  }

  // x/y: para onde o mouse aponta, em relação à própria bolinha
  input(id, { x, y } = {}) {
    const p = this.player(id);
    if (!p || p.gone || this.over || x === undefined) return;
    const len = Math.hypot(x, y);
    const k = len > MAX_REACH ? MAX_REACH / len : 1;
    p.dx = x * k;
    p.dy = y * k;
  }

  eliminate(id) {
    const p = this.player(id);
    if (p) { p.gone = true; p.alive = false; }
  }

  tick(ms) {
    if (this.over) return;
    this.elapsed += ms;
    if (this.elapsed < COUNTDOWN_MS) return;
    const dt = ms / 1000;
    for (let i = 0; i < PELLETS; i++) if (this.pellets[i] > 0) this.pellets[i] = Math.max(0, this.pellets[i] - ms);
    for (const p of this.players) {
      if (p.gone) continue;
      if (!p.alive) {
        p.respawn -= ms;
        if (p.respawn <= 0) { p.alive = true; p.mass = START_MASS; this.place(p); }
        continue;
      }
      if (p.bot) this.botThink(p, ms);
      this.move(p, dt);
      if (p.mass > 50) p.mass = Math.max(50, p.mass * (1 - DECAY * dt));
    }
    this.eat();
    this.checkEnd();
  }

  move(p, dt) {
    const dist = Math.hypot(p.dx, p.dy);
    if (dist < 0.05) return;
    const r = radius(p.mass);
    const slow = Math.min(1, dist / Math.max(1, r)); // perto do mouse vai devagar e para em cima dele
    const step = speedOf(p.mass) * slow * dt * (p.bot ? 0.8 : 1); // robôs um pouco mais lentos que gente
    p.x = Math.max(r * 0.5, Math.min(WORLD - r * 0.5, p.x + (p.dx / dist) * step));
    p.y = Math.max(r * 0.5, Math.min(WORLD - r * 0.5, p.y + (p.dy / dist) * step));
    // O alvo é relativo à bolinha: com o mouse parado, ela segue andando naquela direção
  }

  eat() {
    const alive = this.players.filter((p) => p.alive);
    // Comidinhas
    for (const p of alive) {
      const r = radius(p.mass);
      for (let i = 0; i < PELLETS; i++) {
        if (this.pellets[i]) continue;
        const [x, y] = pelletPos(i);
        if (Math.abs(x - p.x) > r || Math.abs(y - p.y) > r) continue;
        if ((x - p.x) ** 2 + (y - p.y) ** 2 < r * r) {
          this.pellets[i] = PELLET_RESPAWN_MS;
          p.mass = Math.min(MAX_MASS, p.mass + 1);
        }
      }
    }
    // Bolinha grande engole a pequena quando cobre boa parte dela
    for (const a of alive) {
      for (const b of alive) {
        if (a === b || !a.alive || !b.alive || a.mass < b.mass * EAT_RATIO) continue;
        if (Math.hypot(a.x - b.x, a.y - b.y) < radius(a.mass) - radius(b.mass) * 0.4) {
          a.mass = Math.min(MAX_MASS, a.mass + b.mass);
          a.eaten += 1;
          b.alive = false;
          b.respawn = RESPAWN_MS;
        }
      }
    }
    for (const p of alive) p.best = Math.max(p.best, p.mass);
  }

  // Robô: foge de quem pode engolir, persegue quem dá para engolir, senão vai na comida mais perto
  botThink(p, ms) {
    p.think -= ms;
    if (p.think > 0) return;
    p.think = 250;
    const others = this.players.filter((o) => o.alive && o !== p);
    const near = (o) => Math.hypot(o.x - p.x, o.y - p.y);
    const threat = others.filter((o) => o.mass >= p.mass * EAT_RATIO && near(o) < 12 + radius(o.mass)).sort((a, b) => near(a) - near(b))[0];
    if (threat) { p.dx = p.x - threat.x; p.dy = p.y - threat.y; return; }
    const prey = others.filter((o) => p.mass >= o.mass * EAT_RATIO && near(o) < 14).sort((a, b) => near(a) - near(b))[0];
    if (prey && this.random() < 0.8) { p.dx = prey.x - p.x; p.dy = prey.y - p.y; return; }
    let best = null;
    for (let i = 0; i < PELLETS; i++) {
      if (this.pellets[i]) continue;
      const [x, y] = pelletPos(i);
      const d = (x - p.x) ** 2 + (y - p.y) ** 2;
      if (!best || d < best.d) best = { x, y, d };
    }
    if (best) { p.dx = (best.x - p.x) * 3; p.dy = (best.y - p.y) * 3; }
  }

  checkEnd() {
    const people = this.players.filter((p) => !p.bot && !p.gone);
    if (!people.length || this.elapsed >= ROUND_MS) {
      this.over = true;
      const ranked = this.players.filter((p) => p.alive && !p.gone).sort((a, b) => b.mass - a.mass);
      this.winner = ranked[0]?.id ?? null;
    }
  }

  state() {
    return {
      world: WORLD,
      players: this.players.filter((p) => !p.gone).map((p) => ({
        id: p.id, name: p.name, color: p.color, alive: p.alive, bot: !!p.bot,
        x: round1(p.x), y: round1(p.y), mass: Math.floor(p.mass), best: Math.floor(p.best), eaten: p.eaten,
      })),
      pellets: this.pellets.map((t) => (t ? '0' : '1')).join(''),
      countdown: Math.max(0, COUNTDOWN_MS - this.elapsed),
      timeLeft: Math.max(0, ROUND_MS - this.elapsed),
      over: this.over,
      winner: this.winner,
    };
  }
}
