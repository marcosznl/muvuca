// Anti-spam do chat e moderação pelo painel (apagar mensagem ou só um anexo)
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { checkSpam, clearSpam, SPAM_RULES } from '../src/antispam.js';
import { startServer, Person, PNG } from './helpers.js';

test('anti-spam: a mesma mensagem 4 vezes em 1 minuto trava; conversa normal não', () => {
  const id = 'u-teste-1';
  const t = 1_000_000;
  checkSpam(id, 'alguém quer jogar?', { now: t });
  checkSpam(id, 'Alguém  quer jogar?', { now: t + 1000 });
  checkSpam(id, 'alguém quer jogar?', { now: t + 2000 });
  assert.throws(() => checkSpam(id, 'alguém quer jogar?', { now: t + 3000 }), (err) => err.reason && err.timeoutMs === 60_000);
  // Travado: nem mensagem diferente passa até acabar o tempo
  assert.throws(() => checkSpam(id, 'outra coisa', { now: t + 30_000 }), /sem mandar mensagens por mais/);
  checkSpam(id, 'voltei', { now: t + 64_000 });
  // "kkkk", "sim", emoji: conversa normal, não conta como repetição
  for (let i = 0; i < 10; i++) checkSpam(id, i % 2 ? 'kkkkkkk' : 'sim', { now: t + 65_000 + i });
  clearSpam(id);
});

test('anti-spam: as travas aumentam (1, 5, 15 min) se repetir na mesma hora', () => {
  const id = 'u-teste-2';
  let t = 5_000_000;
  const spam = () => {
    for (let i = 0; i < SPAM_RULES.repeatCount - 1; i++) checkSpam(id, 'compre agora!!!', { now: t++ });
    try { checkSpam(id, 'compre agora!!!', { now: t++ }); } catch (err) { return err.timeoutMs; }
    return 0;
  };
  assert.equal(spam(), 60_000);
  t += 61_000;
  assert.equal(spam(), 5 * 60_000);
  t += 5 * 60_000 + 1000;
  assert.equal(spam(), 15 * 60_000);
  clearSpam(id);
});

test('anti-spam: marcar gente demais de uma vez', () => {
  const many = Array.from({ length: SPAM_RULES.maxMentions + 1 }, (_, i) => `<@u${i + 1}>`).join(' ');
  assert.throws(() => checkSpam('u-teste-3', many, { now: 1 }), /Marcou 7 pessoas/);
  checkSpam('u-teste-4', `<@u1> <@u2> <@u3> vamos?`, { now: 1 });
  for (const id of ['u-teste-3', 'u-teste-4']) clearSpam(id);
});

let server;
let dono;
let ana;
let geral;
let key;
before(async () => {
  server = await startServer();
  dono = await new Person(server, 'dono').register();
  ana = await new Person(server, 'ana').register();
  geral = dono.servers[0].channels.find((c) => c.type === 'text').id;
  key = fs.readFileSync(path.join(server.dir, 'painel-key'), 'utf8').trim();
});
after(async () => {
  dono?.close();
  ana?.close();
  await server?.stop();
});
const internal = (pathname, body) => fetch(`${server.base}${pathname}`, { method: 'POST', headers: { 'x-painel-key': key, 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  .then(async (r) => ({ status: r.status, body: await r.json() }));

test('no chat: a 4ª mensagem igual é recusada com o aviso e fica na auditoria', async () => {
  for (let i = 0; i < 3; i++) await ana.say(geral, 'entra no meu canal agora');
  const res = await ana.request({ t: 'msg', channel: geral, text: 'entra no meu canal agora' });
  assert.equal(res.t, 'error');
  assert.match(res.message, /mesma mensagem várias vezes.*1 min/);
  const again = await ana.request({ t: 'msg', channel: geral, text: 'posso falar?' });
  assert.match(again.message, /sem mandar mensagens por mais/);
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(path.join(server.dir, 'teste.db'), { readOnly: true });
  try {
    const row = db.prepare("SELECT detail FROM audit_log WHERE action = 'spam:timeout'").get();
    assert.ok(row, 'ficou na auditoria');
    assert.equal(JSON.parse(row.detail).trava, '1 min');
  } finally { db.close(); }
  clearSpam(ana.me.id);
});

test('painel: apagar só um anexo mantém a mensagem; apagar a mensagem avisa todo mundo', async () => {
  const a = await dono.upload('/api/attach', { channel: geral, name: 'a.png', w: 1, h: 1 }, PNG);
  const b = await dono.upload('/api/attach', { channel: geral, name: 'b.png', w: 1, h: 1 }, PNG);
  const msg = await dono.say(geral, 'duas fotos', { attachments: [a.body.id, b.body.id] });
  assert.equal(msg.attachments.length, 2);

  assert.equal((await internal('/internal/file/delete', { id: a.body.id })).body.message, 'edited');
  const edit = await ana.waitFor('msg:edit', (e) => e.msg.id === msg.id);
  assert.deepEqual(edit.msg.attachments.map((x) => x.id), [b.body.id]);
  assert.equal(edit.msg.text, 'duas fotos');
  assert.equal((await fetch(`${server.base}/file/${a.body.id}`)).status, 404, 'o arquivo saiu do disco/banco');

  assert.equal((await internal('/internal/message/delete', { id: msg.id })).body.files, 1);
  await ana.waitFor('msg:delete', (e) => e.id === msg.id);
  assert.equal((await fetch(`${server.base}/file/${b.body.id}`)).status, 404);

  // Mensagem só com um anexo: apagar o anexo apaga a mensagem
  const c = await dono.upload('/api/attach', { channel: geral, name: 'c.png', w: 1, h: 1 }, PNG);
  const only = await dono.say(geral, '', { attachments: [c.body.id] });
  assert.equal((await internal('/internal/file/delete', { id: c.body.id })).body.message, 'deleted');
  await ana.waitFor('msg:delete', (e) => e.id === only.id);

  assert.equal((await internal('/internal/message/delete', { id: 999_999 })).status, 400);
  assert.equal((await fetch(`${server.base}/internal/message/delete`, { method: 'POST', body: '{}' })).status, 404, 'sem a chave não funciona');
});

test('painel: conversa privada não pode ser apagada pelo painel', async () => {
  await dono.request({ t: 'dm:open', userIds: [ana.me.id] });
  let dm = dono.servers.find((x) => x.kind === 'dm');
  if (!dm) dm = (await dono.waitFor('server', (e) => e.server.kind === 'dm')).server;
  const text = dm.channels.find((c) => c.type === 'text');
  const m = await dono.say(text.id, 'segredo');
  const r = await internal('/internal/message/delete', { id: m.id });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /conversa privada/);
});
