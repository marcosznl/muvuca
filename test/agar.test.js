// Testes das regras do Agar-lite (sem rede nem tela)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Agar, COUNTDOWN_MS, START_MASS, PELLETS, ROUND_MS, MERGE_MS, VIRUS_MASS, VIRUS_FEED, MAX_CELLS, pelletPos, radius, speedOf, massOf } from '../src/games/agar.js';

const two = () => [{ id: 'u1', name: 'Ana' }, { id: 'u2', name: 'Bia' }];
const run = (g, ms, step = 50) => { for (let t = 0; t < ms; t += step) g.tick(step); };
const ready = (players = two(), opts = { bots: false }) => { const g = new Agar(players, opts); run(g, COUNTDOWN_MS); return noViruses(g); };
// Põe a pessoa inteira numa parte só, em x/y (e com a massa pedida)
const place = (g, id, x, y, mass) => {
  const p = g.player(id);
  p.cells = [{ ...p.cells[0], x, y, vx: 0, vy: 0, merge: 0, ...(mass ? { mass } : {}) }];
  return p.cells[0];
};
const cell = (g, id) => g.player(id).cells[0];
const noViruses = (g) => { g.viruses = []; g.virusQueue = []; return g; };

test('com pouca gente entram robôs; sem robôs, só quem joga', () => {
  assert.equal(new Agar(two()).players.length, 4);
  assert.equal(new Agar(two()).players.filter((p) => p.bot).length, 2);
  assert.equal(new Agar(two(), { bots: false }).players.length, 2);
});

test('segue o mouse (direção relativa) e maior anda mais devagar', () => {
  const g = ready();
  place(g, 'u1', 20, 20);
  g.pellets.fill(1); // sem comida no caminho
  g.input('u1', { x: 10, y: 0 });
  run(g, 500);
  assert.ok(cell(g, 'u1').x > 22);
  assert.ok(Math.abs(cell(g, 'u1').y - 20) < 1e-9);
  assert.ok(speedOf(100) < speedOf(10));
});

test('come comidinha e cresce; a comida volta depois de um tempo', () => {
  const g = ready();
  const [x, y] = pelletPos(0);
  place(g, 'u1', x, y);
  place(g, 'u2', x > 40 ? 5 : 75, 5);
  const before = massOf(g.player('u1'));
  g.tick(50);
  assert.ok(massOf(g.player('u1')) > before);
  assert.ok(g.pellets[0] > 0);
  assert.equal(g.state().pellets[0], '0');
  place(g, 'u1', x > 40 ? 5 : 75, 75); // sai de cima (senão come de novo quando voltar)
  run(g, 4100);
  assert.equal(g.state().pellets[0], '1');
});

test('grande engole pequena (e ganha a massa); a pequena volta pequena depois', () => {
  const g = ready();
  g.pellets.fill(99_999);
  place(g, 'u1', 40, 40, 100);
  place(g, 'u2', 40.5, 40, START_MASS);
  g.tick(50);
  assert.equal(g.player('u2').alive, false);
  assert.ok(massOf(g.player('u1')) >= 100 + START_MASS - 1);
  assert.equal(g.player('u1').eaten, 1);
  run(g, 3000);
  assert.equal(g.player('u2').alive, true);
  assert.equal(massOf(g.player('u2')), START_MASS);
});

test('do mesmo tamanho ninguém engole ninguém', () => {
  const g = ready();
  g.pellets.fill(99_999);
  place(g, 'u1', 40, 40, 50);
  place(g, 'u2', 40.2, 40, 50);
  g.tick(50);
  assert.ok(g.player('u1').alive && g.player('u2').alive);
  assert.ok(radius(50) > radius(10));
});

test('no fim do tempo ganha quem está maior; se todo mundo sai, acaba', () => {
  const g = ready();
  place(g, 'u1', 10, 10, 30);
  place(g, 'u2', 70, 70, 80);
  g.elapsed = ROUND_MS;
  g.tick(50);
  assert.equal(g.over, true);
  assert.equal(g.winner, 'u2');
  const solo = ready([{ id: 'u1', name: 'Ana' }], {});
  solo.eliminate('u1');
  solo.tick(50);
  assert.equal(solo.over, true);
});

test('robôs andam sozinhos e o estado é compacto', () => {
  const g = new Agar([{ id: 'u1', name: 'Ana' }]);
  const bot = g.player('bot1');
  const start = g.center(bot);
  run(g, COUNTDOWN_MS + 2000);
  assert.notDeepEqual(g.center(bot), start);
  const s = g.state();
  assert.equal(s.pellets.length, PELLETS);
  assert.ok(JSON.stringify(s).length < 2500);
});

test('Espaço divide ao meio e lança a metade; depois do tempo as partes se juntam de novo', () => {
  const g = ready();
  g.pellets.fill(99_999);
  place(g, 'u1', 30, 40, 80);
  place(g, 'u2', 75, 75);
  g.input('u1', { x: 10, y: 0, act: 'split' });
  const p = g.player('u1');
  assert.equal(p.cells.length, 2);
  assert.equal(p.cells[0].mass, 40);
  run(g, 1000);
  assert.ok(Math.abs(p.cells[0].x - p.cells[1].x) > 1, 'a metade saiu voando para a frente');
  // Pequena demais não divide
  place(g, 'u2', 75, 75, 20);
  g.input('u2', { act: 'split' });
  assert.equal(g.player('u2').cells.length, 1);
  g.input('u1', { x: 0, y: 0 });
  run(g, MERGE_MS + 3000);
  assert.equal(p.cells.length, 1);
  assert.ok(Math.abs(massOf(p) - 80) < 2);
});

test('nunca passa de 8 partes', () => {
  const g = ready();
  g.pellets.fill(99_999);
  place(g, 'u1', 40, 40, 1000);
  for (let i = 0; i < 5; i++) g.input('u1', { x: 10, y: 0, act: 'split' });
  assert.equal(g.player('u1').cells.length, MAX_CELLS);
});

test('W solta massa: quem soltou perde, outro pode comer', () => {
  const g = ready();
  g.pellets.fill(99_999);
  place(g, 'u1', 20, 40, 40);
  place(g, 'u2', 32, 40, 30);
  g.input('u1', { x: 10, y: 0, act: 'eject' });
  assert.equal(g.blobs.length, 1);
  assert.equal(massOf(g.player('u1')), 37);
  run(g, 1000);
  assert.equal(g.blobs.length, 0);
  assert.ok(massOf(g.player('u2')) > 30);
  // Pequena demais não solta
  place(g, 'u1', 20, 40, 15);
  g.input('u1', { act: 'eject' });
  assert.equal(g.blobs.length, 0);
});

test('vírus estoura quem é grande em vários pedaços; pequeno passa por baixo', () => {
  const g = ready();
  g.pellets.fill(99_999);
  g.viruses = [{ x: 40, y: 40, vx: 0, vy: 0, fed: 0 }];
  place(g, 'u2', 75, 75);
  place(g, 'u1', 40, 40, 30);
  g.tick(50);
  assert.equal(g.viruses.length, 1, 'pequena se esconde no vírus');
  place(g, 'u1', 40, 40, 200);
  g.tick(50);
  assert.equal(g.viruses.length, 0);
  assert.ok(g.player('u1').cells.length >= 5);
  assert.ok(massOf(g.player('u1')) >= 200);
  run(g, 9000);
  assert.equal(g.viruses.length, 1, 'o vírus volta em outro lugar');
  assert.ok(VIRUS_MASS > 30);
});

test('massa solta num vírus faz ele disparar um vírus novo', () => {
  const g = ready();
  g.pellets.fill(99_999);
  g.viruses = [{ x: 40, y: 40, vx: 0, vy: 0, fed: 0 }];
  place(g, 'u2', 75, 75);
  for (let i = 0; i < VIRUS_FEED; i++) g.blobs.push({ x: 39.5, y: 40, vx: 5, vy: 0, mass: 2.5, owner: 'u1', age: 0 });
  g.tick(50);
  assert.equal(g.viruses.length, 2);
  assert.ok(g.viruses[1].x > 40, 'sai na direção em que a massa veio');
});

test('equipes: dois times, não come o colega, ganha o time com mais massa', () => {
  const four = [...two(), { id: 'u3', name: 'Cid' }, { id: 'u4', name: 'Duda' }];
  const g = ready(four, { bots: false, options: { equipes: true } });
  g.pellets.fill(99_999);
  assert.deepEqual(g.players.map((p) => p.team), [0, 1, 0, 1]);
  place(g, 'u1', 40, 40, 100);
  place(g, 'u3', 40.5, 40, START_MASS); // mesmo time: não come
  place(g, 'u2', 10, 10, 20);
  place(g, 'u4', 70, 70, 20);
  g.tick(50);
  assert.ok(g.player('u3').alive);
  place(g, 'u2', 40.5, 40.3, START_MASS); // outro time: come
  g.tick(50);
  assert.equal(g.player('u2').alive, false);
  g.elapsed = ROUND_MS;
  g.tick(50);
  assert.equal(g.over, true);
  assert.equal(g.winnerTeam, 0);
  assert.deepEqual(g.winners.sort(), ['u1', 'u3']);
  assert.equal(g.state().teams[0].label, 'Vermelho');
  // Número ímpar de pessoas: entra robô para empatar os times
  assert.equal(new Agar([{ id: 'u1', name: 'A' }, { id: 'u2', name: 'B' }, { id: 'u3', name: 'C' }], { options: { equipes: true } }).players.length, 4);
});

test('robôs jogam uma partida inteira sem quebrar (com vírus, divisões e tudo)', () => {
  const g = new Agar([{ id: 'u1', name: 'Ana' }]);
  run(g, ROUND_MS + 100, 50);
  assert.equal(g.over, true);
  for (const p of g.players) for (const c of p.cells) assert.ok(Number.isFinite(c.x) && Number.isFinite(c.y) && c.mass > 0);
});
