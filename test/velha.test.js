// Testes das regras do jogo da velha (sem rede nem tela)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Velha, bestMove, TURN_MS, BOT_DELAY_MS } from '../src/games/velha.js';

const two = () => [{ id: 'u1', name: 'Ana' }, { id: 'u2', name: 'Bia' }];

test('cada um na sua vez; casa ocupada não vale', () => {
  const g = new Velha(two());
  g.input('u2', { cell: 0 }); // não é a vez da Bia
  assert.equal(g.board[0], null);
  g.input('u1', { cell: 4 });
  assert.equal(g.board[4], 0);
  g.input('u2', { cell: 4 }); // ocupada
  assert.equal(g.state().turn, 'u2');
  g.input('u2', { cell: 99 });
  g.input('u2', { cell: 0 });
  assert.equal(g.board[0], 1);
});

test('três em linha vence e marca a linha', () => {
  const g = new Velha(two());
  for (const [id, cell] of [['u1', 0], ['u2', 3], ['u1', 1], ['u2', 4], ['u1', 2]]) g.input(id, { cell });
  assert.equal(g.over, true);
  assert.equal(g.winner, 'u1');
  assert.deepEqual(g.line, [0, 1, 2]);
});

test('deu velha: acaba empatado', () => {
  const g = new Velha(two());
  // X O X / X O O / O X X
  for (const [id, cell] of [['u1', 0], ['u2', 1], ['u1', 2], ['u2', 4], ['u1', 3], ['u2', 5], ['u1', 7], ['u2', 6], ['u1', 8]]) g.input(id, { cell });
  assert.equal(g.over, true);
  assert.equal(g.winner, null);
});

test('quem começa alterna a cada partida', () => {
  assert.equal(new Velha(two(), { round: 0 }).state().turn, 'u1');
  assert.equal(new Velha(two(), { round: 1 }).state().turn, 'u2');
});

test('tempo esgotado: a jogada sai sozinha', () => {
  const g = new Velha(two());
  g.tick(TURN_MS);
  assert.equal(g.board.filter((v) => v === 0).length, 1);
  assert.equal(g.state().turn, 'u2');
});

test('sozinho joga contra o robô, que responde depois de um instante', () => {
  const g = new Velha([{ id: 'u1', name: 'Ana' }], { random: () => 0.99 });
  assert.equal(g.players[1].bot, true);
  g.input('u1', { cell: 0 });
  g.tick(BOT_DELAY_MS - 100);
  assert.equal(g.board.filter((v) => v === 1).length, 0);
  g.tick(200);
  assert.equal(g.board.filter((v) => v === 1).length, 1);
});

test('o robô fecha o jogo e bloqueia quando precisa', () => {
  assert.equal(bestMove([1, 1, null, 0, 0, null, null, null, null], 1), 2); // ganha
  assert.equal(bestMove([0, 0, null, null, 1, null, null, null, null], 1), 2); // bloqueia
});

test('quem sai perde; só avisa quando muda algo', () => {
  const g = new Velha(two());
  g.dirty = false;
  g.tick(50);
  assert.equal(g.dirty, false);
  g.eliminate('u1');
  assert.equal(g.dirty, true);
  assert.equal(g.winner, 'u2');
});
