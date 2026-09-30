// Painel: senha temporária (troca obrigatória no primeiro login) e excluir a conta com tudo dela
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import WebSocket from 'ws';
import { startServer, Person, PNG } from './helpers.js';

let server;
let dono;
let ana;
let bia;
let home;
let geral;
let key;
before(async () => {
  server = await startServer();
  dono = await new Person(server, 'dono').register();
  ana = await new Person(server, 'ana').register();
  bia = await new Person(server, 'bia').register();
  home = dono.servers[0].id;
  geral = dono.servers[0].channels.find((c) => c.type === 'text').id;
  key = fs.readFileSync(path.join(server.dir, 'painel-key'), 'utf8').trim();
});
after(async () => {
  for (const p of [dono, ana, bia]) p?.close();
  await server?.stop();
});
const internal = (pathname, body) => fetch(`${server.base}${pathname}`, { method: 'POST', headers: { 'x-painel-key': key, 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  .then(async (r) => ({ status: r.status, body: await r.json() }));
const login = (username, password) => fetch(`${server.base}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password }) })
  .then(async (r) => ({ status: r.status, body: await r.json() }));
// Abre a conexão e devolve a primeira resposta (welcome ou erro)
const hello = (token) => new Promise((resolve, reject) => {
  const ws = new WebSocket(`${server.base.replace('http', 'ws')}/ws`);
  ws.on('open', () => ws.send(JSON.stringify({ t: 'hello', token })));
  ws.on('message', (raw) => { const m = JSON.parse(raw); if (m.t === 'welcome' || m.t === 'error') { resolve(m); ws.close(); } });
  ws.on('error', reject);
});

test('senha temporária: derruba as sessões, entra uma vez e só usa o Muvuca depois de trocar', async () => {
  assert.equal((await internal('/internal/user/reset-password', { userId: bia.me.id, password: '123' })).status, 400, 'curta demais');
  const r = await internal('/internal/user/reset-password', { userId: bia.me.id, password: 'temporaria-1' });
  assert.equal(r.body.ok, true);
  assert.ok(r.body.sessions >= 1, 'as sessões antigas caíram');
  assert.equal((await login('bia', 'senha-123')).status, 401, 'a senha antiga não vale mais');
  const l = await login('bia', 'temporaria-1');
  assert.equal(l.body.mustChange, true);
  const blocked = await hello(l.body.token);
  assert.equal(blocked.code, 'must_change', 'sem trocar, não entra no Muvuca');
  const change = await fetch(`${server.base}/api/password`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${l.body.token}` }, body: JSON.stringify({ current: 'temporaria-1', password: 'minha-nova-senha' }) });
  assert.equal(change.status, 200);
  assert.equal((await hello(l.body.token)).t, 'welcome', 'trocou: entra normalmente');
  const again = await login('bia', 'minha-nova-senha');
  assert.equal(again.body.mustChange, undefined);
  bia.token = again.body.token; // a Bia volta a usar o Muvuca (o próximo teste precisa dela)
  await bia.connect();
});

test('excluir conta: some tudo dela, servidor dela passa para o membro mais antigo, conversa privada fecha', async () => {
  // A Ana tem: mensagens, anexo, amizade, conversa privada e um servidor próprio com a Bia dentro
  await ana.say(geral, 'mensagem da ana');
  const up = await ana.upload('/api/attach', { channel: geral, name: 'foto.png', w: 1, h: 1 }, PNG);
  await ana.say(geral, '', { attachments: [up.body.id] });
  await ana.request({ t: 'friend:add', userId: dono.me.id });
  await dono.request({ t: 'friend:accept', userId: ana.me.id });
  await dono.request({ t: 'dm:open', userIds: [ana.me.id] });
  await ana.request({ t: 'server:create', name: 'Servidor da Ana' });
  const own = (await ana.waitFor('server', (e) => e.server.name === 'Servidor da Ana')).server;
  const code = (await ana.request({ t: 'invite:create', serverId: own.id })).code;
  assert.equal((await bia.request({ t: 'invite:accept', code })).t, 'ok');

  assert.match((await internal('/internal/user/delete', { userId: dono.me.id })).body.error, /dono do servidor principal/);
  dono.events = [];
  const r = await internal('/internal/user/delete', { userId: ana.me.id });
  assert.equal(r.body.ok, true);
  assert.ok(r.body.messages >= 2);
  assert.equal(r.body.files, 1);
  await dono.waitFor('user:purged', (e) => e.userId === ana.me.id);
  await dono.waitFor('server:removed'); // a conversa privada com a Ana fechou
  assert.equal((await login('ana', 'senha-123')).status, 401, 'a conta não existe mais');

  const db = new DatabaseSync(path.join(server.dir, 'teste.db'), { readOnly: true });
  try {
    const id = Number(ana.me.id.slice(1));
    assert.equal(db.prepare('SELECT COUNT(*) n FROM users WHERE id = ?').get(id).n, 0);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM messages WHERE user_id = ? OR author_name = ?').get(id, 'ana').n, 0, 'nenhuma mensagem dela ficou');
    assert.equal(db.prepare('SELECT COUNT(*) n FROM files WHERE owner_id = ?').get(id).n, 0);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM friends WHERE a = ? OR b = ?').get(id, id).n, 0);
    assert.equal(db.prepare("SELECT COUNT(*) n FROM servers WHERE kind = 'dm'").get().n, 0, 'a conversa privada que ficou com uma pessoa só sumiu');
    const srv = db.prepare('SELECT owner_id FROM servers WHERE id = ?').get(own.id);
    assert.equal(srv?.owner_id, Number(bia.me.id.slice(1)), 'o servidor dela passou para a Bia (membro mais antigo)');
  } finally { db.close(); }
  assert.equal(fs.existsSync(path.join(server.dir, 'files', up.body.id)), false, 'o anexo saiu do disco');
});
