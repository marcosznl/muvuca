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
  assert.ok(Array.isArray(r.body.ips) && Array.isArray(r.body.audit) && typeof r.body.usage7.callMinutes === 'number');
  assert.ok(!('xp7' in r.body) && !('level' in r.body.user)); // o XP saiu
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
  assert.deepEqual((await painel.get('/api/busca?q=a')).body, { users: [], ips: [], messages: [], servers: [], channels: [] });
});

// ---------- Servidores ----------

test('servidores: lista, detalhe, busca e planilhas', async () => {
  const list = (await painel.get('/api/servers')).body;
  const home = list.find((s) => s.home);
  assert.ok(home, JSON.stringify(list));
  assert.ok(home.members >= 1 && home.channels.text >= 1);
  const d = (await painel.get(`/api/server?id=${home.id}`)).body;
  assert.ok(d.channels.some((c) => c.type === 'text' && c.msgs7 >= 1)); // a mensagem da ana
  assert.ok(d.members.some((m) => m.username === 'ana'));
  assert.ok(d.roles.some((r) => r.isDefault && r.perms.length));
  assert.equal(d.perDay.length, 14);
  assert.equal((await painel.get('/api/server?id=nada')).status, 404);
  // Busca acha servidor e canal ("#geral")
  const b = (await painel.get('/api/busca?q=%23geral')).body;
  assert.ok(b.channels.some((c) => c.name === 'geral' && c.server_id === home.id));
  // Planilhas
  const contas = await fetch(`${painel.base}/api/users.csv`, { headers: { 'x-painel': '1', cookie: painel.cookie() } });
  assert.match(contas.headers.get('content-type'), /text\/csv/);
  assert.match(await contas.text(), /ana/);
  const geral = d.channels.find((c) => c.name === 'geral');
  const msgs = await fetch(`${painel.base}/api/channel.csv?id=${geral.id}`, { headers: { 'x-painel': '1', cookie: painel.cookie() } });
  assert.match(await msgs.text(), /abacaxi/);
});

test('servidores pelo painel: renomear, passar a posse e excluir (todo mundo vê na hora)', async () => {
  const bia = await new Person(server, 'bia_sv').register();
  const sv = (await bia.request({ t: 'server:create', name: 'Turma da Bia' }), await bia.waitFor('server', (e) => e.server.name === 'Turma da Bia')).server;
  const code = (await bia.request({ t: 'invite:create', serverId: sv.id })).code;
  await ana.request({ t: 'invite:accept', code });
  await ana.waitFor('server', (e) => e.server.id === sv.id);
  // Renomear
  assert.equal((await painel.post('/api/server/rename', { id: sv.id, name: 'Turma Nova' })).status, 200);
  await bia.waitFor('server', (e) => e.server.id === sv.id && e.server.name === 'Turma Nova');
  // Passar a posse para a ana
  const ana_ = Number(ana.me.id.slice(1));
  assert.equal((await painel.post('/api/server/transfer', { id: sv.id, userId: ana_ })).status, 200);
  await bia.waitFor('server', (e) => e.server.id === sv.id && e.server.ownerId === ana.me.id);
  // Excluir: precisa do nome certo
  assert.equal((await painel.post('/api/server/delete', { id: sv.id, confirm: 'turma' })).status, 400);
  assert.equal((await painel.post('/api/server/delete', { id: sv.id, confirm: 'Turma Nova' })).status, 200);
  await bia.waitFor('server:removed', (e) => e.serverId === sv.id);
  assert.ok(!(await painel.get('/api/servers')).body.some((x) => x.id === sv.id));
  // O principal não pode ser excluído
  const home = (await painel.get('/api/servers')).body.find((x) => x.home);
  assert.equal((await painel.post('/api/server/delete', { id: home.id, confirm: home.name })).status, 500);
  // Ficou na auditoria
  const audit = (await painel.get('/api/audit?group=painel&limit=50')).body.rows.map((r) => r.action);
  for (const a of ['painel:server:rename', 'painel:server:transfer', 'painel:server:delete']) assert.ok(audit.includes(a), a);
  bia.close();
});

test('servidor sem dono aparece em "Precisa de atenção"; cartão da pessoa mostra o uso da semana', async () => {
  const { DatabaseSync } = await import('node:sqlite');
  const path = await import('node:path');
  const dbx = new DatabaseSync(path.join(server.dir, 'teste.db'));
  dbx.prepare("INSERT INTO servers (id, name, color, owner_id, created_at, kind) VALUES ('s-orfao', 'Órfão', '#123456', NULL, ?, 'server')").run(Date.now());
  dbx.close();
  const items = (await painel.get('/api/atencao')).body.items;
  assert.ok(items.some((i) => i.tab === 'servidores' && /Órfão/.test(i.text)), JSON.stringify(items));
  const p = (await painel.get(`/api/pessoa?user=ana`)).body;
  assert.ok(p.usage7 && typeof p.usage7.callMinutes === 'number' && p.usage7.messages >= 1 && Array.isArray(p.usage7.games));
});

test('serviços: recarregar o site de todos chega em quem está conectado; desligar exige DESLIGAR', async () => {
  const r = await painel.post('/api/service', { what: 'reload' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  await ana.waitFor('reload', () => true);
  // Reiniciar só a voz precisa do start.sh (no teste não roda): explica em vez de fingir que fez
  const v = await painel.post('/api/service', { what: 'voice' });
  assert.equal(v.status, 400);
  assert.match(v.body.error, /start\.sh/);
  const s = await painel.post('/api/service', { what: 'stop', confirm: 'sim' });
  assert.equal(s.status, 400);
  assert.match(s.body.error, /DESLIGAR/);
  assert.equal((await painel.get('/api/status')).body.stoppedByPanel, null); // nada foi desligado
  assert.equal((await painel.post('/api/service', { what: 'nada' })).status, 400);
  const audit = (await painel.get('/api/audit?group=painel&limit=50')).body.rows;
  assert.ok(audit.some((x) => x.action === 'painel:service' && /recarregar/.test(x.detail?.acao)));
});
