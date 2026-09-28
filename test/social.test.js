// Testes dos recursos "sociais": reações, não lidas, digitando, busca, avisos de entrada/saída,
// status, placar dos jogos e a checagem de saúde. Servidor próprio (roda junto com os outros testes).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, Person, sleep } from './helpers.js';

let server;
let dono;
let bia;
let home;

before(async () => {
  server = await startServer();
  dono = await new Person(server, 'dono').register();
  bia = await new Person(server, 'bia').register();
  home = dono.servers[0].id;
});

after(async () => {
  dono?.close();
  bia?.close();
  await server?.stop();
});

const snap = (p) => p.server_(home);
const geral = (p) => snap(p).channels.find((c) => c.type === 'text').id;

test('quem chega ganha aviso de boas-vindas no chat (com menção)', async () => {
  const ev = await dono.waitFor('msg', (e) => e.msg.system && e.msg.kind === 'join' && e.msg.text.includes(`<@${bia.me.id}>`));
  assert.match(ev.msg.text, /Boas-vindas/);
});

test('avisos personalizados: texto novo, e desligados não aparecem', async () => {
  const ch = geral(dono);
  assert.equal((await bia.request({ t: 'server:welcome', serverId: home, on: true })).t, 'error'); // sem permissão
  await dono.request({ t: 'server:welcome', serverId: home, on: true, channelId: ch, joinText: 'Chegou {user} no {server}!', leaveText: 'Tchau {user}', gameAnnounce: true });
  await sleep(100);
  assert.equal(snap(dono).welcome.joinText, 'Chegou {user} no {server}!');
  const carla = await new Person(server, 'carla').register();
  const ev = await dono.waitFor('msg', (e) => e.msg.kind === 'join' && e.msg.text.startsWith('Chegou'));
  assert.equal(ev.msg.text, `Chegou <@${carla.me.id}> no ${snap(dono).name}!`);
  await carla.request({ t: 'server:leave', serverId: home }); // o servidor principal: sair é permitido para quem não é dono
  const bye = await dono.waitFor('msg', (e) => e.msg.kind === 'leave');
  assert.equal(bye.msg.text, 'Tchau carla');
  carla.close();
  await dono.request({ t: 'server:welcome', serverId: home, on: false, gameAnnounce: false });
  const davi = await new Person(server, 'davi').register();
  await sleep(300);
  assert.ok(!dono.events.some((e) => e.t === 'msg' && e.msg.text.includes(davi.me.id)));
  davi.close();
});

test('reações: liga, junta por emoji, desliga; emoji inválido é recusado', async () => {
  const ch = geral(dono);
  const msg = await dono.say(ch, 'reage aí');
  await bia.request({ t: 'msg:react', id: msg.id, emoji: '👍' });
  await dono.request({ t: 'msg:react', id: msg.id, emoji: '👍' });
  let ev = await dono.waitFor('msg:reactions', (e) => e.id === msg.id && e.reactions[0]?.users.length === 2);
  assert.deepEqual(ev.reactions[0].users.sort(), [bia.me.id, dono.me.id].sort());
  await bia.request({ t: 'msg:react', id: msg.id, emoji: '👍', on: false });
  ev = await dono.waitFor('msg:reactions', (e) => e.id === msg.id && e.reactions[0]?.users.length === 1);
  assert.equal((await bia.request({ t: 'msg:react', id: msg.id, emoji: 'texto' })).t, 'error');
  assert.equal((await bia.request({ t: 'msg:react', id: msg.id, emoji: '<:nada:e-0000000000>' })).t, 'error');
  const hist = await bia.request({ t: 'history', channel: ch });
  assert.deepEqual(hist.messages.find((m) => m.id === msg.id).reactions, [{ emoji: '👍', users: [dono.me.id] }]);
});

test('não lidas sobrevivem a reconectar; ler zera (em todas as abas)', async () => {
  const ch = geral(dono);
  await dono.say(ch, `oi <@${bia.me.id}>`);
  const last = await dono.say(ch, 'segunda');
  const aba2 = new Person(server, 'bia');
  aba2.token = bia.token;
  await aba2.connect();
  assert.equal(aba2.welcome.unread[ch].n >= 2, true);
  assert.equal(aba2.welcome.unread[ch].mentions, 1);
  await bia.request({ t: 'read', channel: ch, id: last.id });
  await aba2.waitFor('read', (e) => e.channel === ch && e.id === last.id);
  const aba3 = new Person(server, 'bia');
  aba3.token = bia.token;
  await aba3.connect();
  assert.equal(aba3.welcome.unread[ch], undefined);
  assert.equal(aba3.welcome.readState[ch], last.id);
  // Quem manda a mensagem não fica com ela como não lida
  assert.equal(dono.welcome.unread[ch], undefined);
  aba2.close();
  aba3.close();
});

test('digitando: avisa os outros, não a própria pessoa', async () => {
  const ch = geral(dono);
  bia.send({ t: 'typing', channel: ch });
  const ev = await dono.waitFor('typing', (e) => e.channel === ch);
  assert.equal(ev.userId, bia.me.id);
  await sleep(100);
  assert.ok(!bia.events.some((e) => e.t === 'typing'));
});

test('busca: encontra pelo texto, filtra por pessoa e escapa % e _', async () => {
  const ch = geral(dono);
  await bia.say(ch, 'procurando o abacaxi 100%');
  await dono.say(ch, 'abacaxi também');
  const all = await dono.request({ t: 'search', serverId: home, text: 'abacaxi' });
  assert.equal(all.results.length, 2);
  const fromBia = await dono.request({ t: 'search', serverId: home, text: 'abacaxi', from: bia.me.id });
  assert.deepEqual(fromBia.results.map((m) => m.userId), [bia.me.id]);
  assert.equal((await dono.request({ t: 'search', serverId: home, text: '0%' })).results.length, 1);
  assert.equal((await dono.request({ t: 'search', serverId: home, text: 'x' })).t, 'error');
});

test('status: não perturbe e invisível; ausente automático', async () => {
  await bia.request({ t: 'presence:set', presence: 'dnd' });
  let ev = await dono.waitFor('presence', (e) => e.status[bia.me.id] === 'dnd');
  assert.ok(ev.online.includes(bia.me.id));
  await bia.request({ t: 'presence:set', presence: 'invisible' });
  ev = await dono.waitFor('presence', (e) => !e.online.includes(bia.me.id));
  await bia.request({ t: 'presence:set', presence: 'online' });
  bia.send({ t: 'presence:idle', idle: true });
  ev = await dono.waitFor('presence', (e) => e.status[bia.me.id] === 'idle');
  bia.send({ t: 'presence:idle', idle: false });
  ev = await dono.waitFor('presence', (e) => e.online.includes(bia.me.id) && !e.status[bia.me.id]);
  assert.equal((await bia.request({ t: 'presence:set', presence: 'dormindo' })).t, 'error');
  await bia.request({ t: 'status:text', text: '  jogando Tron  ' });
  await sleep(150);
  assert.equal(snap(dono).members.find((m) => m.id === bia.me.id).statusText, 'jogando Tron');
});

test('placar da semana: partida com 2 pessoas conta; aviso de sala aberta no chat', async () => {
  await dono.request({ t: 'server:welcome', serverId: home, on: true, gameAnnounce: true });
  const { room } = await dono.request({ t: 'game:create', game: 'velha' });
  const ann = await bia.waitFor('msg', (e) => e.msg.kind === 'game');
  assert.equal(ann.msg.meta.roomId, room.id);
  await bia.request({ t: 'game:join', roomId: room.id });
  await dono.request({ t: 'game:start', roomId: room.id });
  // Dono (X) faz a linha de cima; Bia joga embaixo
  for (const [p, cell] of [[dono, 0], [bia, 3], [dono, 1], [bia, 4], [dono, 2]]) {
    p.send({ t: 'game:input', roomId: room.id, cell });
    await sleep(120);
  }
  const lb = await dono.waitFor('games:leaderboard', (e) => e.week.length > 0, 3000);
  assert.deepEqual(lb.week.find((r) => r.userId === dono.me.id), { userId: dono.me.id, name: 'dono', wins: 1, played: 1 });
  assert.equal(lb.week.find((r) => r.userId === bia.me.id).wins, 0);
  const again = await bia.request({ t: 'games:leaderboard' });
  assert.equal(again.week.length, 2);
  await dono.request({ t: 'game:leave' });
  await bia.request({ t: 'game:leave' });
});

test('saúde e chave de notificação respondem', async () => {
  const health = await (await fetch(`${server.base}/health`)).json();
  assert.equal(health.ok, true);
  const key = await (await fetch(`${server.base}/api/push-key`)).json();
  assert.match(key.key, /^[A-Za-z0-9_-]{80,}$/);
  const bad = await bia.request({ t: 'push:subscribe', sub: { endpoint: 'http://inseguro', keys: {} } });
  assert.equal(bad.t, 'error');
  const ok = await bia.request({ t: 'push:subscribe', sub: { endpoint: 'https://push.example.com/abc123456789', keys: { p256dh: 'x'.repeat(80), auth: 'y'.repeat(20) } } });
  assert.equal(ok.t, 'ok');
});
