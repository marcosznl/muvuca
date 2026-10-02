// Painel administrativo: o quadro "Precisa de atenção", a busca única e o cartão da pessoa
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, startPainel, Person } from './helpers.js';

let server;
let painel;
let ana;

before(async () => {
  server = await startServer();
  ana = await new Person(server, 'ana').register();
  await ana.say(ana.servers[0].channels.find((c) => c.type === 'text').id, 'combinado: abacaxi às 20h');
  painel = await startPainel(server);
});
after(async () => {
  ana?.close();
  await painel?.stop();
  await server?.stop();
});

test('sem login, o painel não responde', async () => {
  const r = await fetch(`${painel.base}/api/atencao`, { headers: { 'x-painel': '1' } });
  assert.equal(r.status, 401);
});

test('"Precisa de atenção": cada item diz o nível, o texto e onde se resolve', async () => {
  const r = await painel.get('/api/atencao');
  assert.equal(r.status, 200);
  assert.ok(Array.isArray(r.body.items));
  for (const i of r.body.items) {
    assert.ok(['bad', 'warn', 'info'].includes(i.level), i.level);
    assert.ok(i.text && typeof i.text === 'string');
    assert.match(i.tab, /^[a-z]+$/);
  }
  // No ambiente de teste não há backup nenhum: aparece como pendência em Backups
  assert.ok(r.body.items.some((i) => i.tab === 'backups' && /backup/i.test(i.text)), JSON.stringify(r.body.items));
});

test('modo manutenção ligado aparece no quadro', async () => {
  const on = await painel.post('/api/maintenance', { on: true, message: 'Teste', minutes: 0, lock: false });
  assert.equal(on.status, 200, JSON.stringify(on.body));
  const r = await painel.get('/api/atencao');
  assert.ok(r.body.items.some((i) => i.tab === 'manut' && /manutenção/i.test(i.text)));
  await painel.post('/api/maintenance', { on: false });
  const off = await painel.get('/api/atencao');
  assert.ok(!off.body.items.some((i) => i.tab === 'manut' && /Modo manutenção/.test(i.text)));
});

test('cartão da pessoa: por id, por "u12" e por @usuário', async () => {
  const id = Number(ana.me.id.slice(1));
  for (const ref of [`id=${id}`, `id=u${id}`, 'user=%40ana', 'user=ANA']) {
    const r = await painel.get(`/api/pessoa?${ref}`);
    assert.equal(r.status, 200, ref);
    assert.equal(r.body.user.username, 'ana');
  }
  const r = await painel.get(`/api/pessoa?id=${id}`);
  assert.ok(r.body.messages.some((m) => m.text.includes('abacaxi')));
  assert.ok(r.body.servers.length >= 1);
  assert.ok(Array.isArray(r.body.ips) && Array.isArray(r.body.audit) && Array.isArray(r.body.xp7));
  assert.equal((await painel.get('/api/pessoa?user=ninguem')).status, 404);
});

test('busca única: pessoas, mensagens e IPs', async () => {
  const pessoas = await painel.get('/api/busca?q=an');
  assert.ok(pessoas.body.users.some((u) => u.username === 'ana'));
  assert.deepEqual(pessoas.body.messages, []); // menos de 3 letras: não procura mensagens
  const msgs = await painel.get('/api/busca?q=abacaxi');
  assert.ok(msgs.body.messages.some((m) => m.text.includes('abacaxi')));
  assert.deepEqual(msgs.body.ips, []); // não parece IP
  const ips = await painel.get('/api/busca?q=127.0');
  assert.ok(ips.body.ips.some((r) => r.ip.startsWith('127.0') && r.who.includes('ana')), JSON.stringify(ips.body.ips));
  // Caracteres especiais do LIKE não viram curinga
  assert.deepEqual((await painel.get('/api/busca?q=%25%25')).body.users, []);
  assert.deepEqual((await painel.get('/api/busca?q=a')).body, { users: [], ips: [], messages: [] });
});
