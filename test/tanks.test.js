// Testes das regras dos Tanquinhos (sem rede nem tela)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Tanks, COUNTDOWN_MS, HP, RELOAD_MS, MAX_BULLETS, SPEED, H } from '../src/games/tanks.js';

const two = () => [{ id: 'u1', name: 'Ana' }, { id: 'u2', name: 'Bia' }];
const run = (g, ms, step = 50) => { for (let t = 0; t < ms; t += step) g.tick(step); };
const place = (g, id, x, y) => Object.assign(g.player(id), { x, y });
const ready = (players = two()) => { const g = new Tanks(players); run(g, COUNTDOWN_MS); return g; };

test('anda na direção segurada, na diagonal também, e para quando solta', () => {
  const g = ready();
  const a = g.player('u1');
  const [x0, y0] = [a.x, a.y];
  g.input('u1', { dir: 'right' });
  run(g, 500);
  assert.ok(Math.abs(a.x - (x0 + SPEED / 2)) < 0.01);
  g.input('u1', { dir: 'down-right' });
  run(g, 200);
  assert.ok(a.y > y0);
  g.input('u1', { dir: null });
  const x1 = a.x;
  run(g, 500);
  assert.equal(a.x, x1);
});

test('não atravessa parede nem sai da arena', () => {
  const g = ready();
  const a = g.player('u1');
  g.input('u1', { dir: 'up' });
  run(g, 3000);
  assert.ok(a.y >= 0.45 - 1e-9);
  place(g, 'u1', 7, 6.5); // à esquerda do bloco do meio (8.5 a 11.5)
  g.input('u1', { dir: 'right' });
  run(g, 2000);
  assert.ok(a.x <= 8.5 - 0.45 + 1e-9);
});

test('tiro acerta, tira vida, e 3 tiros estouram o tanque (quem atirou ganha a partida)', () => {
  const g = ready();
  place(g, 'u1', 6, 4.2);
  place(g, 'u2', 13, 4.3);
  const b = g.player('u2');
  for (let i = 0; i < HP; i++) {
    g.input('u1', { aim: Math.atan2(b.y - 4.2, b.x - 6), fire: true });
    run(g, 1000);
  }
  assert.equal(b.hp, 0);
  assert.equal(b.alive, false);
  assert.equal(g.player('u1').kills, 1);
  assert.equal(g.over, true);
  assert.equal(g.winner, 'u1');
});

test('recarga e limite de balas no ar', () => {
  const g = ready();
  const a = g.player('u1');
  g.input('u1', { aim: Math.PI / 2, fire: true });
  g.input('u1', { fire: true }); // ainda recarregando
  assert.equal(g.bullets.length, 1);
  for (let i = 0; i < 10; i++) { a.reload = 0; g.input('u1', { fire: true }); }
  assert.equal(g.bullets.length, MAX_BULLETS);
  assert.ok(RELOAD_MS > 0);
});

test('a bala quica uma vez na parede e some na segunda', () => {
  const g = ready();
  place(g, 'u1', 2, H / 2 + 0.3);
  place(g, 'u2', 18, 11.5);
  g.input('u1', { aim: -Math.PI / 2, fire: true }); // para cima, direto na borda
  const bullet = g.bullets[0];
  run(g, 1200);
  assert.equal(bullet.bounces, 1);
  assert.ok(bullet.vy > 0, 'voltou para baixo');
  run(g, 2000);
  assert.equal(g.bullets.length, 0);
});

test('antes da largada ninguém anda nem atira', () => {
  const g = new Tanks(two());
  const a = g.player('u1');
  const x0 = a.x;
  g.input('u1', { dir: 'right', fire: true });
  run(g, COUNTDOWN_MS - 100);
  assert.equal(a.x, x0);
  assert.equal(g.bullets.length, 0);
});

test('sozinho aparece um robô para treinar; quem sai conta como eliminado', () => {
  const solo = new Tanks([{ id: 'u1', name: 'Ana' }]);
  assert.equal(solo.players.length, 2);
  assert.ok(solo.player('bot').bot);
  run(solo, 5000);
  const g = ready();
  g.eliminate('u2');
  g.tick(50);
  assert.equal(g.winner, 'u1');
});
