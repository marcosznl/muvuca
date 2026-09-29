// Auditoria (painel administrativo) e o endereço interno de números do painel
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { startServer, Person } from './helpers.js';

let server;
let dono;
let ana;
let home;

before(async () => {
  server = await startServer();
  dono = await new Person(server, 'dono').register();
  ana = await new Person(server, 'ana').register();
  home = dono.servers[0].id;
});
after(async () => {
  dono?.close();
  ana?.close();
  await server?.stop();
});

const rows = (action) => {
  const db = new DatabaseSync(path.join(server.dir, 'teste.db'), { readOnly: true });
  try {
    return db.prepare('SELECT * FROM audit_log WHERE action = ? ORDER BY id').all(action).map((r) => ({ ...r, detail: r.detail && JSON.parse(r.detail) }));
  } finally { db.close(); }
};

test('cadastro, login certo e errado ficam registrados (errado como falha)', async () => {
  assert.equal(rows('auth:register').length, 2);
  const p = new Person(server, 'ana');
  await p.post('/api/login', { username: 'ana', password: 'errada' });
  await p.post('/api/login', { username: 'ninguem', password: 'errada' });
  await p.post('/api/login', { username: 'ana', password: 'senha-123' });
  const fails = rows('auth:login:fail');
  assert.equal(fails.length, 2);
  assert.equal(fails[0].ok, 0);
  assert.equal(fails[0].detail.contaExiste, true);
  assert.equal(fails[1].detail.contaExiste, false);
  assert.equal(rows('auth:login').at(-1).user_name, 'ana');
});

test('ações de gerenciamento guardam os nomes (mesmo depois de apagar)', async () => {
  assert.equal((await dono.request({ t: 'channel:create', serverId: home, name: 'temporario', type: 'text' })).t, 'channel:created');
  const ch = dono.server_(home).channels.find((c) => c.name === 'temporario')
    ?? (await dono.waitFor('server', (e) => e.server.channels.some((c) => c.name === 'temporario'))).server.channels.find((c) => c.name === 'temporario');
  await dono.request({ t: 'channel:delete', channelId: ch.id });
  const del = rows('channel:delete').at(-1);
  assert.equal(del.detail.canal, 'temporario');
  assert.equal(del.user_name, 'dono');
  assert.equal(del.server_id, home);
  // Ação recusada (sem permissão) não entra
  await ana.request({ t: 'channel:create', serverId: home, name: 'nao-pode', type: 'text' });
  assert.ok(!rows('channel:create').some((r) => r.detail.name === 'nao-pode'));
});

test('mensagem apagada: só registra quando é de outra pessoa (com o texto); a própria não', async () => {
  const geral = dono.server_(home).channels.find((c) => c.type === 'text');
  const m1 = await ana.say(geral.id, 'mensagem da ana');
  await dono.request({ t: 'msg:delete', id: m1.id });
  const m2 = await ana.say(geral.id, 'apago a minha');
  await ana.request({ t: 'msg:delete', id: m2.id });
  const r = rows('msg:delete:other');
  assert.equal(r.length, 1);
  assert.equal(r[0].detail.autor, 'ana');
  assert.equal(r[0].detail.texto, 'mensagem da ana');
});

test('conversa privada fica fora da auditoria', async () => {
  await dono.request({ t: 'dm:open', userIds: [ana.me.id] });
  let dm = dono.servers.find((x) => x.kind === 'dm');
  if (!dm) dm = (await dono.waitFor('server', (e) => e.server.kind === 'dm')).server;
  await ana.waitFor('server', (e) => e.server.id === dm.id).catch(() => null);
  const text = dm.channels.find((c) => c.type === 'text');
  const m = await ana.say(text.id, 'segredo da conversa');
  const before = rows('msg:pin').length + rows('msg:delete:other').length;
  assert.equal((await dono.request({ t: 'msg:pin', id: m.id, pinned: true })).t, 'ok');
  await dono.request({ t: 'msg:delete', id: m.id });
  assert.equal(rows('msg:pin').length + rows('msg:delete:other').length, before);
  const db = new DatabaseSync(path.join(server.dir, 'teste.db'), { readOnly: true });
  try {
    assert.ok(!db.prepare("SELECT 1 FROM audit_log WHERE detail LIKE '%segredo%'").get());
  } finally { db.close(); }
});

test('/internal/stats: só com a chave do painel e sem passar pelo proxy', async () => {
  const key = fs.readFileSync(path.join(server.dir, 'painel-key'), 'utf8').trim();
  assert.equal((await fetch(`${server.base}/internal/stats`)).status, 404);
  assert.equal((await fetch(`${server.base}/internal/stats`, { headers: { 'x-painel-key': 'errada' } })).status, 404);
  assert.equal((await fetch(`${server.base}/internal/stats`, { headers: { 'x-painel-key': key, 'x-forwarded-for': '8.8.8.8' } })).status, 404);
  const ok = await fetch(`${server.base}/internal/stats`, { headers: { 'x-painel-key': key } });
  assert.equal(ok.status, 200);
  const s = await ok.json();
  assert.equal(s.users.length, 2);
  assert.ok(s.memory.rss > 0);
  const mode = fs.statSync(path.join(server.dir, 'painel-key')).mode & 0o777;
  assert.equal(mode, 0o600);
});
