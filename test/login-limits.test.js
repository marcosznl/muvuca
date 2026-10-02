// Limite de senhas erradas por conta
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { accountLimiter } from '../src/login-limits.js';

test('10 erros seguidos bloqueiam por 1 min; o bloqueio dobra e para em 15 min', () => {
  const lim = accountLimiter();
  let now = 1_000_000;
  for (let i = 0; i < 9; i++) lim.failed('ana', now);
  assert.equal(lim.locked('ana', now), false);
  lim.failed('ana', now);
  assert.equal(lim.locked('ana', now), true);
  assert.equal(lim.locked('ana', now + 60_001), false);
  now += 60_001;
  for (let i = 0; i < 10; i++) lim.failed('ana', now);
  assert.equal(lim.locked('ana', now + 119_000), true); // segunda vez: 2 min
});

test('a limpeza não zera quem ainda está errando senhas (bug: zerava a cada 30 s)', () => {
  const lim = accountLimiter();
  const now = 5_000_000;
  for (let i = 0; i < 5; i++) lim.failed('caio', now);
  lim.cleanup(now + 30_000);            // a limpeza roda a cada 30 s
  for (let i = 0; i < 5; i++) lim.failed('caio', now + 31_000);
  assert.equal(lim.locked('caio', now + 31_000), true);
});

test('esquece a conta 1 hora depois do último erro; acertar a senha zera na hora', () => {
  const lim = accountLimiter();
  lim.failed('bia', 0);
  lim.cleanup(3_000_000);
  assert.equal(lim.size(), 1);
  lim.cleanup(3_600_001);
  assert.equal(lim.size(), 0);
  lim.failed('bia', 0);
  lim.succeeded('bia');
  assert.equal(lim.size(), 0);
});
