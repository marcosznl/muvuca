// Aparelhos conectados (sair de um ou de todos os outros), app/versão de cada aparelho e erros do site no painel
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import WebSocket from 'ws';
import { startServer, startPainel, Person } from './helpers.js';

let server;
let painel;
let pc;

// Mais um aparelho da mesma conta (login com a senha, conecta pelo WebSocket)
async function device(username) {
  const p = new Person(server, username);
  p.token = (await p.post('/api/login', { username, password: 'senha-123' })).body.token;
  await p.connect();
  return p;
}

before(async () => {
  server = await startServer();
  pc = await new Person(server, 'lia').register();
  painel = await startPainel(server);
});
after(async () => {
  pc?.close();
  await painel?.stop();
  await server?.stop();
});

test('aparelhos conectados: lista, sair de um e sair de todos os outros', async () => {
  const phone = await device('lia');
  const tablet = await device('lia');
  await phone.request({ t: 'client:info', app: 'pwa', version: 'x', platform: 'iPhone' });
  const list = (await pc.request({ t: 'sessions:list' })).sessions;
  assert.equal(list.length, 3);
  assert.equal(list.filter((s) => s.current).length, 1);
  assert.ok(list.every((s) => /^[0-9a-f]{16}$/.test(s.id) && s.lastSeen && s.ip));
  const phoneSess = list.find((s) => s.client?.app === 'pwa');
  assert.ok(phoneSess, JSON.stringify(list));
  assert.equal(phoneSess.client.version, null); // versão inválida não é guardada
  // Não dá para "sair" do próprio aparelho por aqui
  const self = list.find((s) => s.current);
  assert.match((await pc.request({ t: 'sessions:end', id: self.id })).message, /Sair da conta/);
  // Sair do celular: ele cai na hora e o token deixa de valer
  const r = await pc.request({ t: 'sessions:end', id: phoneSess.id });
  assert.equal(r.sessions.length, 2);
  await phone.waitFor('error', (e) => e.code === 'auth');
  // Tentar conectar de novo com o token antigo: a sessão não existe mais
  const reply = await new Promise((resolve) => {
    const ws = new WebSocket(`${server.base.replace('http', 'ws')}/ws`);
    ws.on('open', () => ws.send(JSON.stringify({ t: 'hello', token: phone.token })));
    ws.on('message', (raw) => { resolve(JSON.parse(raw)); ws.close(); });
  });
  assert.equal(reply.code, 'auth');
  // Sair de todos os outros: sobra só este
  const all = await pc.request({ t: 'sessions:end-others' });
  assert.equal(all.ended, 1);
  assert.equal(all.sessions.length, 1);
  await tablet.waitFor('error', (e) => e.code === 'auth');
  phone.close(); tablet.close();
});

test('app e versão de cada aparelho chegam ao painel (Ao vivo e cartão da pessoa)', async () => {
  await pc.request({ t: 'client:info', app: 'desktop', version: '1.4.5', platform: 'Windows' });
  const st = (await painel.get('/api/status')).body;
  // O painel coleta os números a cada 10 s; aqui pega direto do Muvuca
  const key = (await import('node:fs')).readFileSync((await import('node:path')).join(server.dir, 'painel-key'), 'utf8').trim();
  const stats = await (await fetch(`${server.base}/internal/stats`, { headers: { 'x-painel-key': key } })).json();
  const lia = stats.users.find((u) => u.username === 'lia');
  assert.ok(lia.clients.some((c) => c.app === 'desktop' && c.version === '1.4.5' && c.platform === 'Windows'), JSON.stringify(lia));
  assert.ok('desktopLatest' in st);
  const card = (await painel.get('/api/pessoa?user=lia')).body;
  assert.ok(card.devices.some((d) => d.client?.app === 'desktop' && d.client.version === '1.4.5'));
});

test('erros do site: chegam ao painel agrupados, repetidos viram contagem, "Resolvido" limpa', async () => {
  for (let i = 0; i < 3; i++) await pc.request({ t: 'client:error', message: 'TypeError: x is undefined', stack: 'at f (http://site/js/chat.js:1:2)', source: 'http://site/js/chat.js', page: '/' });
  await pc.request({ t: 'client:error', message: '' }); // vazio: ignorado
  const d = (await painel.get('/api/client-errors?days=1')).body;
  const g = d.groups.find((x) => x.message === 'TypeError: x is undefined');
  assert.ok(g, JSON.stringify(d));
  assert.equal(g.count, 3);
  assert.deepEqual(g.people, ['lia']);
  assert.ok(g.devices.some((x) => /App 1\.4\.5/.test(x)));
  assert.equal((await painel.post('/api/client-errors/clear', { message: g.message })).status, 200);
  assert.ok(!(await painel.get('/api/client-errors?days=1')).body.groups.some((x) => x.message === g.message));
});
