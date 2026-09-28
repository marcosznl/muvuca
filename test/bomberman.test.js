// Testes das regras do Bomberman (sem rede nem tela)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Bomberman, W, H, FUSE_MS, FLAME_MS, ROUND_MS } from '../src/games/bomberman.js';

const two = () => [{ id: 'u1', name: 'Ana' }, { id: 'u2', name: 'Bia' }];
// Mapa sem blocos, para controlar o que acontece
const empty = (players = two()) => new Bomberman(players, { seed: 1, blocks: false });
const run = (g, ms, step = 50) => { for (let t = 0; t < ms; t += step) g.tick(step); };

// Anda `tiles` ladrilhos numa direção e para (solta a tecla antes de chegar no último)
function walk(g, id, dir, tiles) {
  const p = g.player(id);
  const perTile = 1000 / p.speed;
  g.input(id, { dir });
  run(g, tiles * perTile - 50);
  g.input(id, { dir: null });
  run(g, 100);
}
const pos = (g, id) => { const p = g.player(id); return [p.x, p.y]; };
const place = (g, id, x, y) => Object.assign(g.player(id), { x, y, tx: x, ty: y, progress: 1 });

test('o mapa tem bordas e pilares fixos, e os cantos de saída ficam livres', () => {
  const g = new Bomberman(two(), { seed: 42 });
  assert.equal(g.grid.length, W * H);
  assert.equal(g.at(0, 0), '#');
  assert.equal(g.at(2, 2), '#');
  for (const [x, y] of [[1, 1], [2, 1], [1, 2], [W - 2, H - 2], [W - 3, H - 2], [W - 2, H - 3]]) assert.equal(g.at(x, y), '.');
  assert.ok(g.grid.includes('x'), 'tem blocos para quebrar');
});

test('a mesma semente gera o mesmo mapa', () => {
  assert.equal(new Bomberman(two(), { seed: 7 }).grid.join(''), new Bomberman(two(), { seed: 7 }).grid.join(''));
});

test('andar: vai de ladrilho em ladrilho, segue enquanto segura e para na parede', () => {
  const g = empty();
  walk(g, 'u1', 'right', 4);
  assert.deepEqual(pos(g, 'u1'), [5, 1]);
  walk(g, 'u1', 'up', 1); // em cima é borda
  assert.deepEqual(pos(g, 'u1'), [5, 1]);
  walk(g, 'u1', 'down', 1); // (5,2): x ímpar, livre
  assert.deepEqual(pos(g, 'u1'), [5, 2]);
  walk(g, 'u1', 'right', 1); // (6,2) é pilar
  assert.deepEqual(pos(g, 'u1'), [5, 2]);
});

test('bomba: explode depois do pavio, em cruz, e mata quem está no alcance', () => {
  const g = empty();
  g.input('u1', { bomb: true });
  assert.equal(g.bombs.length, 1);
  walk(g, 'u1', 'right', 2); // (3,1): ainda no alcance 2
  assert.deepEqual(pos(g, 'u1'), [3, 1]);
  run(g, FUSE_MS);
  assert.equal(g.player('u1').alive, false);
  assert.equal(g.over, true);
  assert.equal(g.winner, 'u2');
});

test('fugindo para fora da cruz, a pessoa sobrevive', () => {
  const g = empty();
  g.input('u1', { bomb: true });
  walk(g, 'u1', 'right', 2); // (3,1)
  walk(g, 'u1', 'down', 1);  // (3,2): fora da cruz da bomba em (1,1)
  assert.deepEqual(pos(g, 'u1'), [3, 2]);
  run(g, FUSE_MS + FLAME_MS);
  assert.equal(g.player('u1').alive, true);
  assert.equal(g.over, false);
});

test('não dá para atravessar bomba, mas dá para sair de cima da própria', () => {
  const g = empty();
  g.bombs.push({ x: W - 3, y: H - 2, owner: 'u1', fuse: 99999, range: 1 });
  walk(g, 'u2', 'left', 1);
  assert.deepEqual(pos(g, 'u2'), [W - 2, H - 2]);
  g.input('u2', { bomb: true });
  assert.equal(g.bombs.length, 2);
  walk(g, 'u2', 'up', 1);
  assert.deepEqual(pos(g, 'u2'), [W - 2, H - 3]);
  walk(g, 'u2', 'down', 1); // voltar para cima da bomba: não
  assert.deepEqual(pos(g, 'u2'), [W - 2, H - 3]);
});

test('limite de bombas por pessoa (1 no começo)', () => {
  const g = empty();
  g.input('u1', { bomb: true });
  walk(g, 'u1', 'right', 1);
  g.input('u1', { bomb: true });
  assert.equal(g.bombs.length, 1);
});

test('bloco quebra com a explosão, e o fogo não passa dele', () => {
  const g = empty();
  place(g, 'u1', 1, 5);
  g.set(5, 1, 'x');
  g.bombs.push({ x: 3, y: 1, owner: 'u2', fuse: 10, range: 5 });
  place(g, 'u2', W - 2, H - 2);
  g.tick(50);
  assert.equal(g.at(5, 1), '.');
  assert.ok(g.flameAt(5, 1));
  assert.ok(!g.flameAt(6, 1), 'o fogo para no bloco');
});

test('reação em cadeia: uma bomba acende a outra', () => {
  const g = empty();
  g.bombs.push({ x: 5, y: 1, owner: 'u1', fuse: 100, range: 2 }, { x: 7, y: 1, owner: 'u2', fuse: 99999, range: 1 });
  run(g, 150);
  assert.equal(g.bombs.length, 0);
  assert.ok(g.flameAt(8, 1));
});

test('power-ups: pegar aumenta bombas, alcance e velocidade', () => {
  const g = empty();
  const ana = g.player('u1');
  g.items.set('2,1', 'bomb');
  g.items.set('3,1', 'fire');
  g.items.set('4,1', 'speed');
  walk(g, 'u1', 'right', 3);
  assert.deepEqual([ana.bombs, ana.range, ana.speed], [2, 3, 5]);
  assert.equal(g.items.size, 0);
});

test('o fogo queima power-ups soltos', () => {
  const g = empty();
  g.items.set('7,1', 'fire');
  g.bombs.push({ x: 6, y: 1, owner: 'u1', fuse: 10, range: 2 });
  run(g, 50);
  assert.equal(g.items.size, 0);
});

test('treino sozinho: só acaba quando a pessoa morre; tempo esgotado é empate', () => {
  const solo = empty([{ id: 'u1', name: 'Ana' }]);
  run(solo, 1000);
  assert.equal(solo.over, false);
  const g = empty();
  g.tick(ROUND_MS);
  assert.equal(g.over, true);
  assert.equal(g.winner, null);
});

test('estado para o site é compacto e completo', () => {
  const s = new Bomberman(two(), { seed: 3 }).state();
  assert.equal(s.grid.length, W * H);
  assert.equal(s.players.length, 2);
  assert.ok(JSON.stringify(s).length < 2000);
});
