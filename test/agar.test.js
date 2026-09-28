// Testes das regras do Agar-lite (sem rede nem tela)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Agar, COUNTDOWN_MS, START_MASS, PELLETS, ROUND_MS, pelletPos, radius, speedOf } from '../src/games/agar.js';

const two = () => [{ id: 'u1', name: 'Ana' }, { id: 'u2', name: 'Bia' }];
const run = (g, ms, step = 50) => { for (let t = 0; t < ms; t += step) g.tick(step); };
const ready = (players = two(), opts = { bots: false }) => { const g = new Agar(players, opts); run(g, COUNTDOWN_MS); return g; };
const place = (g, id, x, y, mass) => Object.assign(g.player(id), { x, y, ...(mass ? { mass } : {}) });

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
  assert.ok(g.player('u1').x > 22);
  assert.ok(Math.abs(g.player('u1').y - 20) < 1e-9);
  assert.ok(speedOf(100) < speedOf(10));
});

test('come comidinha e cresce; a comida volta depois de um tempo', () => {
  const g = ready();
  const [x, y] = pelletPos(0);
  place(g, 'u1', x, y);
  place(g, 'u2', x > 40 ? 5 : 75, 5);
  const before = g.player('u1').mass;
  g.tick(50);
  assert.ok(g.player('u1').mass > before);
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
  assert.ok(g.player('u1').mass >= 100 + START_MASS - 1);
  assert.equal(g.player('u1').eaten, 1);
  run(g, 3000);
  assert.equal(g.player('u2').alive, true);
  assert.equal(g.player('u2').mass, START_MASS);
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
  const start = [bot.x, bot.y];
  run(g, COUNTDOWN_MS + 2000);
  assert.notDeepEqual([bot.x, bot.y], start);
  const s = g.state();
  assert.equal(s.pellets.length, PELLETS);
  assert.ok(JSON.stringify(s).length < 2000);
});
