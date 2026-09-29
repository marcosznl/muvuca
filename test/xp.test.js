// XP da conta: curva de níveis, XP por mensagem (com espera e conteúdo mínimo) e o que o site recebe
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { xpInfo, xpToNext } from '../src/xp-curve.js';
import { startServer, Person } from './helpers.js';

test('curva: nível 1 = 250 XP, cada nível custa mais que o anterior, e bem mais difícil que o MEE6', () => {
  assert.deepEqual(xpInfo(0), { total: 0, level: 0, into: 0, need: 250 });
  assert.equal(xpInfo(249).level, 0);
  assert.equal(xpInfo(250).level, 1);
  assert.deepEqual(xpInfo(300), { total: 300, level: 1, into: 50, need: 375 });
  assert.equal(xpInfo(14_125).level, 10);
  assert.equal(xpInfo(14_124).level, 9);
  for (let n = 0; n < 50; n++) assert.ok(xpToNext(n + 1) > xpToNext(n));
  const mee6Total10 = Array.from({ length: 10 }, (_, n) => 5 * n * n + 50 * n + 100).reduce((a, b) => a + b);
  assert.ok(14_125 > mee6Total10 * 3);
  assert.equal(xpInfo(-5).total, 0);
});

let server;
let dono;
let ana;
let geral;
before(async () => {
  server = await startServer();
  dono = await new Person(server, 'dono').register();
  ana = await new Person(server, 'ana').register();
  geral = dono.servers[0].channels.find((c) => c.type === 'text').id;
});
after(async () => {
  dono?.close();
  ana?.close();
  await server?.stop();
});

test('a conta começa no nível 0 e o site recebe o XP (o próprio e o dos membros)', () => {
  assert.deepEqual(dono.me.xp, { total: 0, level: 0, into: 0, need: 250 });
  assert.equal(typeof dono.welcome.xpRank, 'number');
  const member = dono.servers[0].members.find((m) => m.id === ana.me.id);
  assert.equal(member.xp.level, 0);
});

test('mensagem dá 15 a 25 XP; a segunda no mesmo minuto não dá; mensagem curta não dá', async () => {
  await ana.say(geral, 'oi');
  await ana.say(geral, 'primeira mensagem de verdade');
  const ev = await ana.waitFor('xp');
  assert.ok(ev.gained >= 15 && ev.gained <= 25, `ganhou ${ev.gained}`);
  assert.equal(ev.xp.total, ev.gained, 'a mensagem curta ("oi") não contou');
  assert.equal(ev.reason, 'message');
  await ana.say(geral, 'segunda mensagem logo em seguida');
  await assert.rejects(ana.waitFor('xp', () => true, 600), /não chegou/);
  // Só a própria pessoa recebe o aviso de XP
  await assert.rejects(dono.waitFor('xp', () => true, 300), /não chegou/);
});

test('painel: dar, tirar (sem ficar negativo) e zerar XP; a pessoa é avisada e fica no histórico', async () => {
  const fs = await import('node:fs');
  const path = await import('node:path');
  const { DatabaseSync } = await import('node:sqlite');
  const key = fs.readFileSync(path.join(server.dir, 'painel-key'), 'utf8').trim();
  const adjust = (body) => fetch(`${server.base}/internal/xp/adjust`, { method: 'POST', headers: { 'x-painel-key': key, 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then(async (r) => ({ status: r.status, body: await r.json() }));
  const start = (await adjust({ userId: ana.me.id, amount: 1000 })).body;
  assert.equal(start.after, start.before + 1000);
  const ev = await ana.waitFor('xp', (e) => e.reason === 'admin');
  assert.equal(ev.gained, 1000);
  assert.equal(ev.xp.level, 2); // ~1.020 XP: nível 2 (o 3 começa em 1.175)
  const down = (await adjust({ userId: ana.me.id, amount: -999_999 })).body;
  assert.equal(down.after, 0, 'não fica negativo');
  await adjust({ userId: ana.me.id, amount: 300 });
  const reset = (await adjust({ userId: ana.me.id, reset: true })).body;
  assert.equal(reset.before, 300);
  assert.equal(reset.after, 0);
  assert.equal((await adjust({ userId: ana.me.id, amount: 0 })).status, 400);
  assert.equal((await fetch(`${server.base}/internal/xp/adjust`, { method: 'POST', body: '{}' })).status, 404, 'sem a chave do painel não funciona');
  const db = new DatabaseSync(path.join(server.dir, 'teste.db'), { readOnly: true });
  try {
    const rows = db.prepare("SELECT amount, reason FROM xp_events WHERE reason LIKE 'admin%' ORDER BY id").all();
    assert.deepEqual(rows.map((r) => r.amount), [1000, -(1000 + start.before), 300, -300]);
  } finally { db.close(); }
});
