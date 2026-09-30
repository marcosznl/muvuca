// Canais privados, modo lento, filtro de palavras e eventos agendados
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { applyFilter, cleanFilter } from '../src/word-filter.js';
import { startServer, Person, sleep } from './helpers.js';

test('filtro: sem acento e sem maiúscula, "palavra*" pega o começo, menções ficam como estão', () => {
  const f = cleanFilter('Bobão\nidiot*\n  x \n', 'mask');
  assert.deepEqual(f, { words: ['bobao', 'idiot*'], mode: 'mask' });
  const r = applyFilter(f, 'Seu BOBAO, que idiotice <@u5>');
  assert.deepEqual(r.hits, ['bobao', 'idiotice']);
  assert.equal(r.text, 'Seu *****, que ******** <@u5>');
  assert.equal(applyFilter(f, 'tudo certo por aqui').hits.length, 0);
  assert.equal(cleanFilter('', 'block'), null);
});

let server;
let dono;
let ana;
let bia;
let home;
let geral;
before(async () => {
  server = await startServer();
  dono = await new Person(server, 'dono').register();
  ana = await new Person(server, 'ana').register();
  bia = await new Person(server, 'bia').register();
  home = dono.servers[0].id;
  geral = dono.servers[0].channels.find((c) => c.type === 'text').id;
});
after(async () => {
  for (const p of [dono, ana, bia]) p?.close();
  await server?.stop();
});

const snapOf = async (p) => {
  const res = await p.waitFor('server', (e) => e.server.id === home, 3000).catch(() => null);
  return res?.server ?? p.servers.find((s) => s.id === home);
};

test('canal privado: só o cargo escolhido vê, lê, escreve e recebe as mensagens', async () => {
  const staff = (await dono.request({ t: 'role:create', serverId: home, name: 'Staff' })).roleId;
  await dono.request({ t: 'member:roles', serverId: home, userId: ana.me.id, roleIds: [staff] });
  const secreto = (await dono.request({ t: 'channel:create', serverId: home, type: 'text', name: 'staff' })).channelId;
  for (const p of [ana, bia]) p.events = p.events.filter((e) => e.t !== 'server');
  assert.equal((await dono.request({ t: 'channel:privacy', channelId: secreto, private: true, roleIds: [staff] })).t, 'ok');

  // Espera o aviso do servidor já com o canal privado (avisos antigos podem chegar atrasados)
  const depois = (p, pred) => p.waitFor('server', (e) => e.server.id === home && pred(e.server), 3000).then(() => true).catch(() => false);
  assert.equal(await depois(ana, (sv) => sv.channels.some((c) => c.id === secreto && c.private)), true, 'quem tem o cargo vê');
  assert.equal(await depois(bia, (sv) => !sv.channels.some((c) => c.id === secreto)), true, 'quem não tem nem sabe que existe');

  assert.equal((await bia.request({ t: 'msg', channel: secreto, text: 'entrei?' })).t, 'error');
  assert.equal((await bia.request({ t: 'history', channel: secreto })).t, 'error');
  bia.events = [];
  await ana.say(secreto, 'papo da staff');
  await assert.rejects(bia.waitFor('msg', (e) => e.msg.channel === secreto, 500), /não chegou/, 'a mensagem não vaza');
  const busca = await bia.request({ t: 'search', serverId: home, text: 'papo da staff' });
  assert.equal(busca.results.length, 0, 'nem pela busca');
  assert.equal((await ana.request({ t: 'search', serverId: home, text: 'papo da staff' })).results.length, 1);

  // Voltou a ser público: a Bia passa a ver
  await dono.request({ t: 'channel:privacy', channelId: secreto, private: false });
  assert.equal(await depois(bia, (sv) => sv.channels.some((c) => c.id === secreto && !c.private)), true);
  assert.equal((await dono.request({ t: 'channel:privacy', channelId: secreto, private: true, roleIds: [] })).t, 'ok');
  assert.equal((await ana.request({ t: 'history', channel: secreto })).t, 'error', 'sem cargo nenhum: só dono e administradores');
  assert.equal((await dono.request({ t: 'history', channel: secreto })).t, 'history', 'o dono sempre vê');
});

test('modo lento: segura a segunda mensagem; quem gerencia mensagens não espera', async () => {
  const lento = (await dono.request({ t: 'channel:create', serverId: home, type: 'text', name: 'lento' })).channelId;
  assert.equal((await ana.request({ t: 'channel:slowmode', channelId: lento, seconds: 5 })).t, 'error', 'sem permissão');
  assert.equal((await dono.request({ t: 'channel:slowmode', channelId: lento, seconds: 7 })).t, 'error', 'só tempos da lista');
  assert.equal((await dono.request({ t: 'channel:slowmode', channelId: lento, seconds: 5 })).t, 'ok');
  await sleep(100);
  await bia.say(lento, 'primeira');
  const segunda = await bia.request({ t: 'msg', channel: lento, text: 'segunda' });
  assert.equal(segunda.t, 'error');
  assert.match(segunda.message, /Modo lento: espere \d s/);
  await dono.say(lento, 'dono 1');
  await dono.say(lento, 'dono 2'); // o dono não espera
});

test('filtro de palavras: bloqueia ou esconde; a lista só vai para quem gerencia o servidor', async () => {
  assert.equal((await bia.request({ t: 'server:filter', serverId: home, words: 'feio', mode: 'block' })).t, 'error');
  bia.events = bia.events.filter((e) => e.t !== 'server');
  dono.events = dono.events.filter((e) => e.t !== 'server');
  assert.equal((await dono.request({ t: 'server:filter', serverId: home, words: 'feio\nchat*', mode: 'block' })).t, 'ok');
  assert.deepEqual((await snapOf(dono)).filter, { words: ['feio', 'chat*'], mode: 'block' });
  assert.equal((await snapOf(bia)).filter, undefined, 'quem não gerencia não vê a lista');

  const r = await bia.request({ t: 'msg', channel: geral, text: 'que FEIO isso' });
  assert.match(r.message, /palavra bloqueada/);
  await dono.request({ t: 'server:filter', serverId: home, words: 'feio', mode: 'mask' });
  await sleep(100);
  assert.equal((await bia.request({ t: 'msg', channel: geral, text: 'muito feio mesmo' })).t, 'ok');
  const ev = (await bia.waitFor('msg', (e) => e.msg.text.includes('****'))).msg;
  assert.equal(ev.text, 'muito **** mesmo');
  await dono.say(geral, 'o dono pode falar feio'); // quem gerencia o servidor fica de fora
  await dono.request({ t: 'server:filter', serverId: home, words: '' });
});

test('eventos: marcar (com permissão), "Vou", apagar; o aviso aparece no chat', async () => {
  const daqui = Date.now() + 2 * 3_600_000;
  assert.match((await bia.request({ t: 'event:create', serverId: home, title: 'Festa', startsAt: daqui })).message, /permissão para marcar/);
  assert.match((await dono.request({ t: 'event:create', serverId: home, title: 'Passado', startsAt: Date.now() - 1000 })).message, /futuro/);
  bia.events = bia.events.filter((e) => e.t !== 'server' && e.t !== 'msg');
  const { id } = await dono.request({ t: 'event:create', serverId: home, title: 'Jogatina', description: 'Bomberman', startsAt: daqui });
  assert.ok(id);
  const aviso = await bia.waitFor('msg', (e) => e.msg.system && e.msg.kind === 'event');
  assert.equal(aviso.msg.meta.eventId, id);
  let ev = (await snapOf(bia)).events.find((e) => e.id === id);
  assert.deepEqual(ev.going, [dono.me.id], 'quem marca já vai');

  bia.events = bia.events.filter((e) => e.t !== 'server');
  assert.equal((await bia.request({ t: 'event:rsvp', eventId: id, going: true })).t, 'ok');
  ev = (await snapOf(bia)).events.find((e) => e.id === id);
  assert.deepEqual(ev.going, [dono.me.id, bia.me.id]);

  assert.equal((await bia.request({ t: 'event:delete', eventId: id })).t, 'error', 'só quem marcou ou quem gerencia');
  bia.events = bia.events.filter((e) => e.t !== 'server');
  assert.equal((await dono.request({ t: 'event:delete', eventId: id })).t, 'ok');
  assert.equal((await snapOf(bia)).events.some((e) => e.id === id), false);
});

test('@todos e @cargo: só com a permissão; contam como menção para quem foi incluído', async () => {
  const geralId = geral;
  // Sem a permissão: vira texto comum (não avisa ninguém)
  assert.equal((await bia.request({ t: 'msg', channel: geralId, text: 'oi <@todos>' })).t, 'ok');
  const semPerm = await bia.waitFor('msg', (e) => e.msg.userId === bia.me.id && e.msg.text.includes('todos'));
  assert.equal(semPerm?.msg.text, 'oi @todos');

  // O dono pode: @todos e um cargo
  const cargo = (await dono.request({ t: 'role:create', serverId: home, name: 'Jogadores' })).roleId;
  await dono.request({ t: 'member:roles', serverId: home, userId: ana.me.id, roleIds: [cargo] });
  await dono.say(geralId, 'bora <@todos>');
  await dono.say(geralId, `partida agora <@&${cargo}>`);

  // Contagem de menções não lidas (quem entra de novo vê o número vermelho)
  const unread = async (p) => {
    const outra = new Person(server, p.username);
    outra.token = p.token;
    await outra.connect();
    const u = outra.welcome.unread[geralId];
    outra.close();
    return u?.mentions ?? 0;
  };
  assert.ok(await unread(ana) >= 2, 'a Ana tem o cargo: @todos e @Jogadores contam');
  assert.equal(await unread(bia) >= 1, true, 'a Bia recebe o @todos');
});
