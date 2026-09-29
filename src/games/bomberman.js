// Bomberman: as regras da partida, sem rede nem tela (dá para testar sozinho).
// O servidor chama tick() ~20x por segundo e manda state() para quem joga e para quem assiste.
//
// Mapa em ladrilhos: '#' parede fixa, 'x' bloco que quebra, 'o' buraco (ninguém passa; o fogo passa por cima), '.' livre.
// Cada pessoa anda de ladrilho em ladrilho (o site suaviza o movimento entre eles).
// Opções da sala: mapa, robôs, série (melhor de 3/5, contada no lobby) e morte súbita (a partir de 2 min,
// as paredes fecham o mapa em espiral).

export const W = 15;
export const H = 13;
export const FUSE_MS = 2500;       // tempo da bomba até explodir
export const REMOTE_FUSE_MS = 10_000; // com detonador: explode quando a pessoa manda (ou sozinha depois de 10 s)
export const FLAME_MS = 500;       // quanto tempo o fogo fica na tela (e mata quem entra nele)
export const ROUND_MS = 180_000;   // 3 minutos: depois disso, empate
export const SUDDEN_MS = 120_000;  // morte súbita: começa aos 2 minutos
export const SUDDEN_STEP_MS = 350; // um ladrilho fecha a cada 0,35 s
export const CURSE_MS = 8000;      // maldição: controles invertidos por 8 s
export const SHIELD_GRACE_MS = 1000; // depois do escudo quebrar, 1 s sem tomar dano
export const KICK_SPEED = 10;      // ladrilhos por segundo da bomba chutada
export const MAX_PLAYERS = 4;
const BASE_SPEED = 4;              // ladrilhos por segundo
const MAX_SPEED = 8;
const MAX_BOMBS = 8;
const MAX_RANGE = 8;
const DROP_CHANCE = 0.35;          // chance de um bloco quebrado deixar um item
// Itens e o peso de cada um no sorteio: +1 bomba, +1 alcance, velocidade, chutar bomba, detonador, escudo, maldição
export const ITEM_WEIGHTS = { bomb: 30, fire: 30, speed: 18, kick: 8, remote: 5, shield: 6, curse: 3 };
export const ITEMS = Object.keys(ITEM_WEIGHTS);

export const MAPS = {
  classico: { label: 'Clássico', blocks: 0.7 },
  aberto: { label: 'Arena aberta', blocks: 0.35, pillars: 'poucas' },
  labirinto: { label: 'Labirinto', blocks: 0.8, extraWalls: 14 },
  buracos: { label: 'Buracos', blocks: 0.6, holes: 16 },
};

export const OPTIONS = {
  mapa: { label: 'Mapa', hint: 'Formato da arena', default: 'classico', choices: Object.entries(MAPS).map(([k, m]) => [k, m.label]) },
  robos: { label: 'Robôs', hint: 'Robôs entram nas vagas livres (dá para treinar sozinho)', default: 0, choices: [[0, 'Nenhum'], [1, '1'], [2, '2'], [3, '3']] },
  serie: { label: 'Série', hint: 'Várias partidas seguidas; ganha quem chegar primeiro às vitórias', default: 1, choices: [[1, 'Partida única'], [3, 'Melhor de 3'], [5, 'Melhor de 5']] },
  morteSubita: { label: 'Morte súbita', hint: 'Aos 2 minutos, as paredes vão fechando o mapa em espiral', default: true },
};

// Cantos de saída (e as cores de cada jogador no site)
const SPAWNS = [[1, 1], [W - 2, H - 2], [W - 2, 1], [1, H - 2]];
const DIRS = { up: [0, -1], down: [0, 1], left: [-1, 0], right: [1, 0] };
const OPPOSITE = { up: 'down', down: 'up', left: 'right', right: 'left' };

// Sorteio com semente: a mesma semente gera o mesmo mapa (bom para os testes)
function rng(seed) {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13; s ^= s >>> 17; s ^= s << 5;
    return (s >>> 0) / 4294967296;
  };
}

// Ordem em espiral dos ladrilhos de dentro (de fora para o centro), para a morte súbita
function spiralOrder() {
  const out = [];
  let [x0, y0, x1, y1] = [1, 1, W - 2, H - 2];
  while (x0 <= x1 && y0 <= y1) {
    for (let x = x0; x <= x1; x++) out.push([x, y0]);
    for (let y = y0 + 1; y <= y1; y++) out.push([x1, y]);
    if (y1 > y0) for (let x = x1 - 1; x >= x0; x--) out.push([x, y1]);
    if (x1 > x0) for (let y = y1 - 1; y > y0; y--) out.push([x0, y]);
    x0++; y0++; x1--; y1--;
  }
  return out;
}

export class Bomberman {
  constructor(players, { seed = Date.now(), blocks = true, options = {} } = {}) {
    this.random = rng(seed);
    this.options = options;
    const map = MAPS[options.mapa] ?? MAPS.classico;
    this.map = MAPS[options.mapa] ? options.mapa : 'classico';
    this.grid = [];
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const border = x === 0 || y === 0 || x === W - 1 || y === H - 1;
        // Arena aberta: pilares só de 4 em 4 (mais espaço para correr)
        const pillar = map.pillars === 'poucas' ? x % 4 === 0 && y % 4 === 0 : x % 2 === 0 && y % 2 === 0;
        this.grid.push(border || pillar ? '#' : '.');
      }
    }
    const safe = (x, y) => SPAWNS.some(([sx, sy]) => Math.abs(sx - x) + Math.abs(sy - y) <= 2);
    // Labirinto (paredes a mais) e buracos: só onde não isola nenhuma parte do mapa
    this.addFixed(map.extraWalls ?? 0, '#', safe);
    this.addFixed(map.holes ?? 0, 'o', safe);
    // Blocos em volta, menos perto dos cantos de saída (todo mundo precisa de espaço para a 1ª bomba)
    if (blocks) {
      for (let y = 0; y < H; y++) {
        for (let x = 0; x < W; x++) {
          if (this.at(x, y) === '.' && !safe(x, y) && this.random() < map.blocks) this.set(x, y, 'x');
        }
      }
    }
    // Robôs nas vagas livres
    const people = players.slice(0, MAX_PLAYERS);
    const bots = Math.max(0, Math.min(MAX_PLAYERS - people.length, Number(options.robos) || 0));
    const all = [...people, ...Array.from({ length: bots }, (_, i) => ({ id: `bot${i + 1}`, name: `Robô ${i + 1}`, bot: true }))];
    this.players = all.map((p, i) => ({
      id: p.id, name: p.name, color: i, bot: !!p.bot,
      x: SPAWNS[i][0], y: SPAWNS[i][1], // ladrilho de onde saiu
      tx: SPAWNS[i][0], ty: SPAWNS[i][1], // ladrilho para onde vai
      progress: 1, // 1 = chegou (parado)
      want: null,  // direção que a pessoa está segurando
      speed: BASE_SPEED, bombs: 1, range: 2,
      kick: false, remote: false, shield: false, shieldUntil: 0, cursedUntil: 0,
      think: 0,    // robôs: próximo "pensamento"
      alive: true,
    }));
    this.bombs = [];   // { x, y, owner, fuse, range, remote, slide: { dir, progress } | null }
    this.flames = [];  // { x, y, ttl }
    this.items = new Map(); // "x,y" -> tipo
    this.elapsed = 0;
    this.sudden = options.morteSubita !== false;
    this.spiral = spiralOrder();
    this.closed = 0;      // quantos ladrilhos a morte súbita já fechou
    this.suddenClock = 0;
    this.over = false;
    this.winner = null; // id de quem venceu (null = empate)
    this.solo = people.length === 1 && bots === 0; // treino: só termina quando a pessoa morre (ou o tempo acaba)
  }

  // Paredes/buracos extras sem dividir o mapa em pedaços (confere com uma busca a cada um)
  addFixed(count, tile, safe) {
    let placed = 0;
    for (let tries = 0; placed < count && tries < count * 20; tries++) {
      const x = 1 + Math.floor(this.random() * (W - 2));
      const y = 1 + Math.floor(this.random() * (H - 2));
      if (this.at(x, y) !== '.' || safe(x, y)) continue;
      this.set(x, y, tile);
      if (this.connected()) placed++;
      else this.set(x, y, '.');
    }
  }
  connected() {
    const open = (x, y) => this.at(x, y) === '.';
    const [sx, sy] = SPAWNS[0];
    const seen = new Set([`${sx},${sy}`]);
    const queue = [[sx, sy]];
    while (queue.length) {
      const [x, y] = queue.shift();
      for (const [dx, dy] of Object.values(DIRS)) {
        const k = `${x + dx},${y + dy}`;
        if (!seen.has(k) && open(x + dx, y + dy)) { seen.add(k); queue.push([x + dx, y + dy]); }
      }
    }
    let total = 0;
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (open(x, y)) total++;
    return seen.size === total;
  }

  at(x, y) { return x < 0 || y < 0 || x >= W || y >= H ? '#' : this.grid[y * W + x]; }
  set(x, y, c) { this.grid[y * W + x] = c; }
  bombAt(x, y) { return this.bombs.find((b) => b.x === x && b.y === y); }
  flameAt(x, y) { return this.flames.some((f) => f.x === x && f.y === y); }
  player(id) { return this.players.find((p) => p.id === id); }

  // Ladrilho em que a pessoa "está" (o de saída até a metade do caminho, depois o de chegada)
  tileOf(p) { return p.progress < 0.5 ? [p.x, p.y] : [p.tx, p.ty]; }

  // Dá para entrar? Não em parede, bloco, buraco ou bomba (a não ser a bomba em que já se está em cima)
  canEnter(x, y, p) {
    if (this.at(x, y) !== '.') return false;
    const bomb = this.bombAt(x, y);
    return !bomb || (bomb.x === p.x && bomb.y === p.y && p.progress >= 1);
  }

  // O que chega do site: direção segurada (ou null ao soltar), bomba e detonar (com o detonador)
  input(id, { dir, bomb, act } = {}) {
    const p = this.player(id);
    if (!p || !p.alive || this.over || p.bot) return;
    if (dir !== undefined) p.want = DIRS[dir] ? dir : null;
    if (bomb) this.placeBomb(p);
    if (act === 'boom') this.detonate(p);
  }

  eliminate(id) {
    const p = this.player(id);
    if (p) p.alive = false;
  }

  placeBomb(p) {
    const [x, y] = this.tileOf(p);
    if (this.bombAt(x, y) || this.at(x, y) !== '.') return;
    if (this.bombs.filter((b) => b.owner === p.id).length >= p.bombs) return;
    this.bombs.push({ x, y, owner: p.id, fuse: p.remote ? REMOTE_FUSE_MS : FUSE_MS, range: p.range, remote: p.remote, slide: null });
  }

  // Detonador: explode a bomba mais antiga da pessoa
  detonate(p) {
    const bomb = this.bombs.find((b) => b.owner === p.id && b.remote);
    if (bomb) bomb.fuse = 0;
  }

  tick(ms) {
    if (this.over) return;
    this.elapsed += ms;
    for (const p of this.players) if (p.alive && p.bot) this.botThink(p, ms);
    for (const p of this.players) if (p.alive) this.move(p, ms);
    this.slideBombs(ms);
    // Bombas: o pavio corre; explosões podem detonar outras bombas na hora (reação em cadeia)
    for (const b of this.bombs) b.fuse -= ms;
    let lit;
    while ((lit = this.bombs.find((b) => b.fuse <= 0))) this.explode(lit);
    for (const f of this.flames) f.ttl -= ms;
    this.flames = this.flames.filter((f) => f.ttl > 0);
    if (this.sudden && this.elapsed >= SUDDEN_MS) this.closeIn(ms);
    // Quem está no fogo morre (o escudo segura uma vez)
    for (const p of this.players) {
      if (!p.alive || !this.flameAt(...this.tileOf(p))) continue;
      if (this.elapsed < p.shieldUntil) continue;
      if (p.shield) { p.shield = false; p.shieldUntil = this.elapsed + SHIELD_GRACE_MS; continue; }
      p.alive = false;
    }
    this.checkEnd();
  }

  // Morte súbita: fecha um ladrilho por vez em espiral; quem estiver nele morre (escudo não salva)
  closeIn(ms) {
    this.suddenClock += ms;
    while (this.suddenClock >= SUDDEN_STEP_MS && this.closed < this.spiral.length) {
      this.suddenClock -= SUDDEN_STEP_MS;
      const [x, y] = this.spiral[this.closed++];
      if (this.at(x, y) === '#') continue;
      this.set(x, y, '#');
      this.items.delete(`${x},${y}`);
      this.bombs = this.bombs.filter((b) => !(b.x === x && b.y === y));
      for (const p of this.players) {
        const [px, py] = this.tileOf(p);
        if (p.alive && px === x && py === y) p.alive = false;
      }
    }
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
        if (p.bot) { p.think = 0; break; } // robô: decide de novo a cada ladrilho (não segue no embalo)
      }
      if (!p.want) break;
      // Maldição: os controles ficam invertidos
      const dir = this.elapsed < p.cursedUntil ? OPPOSITE[p.want] : p.want;
      const [dx, dy] = DIRS[dir];
      const nx = p.x + dx;
      const ny = p.y + dy;
      if (!this.canEnter(nx, ny, p)) {
        // Chute: andando contra uma bomba parada, ela sai deslizando
        const bomb = this.bombAt(nx, ny);
        if (p.kick && bomb && !bomb.slide && this.at(nx + dx, ny + dy) === '.' && !this.bombAt(nx + dx, ny + dy)) bomb.slide = { dir, progress: 0 };
        break;
      }
      p.tx = nx;
      p.ty = ny;
      p.progress = 0;
    }
  }

  // Bombas chutadas andam até bater em parede, bloco, buraco, outra bomba ou alguém
  slideBombs(ms) {
    for (const b of this.bombs) {
      if (!b.slide) continue;
      b.slide.progress += (KICK_SPEED * ms) / 1000;
      while (b.slide && b.slide.progress >= 1) {
        const [dx, dy] = DIRS[b.slide.dir];
        const nx = b.x + dx;
        const ny = b.y + dy;
        const person = this.players.some((p) => p.alive && this.tileOf(p)[0] === nx && this.tileOf(p)[1] === ny);
        if (this.at(nx, ny) !== '.' || this.bombAt(nx, ny) || person) { b.slide = null; break; }
        b.x = nx;
        b.y = ny;
        b.slide.progress -= 1;
      }
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
    if (item === 'kick') p.kick = true;
    if (item === 'remote') p.remote = true;
    if (item === 'shield') p.shield = true;
    if (item === 'curse') p.cursedUntil = this.elapsed + CURSE_MS;
  }

  randomItem() {
    let r = this.random() * Object.values(ITEM_WEIGHTS).reduce((a, b) => a + b, 0);
    for (const [k, w] of Object.entries(ITEM_WEIGHTS)) { r -= w; if (r < 0) return k; }
    return 'bomb';
  }

  // Explosão em cruz: para na parede; quebra o primeiro bloco (que pode soltar um item);
  // passa por cima de buracos; queima itens soltos no caminho; acende outras bombas
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
          if (this.random() < DROP_CHANCE) this.items.set(`${x},${y}`, this.randomItem());
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

  // ---------- Robôs ----------
  // A cada ~0,15 s: se o ladrilho vai explodir, foge para o lugar seguro mais perto; senão, pega item,
  // quebra bloco ou caça alguém — só solta bomba se tiver para onde fugir.

  // Ladrilhos que vão pegar fogo (bombas no mapa + a que o robô pensa em soltar)
  dangerMap(extra = null) {
    const danger = new Set(this.flames.map((f) => `${f.x},${f.y}`));
    for (const b of extra ? [...this.bombs, extra] : this.bombs) {
      danger.add(`${b.x},${b.y}`);
      for (const [dx, dy] of Object.values(DIRS)) {
        for (let i = 1; i <= b.range; i++) {
          const c = this.at(b.x + dx * i, b.y + dy * i);
          if (c === '#') break;
          danger.add(`${b.x + dx * i},${b.y + dy * i}`);
          if (c === 'x') break;
        }
      }
    }
    if (this.sudden && this.elapsed >= SUDDEN_MS - 3000) {
      for (const [x, y] of this.spiral.slice(this.closed, this.closed + 12)) danger.add(`${x},${y}`); // a espiral vem vindo
    }
    return danger;
  }

  // Quando cada ladrilho vai pegar fogo (ms); fogo aceso = 0. Reação em cadeia: a bomba acesa por outra usa o menor tempo.
  dangerTimes(extra = null) {
    const times = new Map(this.flames.map((f) => [`${f.x},${f.y}`, 0]));
    const bombs = (extra ? [...this.bombs, { ...extra, fuse: FUSE_MS }] : this.bombs).map((b) => ({ ...b }));
    // Bomba no alcance de outra que explode antes: explode junto
    for (let changed = true; changed;) {
      changed = false;
      for (const a of bombs) {
        for (const b of bombs) {
          if (a === b || b.fuse <= a.fuse) continue;
          const inLine = (a.x === b.x && Math.abs(a.y - b.y) <= a.range) || (a.y === b.y && Math.abs(a.x - b.x) <= a.range);
          if (inLine) { b.fuse = a.fuse; changed = true; }
        }
      }
    }
    const mark = (k, t) => { if (!times.has(k) || times.get(k) > t) times.set(k, t); };
    for (const b of bombs) {
      mark(`${b.x},${b.y}`, b.fuse);
      for (const [dx, dy] of Object.values(DIRS)) {
        for (let i = 1; i <= b.range; i++) {
          const c = this.at(b.x + dx * i, b.y + dy * i);
          if (c === '#') break;
          mark(`${b.x + dx * i},${b.y + dy * i}`, b.fuse);
          if (c === 'x') break;
        }
      }
    }
    return times;
  }

  // Busca em largura a partir do ladrilho do robô; devolve o primeiro passo até o alvo mais perto.
  // Fugindo (avoidDanger = false), pode cruzar área de perigo só se der tempo de passar antes de explodir.
  path(p, goal, danger, avoidDanger = true, times = null) {
    const tileMs = 1000 / p.speed;
    const start = `${p.x},${p.y}`;
    const fire = new Set(this.flames.map((f) => `${f.x},${f.y}`)); // fogo aceso: nunca atravessa
    const parent = new Map([[start, null]]);
    const queue = [[p.x, p.y, 0]];
    while (queue.length) {
      const [x, y, d] = queue.shift();
      if (d > 0 && goal(x, y)) {
        let key = `${x},${y}`;
        while (parent.get(key) !== start) key = parent.get(key);
        const [tx, ty] = key.split(',').map(Number);
        return { dir: Object.keys(DIRS).find((k) => DIRS[k][0] === tx - p.x && DIRS[k][1] === ty - p.y), dist: d };
      }
      if (d > 14) continue;
      for (const [dx, dy] of Object.values(DIRS)) {
        const nx = x + dx;
        const ny = y + dy;
        const k = `${nx},${ny}`;
        if (parent.has(k) || this.at(nx, ny) !== '.' || this.bombAt(nx, ny) || fire.has(k)) continue;
        if (avoidDanger && danger.has(k)) continue; // nunca entra em área de explosão por vontade própria
        if (times?.has(k) && times.get(k) < (d + 1) * tileMs + 400) continue; // explode antes de dar tempo de passar
        parent.set(k, `${x},${y}`);
        queue.push([nx, ny, d + 1]);
      }
    }
    return null;
  }

  botThink(p, ms) {
    p.think -= ms;
    if (p.progress < 1 || p.think > 0) return;
    p.think = 150;
    p.want = null;
    const danger = this.dangerMap();
    const here = `${p.x},${p.y}`;
    const safe = (x, y) => !danger.has(`${x},${y}`);
    // 1) Em perigo: foge (mesmo passando por lugar perigoso, se for o único jeito)
    if (danger.has(here)) {
      const out = this.path(p, safe, danger, false, this.dangerTimes()) ?? this.path(p, safe, danger, false);
      if (out) p.want = out.dir;
      return;
    }
    const enemies = this.players.filter((q) => q.alive && q !== p);
    const nearEnemy = enemies.some((q) => {
      const [qx, qy] = this.tileOf(q);
      if (qx !== p.x && qy !== p.y) return false;
      const dist = Math.abs(qx - p.x) + Math.abs(qy - p.y);
      if (dist > p.range) return false;
      const [dx, dy] = [Math.sign(qx - p.x), Math.sign(qy - p.y)];
      for (let i = 1; i < dist; i++) if (this.at(p.x + dx * i, p.y + dy * i) !== '.') return false;
      return true;
    });
    const nextToBlock = Object.values(DIRS).some(([dx, dy]) => this.at(p.x + dx, p.y + dy) === 'x');
    // 2) Bomba: perto de bloco ou de alguém na linha, e só se der para fugir depois
    if ((nextToBlock || nearEnemy) && this.bombs.filter((b) => b.owner === p.id).length < p.bombs && !this.bombAt(p.x, p.y)) {
      const future = this.dangerMap({ x: p.x, y: p.y, range: p.range });
      const escape = this.path(p, (x, y) => !future.has(`${x},${y}`), future, false, this.dangerTimes({ x: p.x, y: p.y, range: p.range }));
      if (escape && escape.dist <= 4) {
        this.placeBomb(p);
        p.want = escape.dir;
        return;
      }
    }
    // 3) Item bom por perto (maldição não)
    const item = this.path(p, (x, y) => { const it = this.items.get(`${x},${y}`); return it && it !== 'curse'; }, danger);
    if (item && item.dist <= 6) { p.want = item.dir; return; }
    // 4) Vai para perto de um bloco ou de alguém (já está bem posicionado e sem bomba: espera)
    const good = (x, y) => Object.values(DIRS).some(([dx, dy]) => this.at(x + dx, y + dy) === 'x')
      || enemies.some((q) => { const [qx, qy] = this.tileOf(q); return Math.abs(qx - x) + Math.abs(qy - y) <= 2; });
    if (good(p.x, p.y) && this.bombs.some((b) => b.owner === p.id)) return;
    const target = this.path(p, good, danger);
    if (target) { p.want = target.dir; return; }
    // 5) Sem nada para fazer: passeia sem entrar em perigo
    const options = Object.keys(DIRS).filter((d) => { const [dx, dy] = DIRS[d]; return this.canEnter(p.x + dx, p.y + dy, p) && safe(p.x + dx, p.y + dy); });
    if (options.length) p.want = options[Math.floor(this.random() * options.length)];
  }

  checkEnd() {
    const alive = this.players.filter((p) => p.alive);
    const people = alive.filter((p) => !p.bot);
    if (this.solo ? alive.length === 0 : alive.length <= 1) {
      this.over = true;
      this.winner = this.solo ? null : alive[0]?.id ?? null;
    } else if (!people.length && this.players.some((p) => !p.bot)) {
      // Todas as pessoas morreram e sobraram robôs: acaba (ganha o robô que sobrou, se for só um)
      this.over = true;
      this.winner = alive.length === 1 ? alive[0].id : null;
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
        id: p.id, name: p.name, color: p.color, alive: p.alive, bot: p.bot,
        x: p.x, y: p.y, tx: p.tx, ty: p.ty, p: Math.round(p.progress * 100) / 100, speed: p.speed,
        bombs: p.bombs, range: p.range, kick: p.kick, remote: p.remote,
        shield: p.shield || this.elapsed < p.shieldUntil, cursed: this.elapsed < p.cursedUntil,
      })),
      bombs: this.bombs.map((b) => ({ x: b.x, y: b.y, fuse: Math.max(0, Math.round(b.fuse)), remote: b.remote })),
      flames: this.flames.map((f) => [f.x, f.y]),
      items: [...this.items].map(([k, v]) => { const [x, y] = k.split(',').map(Number); return [x, y, v]; }),
      timeLeft: Math.max(0, ROUND_MS - this.elapsed),
      sudden: this.sudden && this.elapsed >= SUDDEN_MS,
      suddenIn: this.sudden ? Math.max(0, SUDDEN_MS - this.elapsed) : null,
      over: this.over,
      winner: this.winner,
      botsWon: this.over && this.players.some((p) => p.alive && p.bot) && !this.players.some((p) => p.alive && !p.bot),
    };
  }
}
