// Testes das regras do Tron (sem rede nem tela)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Tron, W, COUNTDOWN_MS, START_SPEED } from '../src/games/tron.js';

const two = () => [{ id: 'u1', name: 'Ana' }, { id: 'u2', name: 'Bia' }];
const run = (g, ms, step = 50) => { for (let t = 0; t < ms; t += step) g.tick(step); };
const cellMs = 1000 / START_SPEED;

test('ninguém se mexe durante a contagem; depois todo mundo anda sozinho', () => {
  const g = new Tron(two());
  const a = g.player('u1');
  const start = [a.x, a.y];
  run(g, COUNTDOWN_MS);
  assert.deepEqual([a.x, a.y], start);
  run(g, cellMs * 5);
  assert.deepEqual([a.x, a.y], [start[0] + 5, start[1]]); // larga para a direita
  assert.equal(g.grid[start[1] * W + start[0] + 3], 1, 'deixou rastro');
});

test('curva: não dá para voltar pelo próprio rastro e o canto fica marcado', () => {
  const g = new Tron(two());
  const a = g.player('u1');
  run(g, COUNTDOWN_MS);
  g.input('u1', { dir: 'left' }); // ré: ignorado
  assert.deepEqual(a.turns, []);
  g.input('u1', { dir: 'down' });
  const [x, y] = [a.x, a.y];
  run(g, cellMs * 3);
  assert.equal(a.dir, 'down');
  assert.deepEqual(a.path.at(-1), [x, y]);
  assert.deepEqual([a.x, a.y], [x, y + 3]);
});

test('duas curvas rápidas seguidas funcionam (meia-volta em U)', () => {
  const g = new Tron(two());
  const a = g.player('u1');
  run(g, COUNTDOWN_MS + cellMs * 2);
  g.input('u1', { dir: 'down' });
  g.input('u1', { dir: 'left' });
  run(g, cellMs * 3);
  assert.equal(a.dir, 'left');
  assert.ok(a.alive);
});

test('bater na parede ou num rastro elimina; o último vivo vence', () => {
  const g = new Tron(two());
  run(g, COUNTDOWN_MS);
  g.input('u1', { dir: 'up' }); // sobe direto até a parede de cima
  run(g, cellMs * 15);
  assert.equal(g.player('u1').alive, false);
  assert.equal(g.over, true);
  assert.equal(g.winner, 'u2');
});

test('entrar no mesmo quadradinho ao mesmo tempo: os dois batem (empate)', () => {
  const g = new Tron(two());
  const [a, b] = g.players;
  Object.assign(a, { x: 10, y: 20, dir: 'right' });
  Object.assign(b, { x: 12, y: 20, dir: 'left' });
  run(g, COUNTDOWN_MS + cellMs * 2);
  assert.equal(a.alive, false);
  assert.equal(b.alive, false);
  assert.equal(g.over, true);
  assert.equal(g.winner, null);
});

test('sozinho é treino: só acaba quando bate; quem sai conta como eliminado', () => {
  const solo = new Tron([{ id: 'u1', name: 'Ana' }]);
  run(solo, COUNTDOWN_MS + cellMs * 3);
  assert.equal(solo.over, false);
  const g = new Tron(two());
  g.eliminate('u2');
  g.tick(50);
  assert.equal(g.winner, 'u1');
});

test('a velocidade sobe com o tempo', () => {
  const g = new Tron([{ id: 'u1', name: 'Ana' }]);
  assert.equal(g.speed, START_SPEED);
  g.elapsed = COUNTDOWN_MS + 25_000;
  assert.equal(g.speed, START_SPEED + 2);
});
