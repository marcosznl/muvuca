// Agar-lite: cada pessoa é uma bolinha que segue o mouse, come comidinhas e engole quem for bem menor.
// Dá para se dividir (Espaço) e soltar massa (W); as partes voltam a se juntar depois de um tempo.
// Vírus (bolinhas verdes com espinhos) estouram quem é grande em vários pedaços; os pequenos se escondem neles.
// Quem é engolido volta pequeno depois de um instante. Ganha quem estiver maior quando o tempo acabar
// (no modo equipes, ganha o time com mais massa somada). Com pouca gente, entram robôs.

export const WORLD = 80;           // a arena é um quadrado WORLD×WORLD
export const MAX_PLAYERS = 8;
export const COUNTDOWN_MS = 1500;
export const ROUND_MS = 150_000;
export const START_MASS = 10;
export const PELLETS = 300;
export const EAT_RATIO = 1.2;      // precisa ser 20% maior para engolir
export const MAX_CELLS = 8;        // em quantos pedaços uma pessoa pode estar
export const SPLIT_MIN = 30;       // massa mínima de um pedaço para dividir
export const EJECT_MIN = 20;       // massa mínima para soltar massa
export const EJECT_COST = 3;       // quanto perde ao soltar (a bolinha solta vale um pouco menos)
export const EJECT_MASS = 2.5;
export const MERGE_MS = 12_000;    // depois de dividir, quanto tempo até poder se juntar
export const VIRUS_MASS = 100;
export const VIRUSES = 8;
export const VIRUS_FEED = 5;       // bolinhas soltas num vírus até ele disparar um vírus novo
const VIRUS_RESPAWN_MS = 8000;
const PELLET_RESPAWN_MS = 4000;
const RESPAWN_MS = 2500;
const MAX_MASS = 2000;
const DECAY = 0.004;               // gordas perdem 0,4% por segundo (ninguém dispara sozinho para sempre)
const MIN_CELLS = 4;               // com menos gente que isso, completa com robôs
const MAX_REACH = 30;              // até onde vale o mouse (em unidades da arena)
const SPLIT_SPEED = 38;            // arrancada do pedaço que sai ao dividir (unidades/s, freia rápido)
const EJECT_SPEED = 45;
const FRICTION = 6;                // quanto a arrancada freia por segundo

export const TEAMS = [{ label: 'Vermelho', color: 1 }, { label: 'Azul', color: 0 }];

export const OPTIONS = {
  equipes: { label: 'Equipes', hint: 'Dois times (Vermelho × Azul): ninguém come o colega e ganha o time com mais massa', default: false },
};

export const radius = (mass) => Math.sqrt(mass) * 0.35;
export const speedOf = (mass) => 10 * radius(mass) ** -0.45;

// Onde fica cada comidinha: fixo pelo número dela (o site calcula igual, sem precisar mandar)
export function pelletPos(i) {
  const f = (n) => { const v = Math.sin(n * 12.9898 + 78.233) * 43758.5453; return v - Math.floor(v); };
  return [1 + f(i * 2 + 1) * (WORLD - 2), 1 + f(i * 2 + 2) * (WORLD - 2)];
}

const round1 = (v) => Math.round(v * 10) / 10;
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
export const massOf = (p) => p.cells.reduce((sum, c) => sum + c.mass, 0);

// Desliza com a arrancada e freia
function glide(o, dt) {
  if (!o.vx && !o.vy) return;
  o.x += o.vx * dt;
  o.y += o.vy * dt;
  const f = Math.max(0, 1 - FRICTION * dt);
  o.vx *= f;
  o.vy *= f;
  if (Math.hypot(o.vx, o.vy) < 0.3) { o.vx = 0; o.vy = 0; }
}

export class Agar {
  constructor(players, { bots = true, random = Math.random, options = {} } = {}) {
    this.random = random;
    this.teams = !!options.equipes;
    const list = players.slice(0, MAX_PLAYERS).map((p) => ({ id: p.id, name: p.name }));
    // Com equipes, completa com robôs até os times ficarem do mesmo tamanho
    const minCells = this.teams ? Math.max(MIN_CELLS, list.length + (list.length % 2)) : MIN_CELLS;
    const botCount = bots ? Math.max(0, minCells - list.length) : 0;
    for (let i = 1; i <= botCount; i++) list.push({ id: `bot${i}`, name: `Robô ${i}`, bot: true });
    this.players = list.map((p, i) => ({
      ...p, color: this.teams ? TEAMS[i % 2].color : i, team: this.teams ? i % 2 : null,
      cells: [], alive: true, gone: false, dx: 0, dy: 0, respawn: 0, best: START_MASS, eaten: 0, think: 0,
    }));
    this.nextCell = 1;
    this.viruses = [];
    this.virusQueue = []; // ms até cada vírus comido voltar
    this.blobs = [];      // massa solta (W): { x, y, vx, vy, mass, owner, age }
    for (const p of this.players) this.spawn(p);
    for (let i = 0; i < VIRUSES; i++) this.addVirus();
    this.pellets = Array.from({ length: PELLETS }, () => 0); // 0 = tem comida; senão, ms até voltar
    this.elapsed = 0;
    this.over = false;
    this.winner = null;
    this.winners = null;
    this.winnerTeam = null;
  }

  player(id) { return this.players.find((p) => p.id === id); }
  // Centro da pessoa (média das partes pelo tamanho): é dele que o mouse é medido
  center(p) {
    const m = massOf(p) || 1;
    return [p.cells.reduce((s, c) => s + c.x * c.mass, 0) / m, p.cells.reduce((s, c) => s + c.y * c.mass, 0) / m];
  }
  friends(a, b) { return a === b || (this.teams && a.team === b.team); }

  cell(x, y, mass, extra = {}) {
    return { id: this.nextCell++, x, y, mass, vx: 0, vy: 0, merge: 0, ...extra };
  }

  // Lugar longe de quem pode engolir (e dos vírus)
  freeSpot(skip = null) {
    let best = null;
    for (let i = 0; i < 12; i++) {
      const x = 5 + this.random() * (WORLD - 10);
      const y = 5 + this.random() * (WORLD - 10);
      let danger = 99;
      for (const o of this.players) {
        if (o === skip || o.gone) continue;
        for (const c of o.cells) danger = Math.min(danger, Math.hypot(c.x - x, c.y - y) - radius(c.mass));
      }
      for (const v of this.viruses) danger = Math.min(danger, Math.hypot(v.x - x, v.y - y) - radius(VIRUS_MASS) - 1);
      if (!best || danger > best.danger) best = { x, y, danger };
    }
    return best;
  }

  spawn(p) {
    const { x, y } = this.freeSpot(p);
    p.cells = [this.cell(x, y, START_MASS)];
    p.alive = true;
  }

  addVirus(x, y, vx = 0, vy = 0) {
    if (x === undefined) ({ x, y } = this.freeSpot());
    this.viruses.push({ x, y, vx, vy, fed: 0 });
  }

  // x/y: para onde o mouse aponta, em relação ao centro da pessoa. act: 'split' (Espaço) ou 'eject' (W)
  input(id, { x, y, act } = {}) {
    const p = this.player(id);
    if (!p || p.gone || this.over) return;
    if (x !== undefined) {
      const len = Math.hypot(x, y);
      const k = len > MAX_REACH ? MAX_REACH / len : 1;
      p.dx = x * k;
      p.dy = y * k;
    }
    if (!p.alive || this.elapsed < COUNTDOWN_MS) return;
    if (act === 'split') this.split(p);
    if (act === 'eject') this.eject(p);
  }

  // Direção do mouse a partir de uma parte (todas as partes vão para o mesmo ponto)
  aim(p, c) {
    const [cx, cy] = this.center(p);
    let ax = cx + p.dx - c.x;
    let ay = cy + p.dy - c.y;
    if (Math.hypot(ax, ay) < 0.01) { ax = p.dx; ay = p.dy; }
    const len = Math.hypot(ax, ay);
    return len < 0.01 ? [1, 0] : [ax / len, ay / len];
  }

  // Cada parte grande o bastante se divide ao meio; a metade nova é lançada para onde o mouse aponta
  split(p) {
    const born = [];
    for (const c of [...p.cells].sort((a, b) => b.mass - a.mass)) {
      if (p.cells.length + born.length >= MAX_CELLS) break;
      if (c.mass < SPLIT_MIN) continue;
      const [ux, uy] = this.aim(p, c);
      c.mass /= 2;
      c.merge = MERGE_MS;
      const r = radius(c.mass);
      born.push(this.cell(clamp(c.x + ux * r, 0, WORLD), clamp(c.y + uy * r, 0, WORLD), c.mass,
        { vx: ux * SPLIT_SPEED, vy: uy * SPLIT_SPEED, merge: MERGE_MS }));
    }
    p.cells.push(...born);
    return born.length;
  }

  // Solta um pouquinho de massa na direção do mouse (dá comida ao colega ou alimenta um vírus)
  eject(p) {
    let n = 0;
    for (const c of p.cells) {
      if (c.mass < EJECT_MIN) continue;
      const [ux, uy] = this.aim(p, c);
      c.mass -= EJECT_COST;
      const r = radius(c.mass) + 0.6;
      this.blobs.push({ x: clamp(c.x + ux * r, 0.5, WORLD - 0.5), y: clamp(c.y + uy * r, 0.5, WORLD - 0.5),
        vx: ux * EJECT_SPEED, vy: uy * EJECT_SPEED, mass: EJECT_MASS, owner: p.id, age: 0 });
      n++;
    }
    if (this.blobs.length > 200) this.blobs.splice(0, this.blobs.length - 200);
    return n;
  }

  eliminate(id) {
    const p = this.player(id);
    if (p) { p.gone = true; p.alive = false; p.cells = []; }
  }

  tick(ms) {
    if (this.over) return;
    this.elapsed += ms;
    if (this.elapsed < COUNTDOWN_MS) return;
    const dt = ms / 1000;
    for (let i = 0; i < PELLETS; i++) if (this.pellets[i] > 0) this.pellets[i] = Math.max(0, this.pellets[i] - ms);
    this.virusQueue = this.virusQueue.map((t) => t - ms);
    while (this.virusQueue.length && this.virusQueue[0] <= 0) { this.virusQueue.shift(); this.addVirus(); }
    for (const p of this.players) {
      if (p.gone) continue;
      if (!p.alive) {
        p.respawn -= ms;
        if (p.respawn <= 0) this.spawn(p);
        continue;
      }
      if (p.bot) this.botThink(p, ms);
      this.move(p, ms);
      for (const c of p.cells) if (c.mass > 50) c.mass = Math.max(50, c.mass * (1 - DECAY * dt));
    }
    for (const o of [...this.blobs, ...this.viruses]) {
      glide(o, dt);
      o.x = clamp(o.x, 0.5, WORLD - 0.5);
      o.y = clamp(o.y, 0.5, WORLD - 0.5);
    }
    for (const b of this.blobs) b.age += ms;
    this.eat();
    this.checkEnd();
  }

  move(p, ms) {
    const dt = ms / 1000;
    const [cx, cy] = this.center(p);
    const tx = cx + p.dx;
    const ty = cy + p.dy;
    const steering = Math.hypot(p.dx, p.dy) >= 0.05;
    for (const c of p.cells) {
      const r = radius(c.mass);
      c.merge = Math.max(0, c.merge - ms);
      const dist = Math.hypot(tx - c.x, ty - c.y);
      if (steering && dist >= 0.05) {
        const slow = Math.min(1, dist / Math.max(1, r)); // perto do mouse vai devagar e para em cima dele
        const step = Math.min(dist, speedOf(c.mass) * slow * dt * (p.bot ? 0.8 : 1)); // robôs um pouco mais lentos
        c.x += ((tx - c.x) / dist) * step;
        c.y += ((ty - c.y) / dist) * step;
      }
      // Partes separadas se atraem de leve para o centro (para poderem se juntar)
      const dc = Math.hypot(cx - c.x, cy - c.y);
      if (p.cells.length > 1 && dc > 0.05) {
        const pull = Math.min(dc, speedOf(c.mass) * 0.35 * dt);
        c.x += ((cx - c.x) / dc) * pull;
        c.y += ((cy - c.y) / dc) * pull;
      }
      glide(c, dt); // arrancada de quando se dividiu
      c.x = clamp(c.x, r * 0.5, WORLD - r * 0.5);
      c.y = clamp(c.y, r * 0.5, WORLD - r * 0.5);
    }
    this.settle(p);
  }

  // Partes da mesma pessoa: antes da hora se empurram; depois, se encostarem, viram uma só
  settle(p) {
    for (let i = 0; i < p.cells.length; i++) {
      for (let j = i + 1; j < p.cells.length; j++) {
        const a = p.cells[i];
        const b = p.cells[j];
        const ra = radius(a.mass);
        const rb = radius(b.mass);
        const d = Math.hypot(a.x - b.x, a.y - b.y);
        if (!a.merge && !b.merge) {
          if (d < Math.max(ra, rb)) {
            const [big, small] = a.mass >= b.mass ? [a, b] : [b, a];
            big.mass = Math.min(MAX_MASS, big.mass + small.mass);
            p.cells.splice(p.cells.indexOf(small), 1);
            return this.settle(p); // a lista mudou: confere de novo
          }
          continue;
        }
        if (a.vx || a.vy || b.vx || b.vy) continue; // ainda voando: deixa passar
        const overlap = ra + rb - d;
        if (overlap <= 0) continue;
        const ux = d > 0.001 ? (a.x - b.x) / d : 1;
        const uy = d > 0.001 ? (a.y - b.y) / d : 0;
        const wa = b.mass / (a.mass + b.mass); // o menor é que sai do caminho
        a.x += ux * overlap * wa;
        a.y += uy * overlap * wa;
        b.x -= ux * overlap * (1 - wa);
        b.y -= uy * overlap * (1 - wa);
      }
    }
  }

  eat() {
    const cells = [];
    for (const p of this.players) if (p.alive) for (const c of p.cells) cells.push([p, c]);
    const exists = (p, c) => p.cells.includes(c);
    // Comidinhas e massa solta
    for (const [p, c] of cells) {
      const r = radius(c.mass);
      for (let i = 0; i < PELLETS; i++) {
        if (this.pellets[i]) continue;
        const [x, y] = pelletPos(i);
        if (Math.abs(x - c.x) > r || Math.abs(y - c.y) > r) continue;
        if ((x - c.x) ** 2 + (y - c.y) ** 2 < r * r) {
          this.pellets[i] = PELLET_RESPAWN_MS;
          c.mass = Math.min(MAX_MASS, c.mass + 1);
        }
      }
      for (let i = this.blobs.length - 1; i >= 0; i--) {
        const b = this.blobs[i];
        if (b.owner === p.id && b.age < 600) continue; // não come de volta o que acabou de soltar
        if ((b.x - c.x) ** 2 + (b.y - c.y) ** 2 < r * r) {
          c.mass = Math.min(MAX_MASS, c.mass + b.mass);
          this.blobs.splice(i, 1);
        }
      }
    }
    // Massa solta que bate num vírus: ele engole; com VIRUS_FEED, dispara um vírus novo naquela direção
    const vr = radius(VIRUS_MASS);
    for (const v of [...this.viruses]) {
      for (let i = this.blobs.length - 1; i >= 0; i--) {
        const b = this.blobs[i];
        if ((b.x - v.x) ** 2 + (b.y - v.y) ** 2 >= vr * vr) continue;
        this.blobs.splice(i, 1);
        v.fed += 1;
        if (v.fed < VIRUS_FEED) continue;
        v.fed = 0;
        if (this.viruses.length >= VIRUSES * 2) continue;
        const len = Math.hypot(b.vx, b.vy);
        const [ux, uy] = len > 0.01 ? [b.vx / len, b.vy / len] : [b.x < v.x ? 1 : -1, 0];
        this.addVirus(clamp(v.x + ux * vr * 2, 2, WORLD - 2), clamp(v.y + uy * vr * 2, 2, WORLD - 2), ux * 30, uy * 30);
      }
    }
    // Vírus: parte grande que passa por cima estoura em vários pedaços; as pequenas se escondem embaixo
    for (let vi = this.viruses.length - 1; vi >= 0; vi--) {
      const v = this.viruses[vi];
      const hit = cells.find(([p, c]) => exists(p, c) && c.mass >= VIRUS_MASS * EAT_RATIO
        && Math.hypot(c.x - v.x, c.y - v.y) < radius(c.mass) - vr * 0.4);
      if (!hit) continue;
      this.viruses.splice(vi, 1);
      this.virusQueue.push(VIRUS_RESPAWN_MS);
      hit[1].mass = Math.min(MAX_MASS, hit[1].mass + 10); // o vírus em si engorda pouco
      this.pop(hit[0], hit[1]);
    }
    // Parte grande engole a pequena (de outra pessoa; em equipes, nunca do colega) quando cobre boa parte dela
    for (const [pa, a] of cells) {
      for (const [pb, b] of cells) {
        if (this.friends(pa, pb) || !exists(pa, a) || !exists(pb, b) || a.mass < b.mass * EAT_RATIO) continue;
        if (Math.hypot(a.x - b.x, a.y - b.y) >= radius(a.mass) - radius(b.mass) * 0.4) continue;
        a.mass = Math.min(MAX_MASS, a.mass + b.mass);
        pb.cells.splice(pb.cells.indexOf(b), 1);
        if (!pb.cells.length) {
          pa.eaten += 1;
          pb.alive = false;
          pb.respawn = RESPAWN_MS;
        }
      }
    }
    for (const p of this.players) if (p.alive) p.best = Math.max(p.best, massOf(p));
  }

  // Estouro no vírus: a parte vira vários pedaços espalhados em volta (até MAX_CELLS)
  pop(p, c) {
    const room = MAX_CELLS - p.cells.length;
    if (room <= 0) return;
    const pieces = Math.min(room, Math.max(1, Math.floor(c.mass / 20)));
    const each = c.mass / (pieces + 1);
    c.mass = each;
    c.merge = MERGE_MS;
    for (let i = 0; i < pieces; i++) {
      const ang = (i / pieces) * Math.PI * 2 + this.random() * 0.5;
      p.cells.push(this.cell(c.x, c.y, each, { vx: Math.cos(ang) * SPLIT_SPEED * 0.7, vy: Math.sin(ang) * SPLIT_SPEED * 0.7, merge: MERGE_MS }));
    }
  }

  // Robô: foge de quem pode engolir, persegue quem dá para engolir (às vezes dividindo para dar o bote), senão come
  botThink(p, ms) {
    p.think -= ms;
    if (p.think > 0) return;
    p.think = 250;
    const [px, py] = this.center(p);
    const big = p.cells.reduce((a, b) => (b.mass > a.mass ? b : a));
    const small = p.cells.reduce((a, b) => (b.mass < a.mass ? b : a));
    const foes = [];
    for (const o of this.players) if (o.alive && !this.friends(p, o)) foes.push(...o.cells);
    const near = (o) => Math.hypot(o.x - px, o.y - py);
    const threat = foes.filter((o) => o.mass >= small.mass * EAT_RATIO && near(o) < 12 + radius(o.mass)).sort((a, b) => near(a) - near(b))[0];
    if (threat) { p.dx = px - threat.x; p.dy = py - threat.y; return; }
    // Grande o bastante para estourar: desvia dos vírus
    const virus = big.mass >= VIRUS_MASS * EAT_RATIO && this.viruses.find((v) => Math.hypot(v.x - big.x, v.y - big.y) < radius(big.mass) + 3);
    if (virus) { p.dx = px - virus.x; p.dy = py - virus.y; return; }
    const prey = foes.filter((o) => big.mass >= o.mass * EAT_RATIO && near(o) < 14).sort((a, b) => near(a) - near(b))[0];
    if (prey && this.random() < 0.8) {
      p.dx = prey.x - px;
      p.dy = prey.y - py;
      if (p.cells.length === 1 && big.mass / 2 >= prey.mass * EAT_RATIO && near(prey) < radius(big.mass) + 8 && this.random() < 0.3) this.split(p);
      return;
    }
    let best = null;
    for (let i = 0; i < PELLETS; i++) {
      if (this.pellets[i]) continue;
      const [x, y] = pelletPos(i);
      const d = (x - px) ** 2 + (y - py) ** 2;
      if (!best || d < best.d) best = { x, y, d };
    }
    if (best) { p.dx = (best.x - px) * 3; p.dy = (best.y - py) * 3; }
  }

  teamMass(t) {
    return this.players.filter((p) => p.team === t && !p.gone).reduce((s, p) => s + massOf(p), 0);
  }

  checkEnd() {
    const people = this.players.filter((p) => !p.bot && !p.gone);
    if (people.length && this.elapsed < ROUND_MS) return;
    this.over = true;
    if (this.teams) {
      // Equipes: ganha o time com mais massa somada (todo mundo do time ganha junto)
      const [a, b] = [this.teamMass(0), this.teamMass(1)];
      this.winnerTeam = a === b ? null : a > b ? 0 : 1;
      this.winners = this.winnerTeam === null ? [] : this.players.filter((p) => p.team === this.winnerTeam && !p.gone).map((p) => p.id);
      return;
    }
    const ranked = this.players.filter((p) => p.alive && !p.gone).sort((a, b) => massOf(b) - massOf(a));
    this.winner = ranked[0]?.id ?? null;
  }

  state() {
    return {
      world: WORLD,
      teams: this.teams ? TEAMS.map((t, i) => ({ ...t, mass: Math.floor(this.teamMass(i)) })) : null,
      players: this.players.filter((p) => !p.gone).map((p) => ({
        id: p.id, name: p.name, color: p.color, team: p.team, alive: p.alive, bot: !!p.bot,
        mass: Math.floor(massOf(p)), best: Math.floor(p.best), eaten: p.eaten,
        cells: p.cells.map((c) => [c.id, round1(c.x), round1(c.y), Math.floor(c.mass)]),
      })),
      pellets: this.pellets.map((t) => (t ? '0' : '1')).join(''),
      blobs: this.blobs.map((b) => [round1(b.x), round1(b.y)]),
      viruses: this.viruses.map((v) => [round1(v.x), round1(v.y)]),
      countdown: Math.max(0, COUNTDOWN_MS - this.elapsed),
      timeLeft: Math.max(0, ROUND_MS - this.elapsed),
      over: this.over,
      winner: this.winner,
      winnerTeam: this.winnerTeam,
    };
  }
}
