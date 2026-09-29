// /limpar: apaga as últimas mensagens do canal (só quem gerencia mensagens; fixadas ficam)
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { startServer, Person } from './helpers.js';

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

test('membro comum não pode limpar', async () => {
  const r = await ana.request({ t: 'msg:purge', channel: geral, count: 5 });
  assert.equal(r.t, 'error');
  assert.match(r.message, /Gerenciar mensagens/);
});

test('apaga as N últimas, pula as fixadas e avisa todo mundo', async () => {
  const sent = [];
  for (let i = 1; i <= 6; i++) sent.push(await (i % 2 ? dono : ana).say(geral, `mensagem ${i}`));
  await dono.request({ t: 'msg:pin', id: sent[5].id, pinned: true }); // a mais nova fica fixada
  const r = await dono.request({ t: 'msg:purge', channel: geral, count: 3 });
  assert.equal(r.t, 'purged');
  assert.equal(r.deleted, 3);
  // Sumiram a 3ª, 4ª e 5ª (a 6ª estava fixada); a 1ª e a 2ª continuam
  for (const m of sent.slice(2, 5)) await ana.waitFor('msg:delete', (e) => e.id === m.id);
  const hist = await ana.request({ t: 'history', channel: geral });
  const texts = hist.messages.map((m) => m.text);
  for (const t of ['mensagem 1', 'mensagem 2', 'mensagem 6']) assert.ok(texts.includes(t), t);
  for (const t of ['mensagem 3', 'mensagem 4', 'mensagem 5']) assert.ok(!texts.includes(t), t);
});

test('limite de 100 e entra na auditoria', async () => {
  const r = await dono.request({ t: 'msg:purge', channel: geral, count: 5000 });
  assert.equal(r.t, 'purged');
  const db = new DatabaseSync(path.join(server.dir, 'teste.db'), { readOnly: true });
  try {
    const rows = db.prepare("SELECT detail FROM audit_log WHERE action = 'msg:purge'").all().map((x) => JSON.parse(x.detail));
    assert.equal(rows.length, 2);
    assert.equal(rows[0].count, 3);
    assert.equal(rows[0].canal, 'geral');
  } finally { db.close(); }
});
