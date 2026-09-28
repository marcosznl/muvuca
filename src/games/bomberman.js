// Bomberman: as regras da partida, sem rede nem tela (dá para testar sozinho).
// O servidor chama tick() ~20x por segundo e manda state() para quem joga e para quem assiste.
//
// Mapa em ladrilhos: '#' parede fixa, 'x' bloco que quebra, '.' livre.
// Cada pessoa anda de ladrilho em ladrilho (o site suaviza o movimento entre eles).

export const W = 15;
export const H = 13;
export const FUSE_MS = 2500;       // tempo da bomba até explodir
export const FLAME_MS = 500;       // quanto tempo o fogo fica na tela (e mata quem entra nele)
export const ROUND_MS = 180_000;   // 3 minutos: depois disso, empate
export const MAX_PLAYERS = 4;
const BASE_SPEED = 4;              // ladrilhos por segundo
const MAX_SPEED = 8;
const MAX_BOMBS = 8;
const MAX_RANGE = 8;
const BLOCK_CHANCE = 0.7;          // quanto do mapa livre começa com blocos
const DROP_CHANCE = 0.35;          // chance de um bloco quebrado deixar um power-up
export const ITEMS = ['bomb', 'fire', 'speed']; // +1 bomba, +1 alcance, mais velocidade

// Cantos de saída (e as cores de cada jogador no site)
const SPAWNS = [[1, 1], [W - 2, H - 2], [W - 2, 1], [1, H - 2]];
const DIRS = { up: [0, -1], down: [0, 1], left: [-1, 0], right: [1, 0] };

// Sorteio com semente: a mesma semente gera o mesmo mapa (bom para os testes)
function rng(seed) {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13; s ^= s >>> 17; s ^= s << 5;
    return (s >>> 0) / 4294967296;
  };
}

export class Bomberman {
  constructor(players, { seed = Date.now(), blocks = true } = {}) {
    this.random = rng(seed);
    this.grid = [];
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const solid = x === 0 || y === 0 || x === W - 1 || y === H - 1 || (x % 2 === 0 && y % 2 === 0);
        this.grid.push(solid ? '#' : '.');
      }
    }
    // Blocos em volta, menos perto dos cantos de saída (todo mundo precisa de espaço para a 1ª bomba)
    const safe = (x, y) => SPAWNS.some(([sx, sy]) => Math.abs(sx - x) + Math.abs(sy - y) <= 2);
    if (blocks) {
      for (let y = 0; y < H; y++) {
        for (let x = 0; x < W; x++) {
          if (this.at(x, y) === '.' && !safe(x, y) && this.random() < BLOCK_CHANCE) this.set(x, y, 'x');
        }
      }
    }
    this.players = players.slice(0, MAX_PLAYERS).map((p, i) => ({
      id: p.id, name: p.name, color: i,
      x: SPAWNS[i][0], y: SPAWNS[i][1], // ladrilho de onde saiu
      tx: SPAWNS[i][0], ty: SPAWNS[i][1], // ladrilho para onde vai
      progress: 1, // 1 = chegou (parado)
      want: null,  // direção que a pessoa está segurando
      speed: BASE_SPEED, bombs: 1, range: 2,
      alive: true,
    }));
    this.bombs = [];   // { x, y, owner, fuse, range }
    this.flames = [];  // { x, y, ttl }
    this.items = new Map(); // "x,y" -> tipo
    this.elapsed = 0;
    this.over = false;
    this.winner = null; // id de quem venceu (null = empate)
    this.solo = this.players.length === 1; // treino: só termina quando a pessoa morre (ou o tempo acaba)
  }

  at(x, y) { return x < 0 || y < 0 || x >= W || y >= H ? '#' : this.grid[y * W + x]; }
  set(x, y, c) { this.grid[y * W + x] = c; }
  bombAt(x, y) { return this.bombs.find((b) => b.x === x && b.y === y); }
  flameAt(x, y) { return this.flames.some((f) => f.x === x && f.y === y); }
  player(id) { return this.players.find((p) => p.id === id); }

  // Ladrilho em que a pessoa "está" (o de saída até a metade do caminho, depois o de chegada)
  tileOf(p) { return p.progress < 0.5 ? [p.x, p.y] : [p.tx, p.ty]; }

  // Dá para entrar? Não em parede, bloco ou bomba (a não ser a bomba em que já se está em cima)
  canEnter(x, y, p) {
    if (this.at(x, y) !== '.') return false;
    const bomb = this.bombAt(x, y);
    return !bomb || (bomb.x === p.x && bomb.y === p.y && p.progress >= 1);
  }

  // O que chega do site: direção segurada (ou null ao soltar) e/ou pedido de bomba
  input(id, { dir, bomb } = {}) {
    const p = this.player(id);
    if (!p || !p.alive || this.over) return;
    if (dir !== undefined) p.want = DIRS[dir] ? dir : null;
    if (bomb) this.placeBomb(p);
  }

  eliminate(id) {
    const p = this.player(id);
    if (p) p.alive = false;
  }

  placeBomb(p) {
    const [x, y] = this.tileOf(p);
    if (this.bombAt(x, y)) return;
    if (this.bombs.filter((b) => b.owner === p.id).length >= p.bombs) return;
    this.bombs.push({ x, y, owner: p.id, fuse: FUSE_MS, range: p.range });
  }

  tick(ms) {
    if (this.over) return;
    this.elapsed += ms;
    for (const p of this.players) if (p.alive) this.move(p, ms);
    // Bombas: o pavio corre; explosões podem detonar outras bombas na hora (reação em cadeia)
    for (const b of this.bombs) b.fuse -= ms;
    let lit;
    while ((lit = this.bombs.find((b) => b.fuse <= 0))) this.explode(lit);
    for (const f of this.flames) f.ttl -= ms;
    this.flames = this.flames.filter((f) => f.ttl > 0);
    // Quem está no fogo morre
    for (const p of this.players) {
      if (p.alive && this.flameAt(...this.tileOf(p))) p.alive = false;
    }
    this.checkEnd();
  }

  move(p, ms) {
    let budget = (p.speed * ms) / 1000; // quantos ladrilhos dá para andar neste tick
    while (budget > 0) {
      if (p.progress < 1) {
        const step = Math.min(budget, 1 - p.progress);
        p.progress += step;
        budget -= step;
        if (p.progress > 1 - 1e-9) p.progress = 1; // sem sobra de arredondamento
        if (p.progress < 1) break;
        p.x = p.tx; p.y = p.ty; // chegou
        this.pickItem(p);
      }
      if (!p.want) break;
      const [dx, dy] = DIRS[p.want];
      if (!this.canEnter(p.x + dx, p.y + dy, p)) break;
      p.tx = p.x + dx;
      p.ty = p.y + dy;
      p.progress = 0;
    }
  }

  pickItem(p) {
    const key = `${p.x},${p.y}`;
    const item = this.items.get(key);
    if (!item) return;
    this.items.delete(key);
    if (item === 'bomb') p.bombs = Math.min(MAX_BOMBS, p.bombs + 1);
    if (item === 'fire') p.range = Math.min(MAX_RANGE, p.range + 1);
    if (item === 'speed') p.speed = Math.min(MAX_SPEED, p.speed + 1);
  }

  // Explosão em cruz: para na parede; quebra o primeiro bloco (que pode soltar um power-up);
  // queima power-ups soltos no caminho; acende outras bombas
  explode(bomb) {
    this.bombs = this.bombs.filter((b) => b !== bomb);
    this.flame(bomb.x, bomb.y);
    for (const [dx, dy] of Object.values(DIRS)) {
      for (let i = 1; i <= bomb.range; i++) {
        const x = bomb.x + dx * i;
        const y = bomb.y + dy * i;
        const c = this.at(x, y);
        if (c === '#') break;
        if (c === 'x') {
          this.set(x, y, '.');
          this.flame(x, y);
          if (this.random() < DROP_CHANCE) this.items.set(`${x},${y}`, ITEMS[Math.floor(this.random() * ITEMS.length)]);
          break;
        }
        this.items.delete(`${x},${y}`);
        this.flame(x, y);
        const other = this.bombAt(x, y);
        if (other) other.fuse = 0;
      }
    }
  }

  flame(x, y) {
    const existing = this.flames.find((f) => f.x === x && f.y === y);
    if (existing) existing.ttl = FLAME_MS;
    else this.flames.push({ x, y, ttl: FLAME_MS });
  }

  checkEnd() {
    const alive = this.players.filter((p) => p.alive);
    if (this.solo ? alive.length === 0 : alive.length <= 1) {
      this.over = true;
      this.winner = this.solo ? null : alive[0]?.id ?? null;
    } else if (this.elapsed >= ROUND_MS) {
      this.over = true;
      this.winner = null; // tempo esgotado: empate
    }
  }

  // O que vai para o site (compacto: é enviado ~20x por segundo)
  state() {
    return {
      w: W,
      h: H,
      grid: this.grid.join(''),
      players: this.players.map((p) => ({
        id: p.id, name: p.name, color: p.color, alive: p.alive,
        x: p.x, y: p.y, tx: p.tx, ty: p.ty, p: Math.round(p.progress * 100) / 100, speed: p.speed,
        bombs: p.bombs, range: p.range,
      })),
      bombs: this.bombs.map((b) => ({ x: b.x, y: b.y, fuse: Math.max(0, Math.round(b.fuse)) })),
      flames: this.flames.map((f) => [f.x, f.y]),
      items: [...this.items].map(([k, v]) => { const [x, y] = k.split(',').map(Number); return [x, y, v]; }),
      timeLeft: Math.max(0, ROUND_MS - this.elapsed),
      over: this.over,
      winner: this.winner,
    };
  }
}
