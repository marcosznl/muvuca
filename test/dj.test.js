// Salas de DJ: ficam fora dos servidores, para todo mundo; qualquer pessoa cria, com ou sem senha
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, Person, sleep } from './helpers.js';

let server;
let dono; // dono do Muvuca: administra todas as salas
let ana;
let bia;
let home;
const lobby = (p) => p.servers.find((s) => s.kind === 'dj');
const room = (p, id) => lobby(p)?.channels.find((c) => c.id === id);

before(async () => {
  server = await startServer();
  dono = await new Person(server, 'dono').register();
  ana = await new Person(server, 'ana').register();
  bia = await new Person(server, 'bia').register();
  home = dono.servers[0].id;
});
after(async () => {
  for (const p of [dono, ana, bia]) p?.close();
  await server?.stop();
});

test('todo mundo está nas salas de DJ, e elas não são mais canais de servidor', async () => {
  for (const p of [dono, ana, bia]) assert.ok(lobby(p), `${p.name} vê as salas de DJ`);
  const r = await dono.request({ t: 'channel:create', serverId: home, type: 'music', name: 'Pista' });
  assert.equal(r.t, 'error');
  assert.match(r.message, /Salas de música/);
  assert.equal((await ana.request({ t: 'server:leave', serverId: lobby(ana).id })).t, 'error');
});

test('sala sem senha: qualquer um entra, toca na cabine e conversa', async () => {
  const created = await ana.request({ t: 'dj:create', name: 'Pista' });
  assert.equal(created.t, 'dj:created');
  const id = created.channelId;
  await bia.waitFor('server', (e) => e.server.channels?.some((c) => c.id === id));
  assert.equal(room(bia, id).ownerId, ana.me.id);
  assert.equal(room(bia, id).locked, undefined);
  const joined = await bia.request({ t: 'music:join', channelId: id });
  assert.equal(joined.t, 'music:joined');
  assert.equal((await bia.request({ t: 'music:booth', channelId: id, join: true })).t, 'ok');
  // Quem criou tira gente da cabine; os outros não
  assert.equal((await dono.request({ t: 'music:join', channelId: id })).t, 'music:joined');
  assert.equal((await bia.request({ t: 'music:kick', channelId: id, userId: ana.me.id })).t, 'error');
  assert.equal((await ana.request({ t: 'music:kick', channelId: id, userId: bia.me.id })).t, 'ok');
  const msg = await bia.say(id, 'que som bom');
  assert.equal(msg.text, 'que som bom');
  await bia.request({ t: 'music:leave', channelId: id });
  await dono.request({ t: 'music:leave', channelId: id });
  assert.equal((await ana.request({ t: 'music:join', channelId: 'geral' })).t, 'error'); // não é sala de DJ
});

test('sala com senha: aparece para todos, mas só entra (e lê o chat) quem digitou a senha', async () => {
  const id = (await ana.request({ t: 'dj:create', name: 'VIP', password: 'segredo' })).channelId;
  await bia.waitFor('server', (e) => e.server.channels?.some((c) => c.id === id));
  assert.equal(room(bia, id).locked, true);
  assert.equal(room(bia, id).open, false);
  assert.equal(room(bia, id).access, undefined, 'não conta quem tem acesso');
  assert.equal(room(ana, id).open, true, 'quem criou já entra');
  assert.equal((await bia.request({ t: 'music:join', channelId: id })).t, 'error');
  assert.equal((await bia.request({ t: 'msg', channel: id, text: 'oi' })).t, 'error');
  // Mensagem na sala trancada não chega em quem não tem a senha
  dono.events = [];
  await ana.say(id, 'só pra quem sabe a senha');
  await sleep(150);
  assert.ok(!dono.events.some((e) => e.t === 'msg' && e.msg.channel === id));
  const wrong = await bia.request({ t: 'dj:unlock', channelId: id, password: 'chute' });
  assert.match(wrong.message, /Senha errada/);
  assert.equal((await bia.request({ t: 'dj:unlock', channelId: id, password: 'segredo' })).t, 'ok');
  await bia.waitFor('server', (e) => e.server.channels?.find((c) => c.id === id)?.open === true);
  assert.equal((await bia.request({ t: 'music:join', channelId: id })).t, 'music:joined');
  assert.equal((await bia.request({ t: 'history', channel: id })).t, 'history');

  // Só quem criou muda a senha; senha nova: quem tinha liberado precisa digitar de novo
  assert.equal((await bia.request({ t: 'dj:update', channelId: id, password: '' })).t, 'error');
  assert.equal((await ana.request({ t: 'dj:update', channelId: id, name: 'VIP 2', password: 'outra' })).t, 'ok');
  await bia.waitFor('server', (e) => e.server.channels?.find((c) => c.id === id)?.name === 'VIP 2');
  assert.equal(room(bia, id).open, false);
  assert.equal((await bia.request({ t: 'music:join', channelId: id })).t, 'error');
  // Sem senha: aberta para todos
  assert.equal((await ana.request({ t: 'dj:update', channelId: id, password: '' })).t, 'ok');
  await bia.waitFor('server', (e) => e.server.channels?.find((c) => c.id === id)?.locked === undefined);
  assert.equal((await bia.request({ t: 'music:join', channelId: id })).t, 'music:joined');
  await bia.request({ t: 'music:leave', channelId: id });
});

test('apagar: quem criou ou o dono do Muvuca; e cada pessoa cria no máximo 3', async () => {
  const id = (await bia.request({ t: 'dj:create', name: 'Da Bia' })).channelId;
  assert.equal((await ana.request({ t: 'dj:delete', channelId: id })).t, 'error');
  assert.equal((await dono.request({ t: 'dj:delete', channelId: id })).t, 'ok');
  await bia.waitFor('server', (e) => e.server.kind === 'dj' && !e.server.channels.some((c) => c.id === id));
  // A Ana já tem 2 (Pista e VIP 2): a 3ª pode, a 4ª não
  assert.equal((await ana.request({ t: 'dj:create', name: 'Terceira' })).t, 'dj:created');
  const fourth = await ana.request({ t: 'dj:create', name: 'Quarta' });
  assert.match(fourth.message, /3 salas/);
  assert.equal((await ana.request({ t: 'dj:create', name: '   ' })).t, 'error');
});
