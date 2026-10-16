// Testes dos recursos "sociais": reações, não lidas, digitando, busca, avisos de entrada/saída,
// status, placar dos jogos e a checagem de saúde. Servidor próprio (roda junto com os outros testes).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, Person, sleep, WEBM } from './helpers.js';

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
  const { room } = await dono.request({ t: 'game:create', game: 'bomberman' });
  const ann = await bia.waitFor('msg', (e) => e.msg.kind === 'game');
  assert.equal(ann.msg.meta.roomId, room.id);
  await bia.request({ t: 'game:join', roomId: room.id });
  await dono.request({ t: 'game:start', roomId: room.id });
  // Bia sai no meio da partida: conta como eliminada e o dono vence
  await dono.waitFor('game:state', (e) => e.roomId === room.id);
  await bia.request({ t: 'game:leave' });
  const lb = await dono.waitFor('games:leaderboard', (e) => e.week.length > 0, 3000);
  assert.deepEqual(lb.week.find((r) => r.userId === dono.me.id), { userId: dono.me.id, name: 'dono', wins: 1, played: 1 });
  assert.equal(lb.week.find((r) => r.userId === bia.me.id).wins, 0);
  const again = await bia.request({ t: 'games:leaderboard' });
  assert.equal(again.week.length, 2);
  await dono.request({ t: 'game:leave' });
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

test('convites: limite de usos, cancelar, e só quem pode vê a lista', async () => {
  const one = await dono.request({ t: 'invite:create', serverId: home, maxUses: 1, expiresIn: 3_600_000 });
  assert.equal(one.maxUses, 1);
  const eva = new Person(server, 'eva');
  assert.equal((await eva.post('/api/register', { username: 'eva', password: 'senha-123', invite: one.code })).status, 200);
  const fabio = new Person(server, 'fabio');
  assert.notEqual((await fabio.post('/api/register', { username: 'fabio', password: 'senha-123', invite: one.code })).status, 200); // já usado
  const other = await dono.request({ t: 'invite:create', serverId: home });
  let list = await dono.request({ t: 'invites:list', serverId: home });
  assert.ok(list.invites.some((i) => i.code === other.code && i.expiresAt > Date.now()));
  assert.ok(!list.invites.some((i) => i.code === one.code)); // esgotado não aparece
  assert.equal((await bia.request({ t: 'invite:revoke', code: other.code })).t, 'error'); // não é dela
  await dono.request({ t: 'invite:revoke', code: other.code });
  list = await dono.request({ t: 'invites:list', serverId: home });
  assert.ok(!list.invites.some((i) => i.code === other.code));
  assert.notEqual((await fabio.post('/api/register', { username: 'fabio', password: 'senha-123', invite: other.code })).status, 200);
});

test('mensagem direta: abre, reaproveita, é privada e ninguém administra', async () => {
  await dono.request({ t: 'dm:open', userIds: [bia.me.id] });
  const opened = await dono.waitFor('server', (e) => e.server.kind === 'dm' && e.select);
  const dm = opened.server;
  assert.equal(dm.members.length, 2);
  assert.equal(dm.ownerId, null);
  await bia.waitFor('server', (e) => e.server.id === dm.id); // a Bia já vê a conversa
  await dono.request({ t: 'dm:open', userIds: [bia.me.id] });
  const again = await dono.waitFor('server', (e) => e.server.kind === 'dm' && e.select);
  assert.equal(again.server.id, dm.id); // mesma conversa, não cria outra
  const ch = dm.channels[0].id;
  await dono.say(ch, 'oi só pra você');
  await bia.waitFor('msg', (e) => e.msg.channel === ch);
  assert.equal((await dono.request({ t: 'invite:create', serverId: dm.id })).t, 'error');
  assert.equal((await dono.request({ t: 'channel:create', serverId: dm.id, name: 'x' })).t, 'error');
  assert.equal((await bia.request({ t: 'server:leave', serverId: dm.id })).t, 'error'); // 1:1 não dá para sair
  // Quem não está num servidor em comum não recebe conversa
  const alguem = await new Person(server, 'estranho').register(); // entra no principal: aí tem servidor em comum
  await alguem.request({ t: 'server:leave', serverId: home });
  assert.equal((await dono.request({ t: 'dm:open', userIds: [alguem.me.id] })).t, 'error');
  alguem.close();
});

test('tópico do canal e silenciar', async () => {
  const ch = geral(dono);
  assert.equal((await bia.request({ t: 'channel:topic', channelId: ch, topic: 'x' })).t, 'error');
  await dono.request({ t: 'channel:topic', channelId: ch, topic: '  Papo geral da galera  ' });
  await sleep(100);
  assert.equal(snap(dono).channels.find((c) => c.id === ch).topic, 'Papo geral da galera');
  await bia.request({ t: 'mute:set', target: ch, muted: true });
  let ev = await bia.waitFor('mutes');
  assert.deepEqual(ev.mutes, [ch]);
  await bia.request({ t: 'mute:set', target: ch, muted: false });
  ev = await bia.waitFor('mutes');
  assert.deepEqual(ev.mutes, []);
  assert.equal((await bia.request({ t: 'mute:set', target: 'canal-que-nao-existe', muted: true })).t, 'error');
});

test('enquete: cria, vota (única e múltipla), mostra no histórico e encerra', async () => {
  const ch = geral(dono);
  assert.equal((await dono.request({ t: 'poll:create', channel: ch, question: 'Pizza?', options: ['só uma'] })).t, 'error');
  await dono.request({ t: 'poll:create', channel: ch, question: 'Que horas jogar?', options: ['20h', '21h', '22h'] });
  const poll = (await bia.waitFor('msg', (e) => e.msg.meta?.poll)).msg;
  assert.deepEqual(poll.meta.poll.options, ['20h', '21h', '22h']);
  await bia.request({ t: 'poll:vote', id: poll.id, option: 0 });
  await bia.request({ t: 'poll:vote', id: poll.id, option: 2 }); // escolha única: troca
  let ev = await dono.waitFor('msg:poll', (e) => e.id === poll.id && e.votes.some((v) => v.option === 2));
  assert.deepEqual(ev.votes, [{ option: 2, users: [bia.me.id] }]);
  assert.equal((await bia.request({ t: 'poll:vote', id: poll.id, option: 7 })).t, 'error');
  assert.equal((await bia.request({ t: 'poll:close', id: poll.id })).t, 'error'); // não foi ela que criou
  assert.equal((await dono.request({ t: 'msg:edit', id: poll.id, text: 'x' })).t, 'error');
  const hist = await bia.request({ t: 'history', channel: ch });
  assert.deepEqual(hist.messages.find((m) => m.id === poll.id).votes, [{ option: 2, users: [bia.me.id] }]);
  await dono.request({ t: 'poll:close', id: poll.id });
  ev = await bia.waitFor('msg:edit', (e) => e.msg.id === poll.id);
  assert.equal(ev.msg.meta.poll.closed, true);
  assert.equal((await bia.request({ t: 'poll:vote', id: poll.id, option: 1 })).t, 'error');
  // Várias respostas
  await dono.request({ t: 'poll:create', channel: ch, question: 'Jogos?', options: ['Tron', 'Agar'], multi: true });
  const multi = (await bia.waitFor('msg', (e) => e.msg.meta?.poll?.multi)).msg;
  await bia.request({ t: 'poll:vote', id: multi.id, option: 0 });
  await bia.request({ t: 'poll:vote', id: multi.id, option: 1 });
  ev = await dono.waitFor('msg:poll', (e) => e.id === multi.id && e.votes.length === 2);
  assert.equal(ev.votes.length, 2);
});

test('mensagem de voz: sobe como áudio com a duração', async () => {
  const ch = geral(dono);
  const up = await bia.upload('/api/attach', { channel: ch, voice: 1, dur: 7 }, WEBM);
  assert.equal(up.status, 200);
  assert.equal(up.body.kind, 'audio');
  assert.equal(up.body.mime, 'audio/webm');
  assert.equal(up.body.width, 7);
  const bad = await bia.upload('/api/attach', { channel: ch, voice: 1, dur: 3 }, Buffer.from('não é áudio'));
  assert.equal(bad.status, 400);
});

test('prévia de link: recusa endereço interno e link inválido', async () => {
  const local = await bia.request({ t: 'link:preview', url: `${server.base}/health` });
  assert.equal(local.preview, null);
  const router = await bia.request({ t: 'link:preview', url: 'http://192.168.1.1/' });
  assert.equal(router.preview, null);
  assert.equal((await bia.request({ t: 'link:preview', url: 'file:///etc/passwd' })).t, 'error');
});

test('jogos de festa: chat da sala, "Jogando…", palpite escondido e mínimo de pessoas', async () => {
  const { room } = await dono.request({ t: 'game:create', game: 'desenho' });
  assert.match((await dono.request({ t: 'game:start', roomId: room.id })).message, /pelo menos 2/);
  await dono.request({ t: 'game:leave' });

  const { room: r2 } = await dono.request({ t: 'game:create', game: 'desenho' });
  const pres = await bia.waitFor('presence', (e) => e.activity?.[dono.me.id]?.game === 'desenho');
  assert.equal(pres.activity[dono.me.id].name, 'Desenha aí');
  await bia.request({ t: 'game:join', roomId: r2.id });
  await bia.waitFor('game:chatlog', (e) => e.roomId === r2.id);
  await bia.request({ t: 'game:chat', roomId: r2.id, text: 'bora!' });
  await dono.waitFor('game:chat', (e) => e.line.text === 'bora!' && e.line.userId === bia.me.id);
  await dono.request({ t: 'game:start', roomId: r2.id });
  // Quem desenha escolhe; o outro chuta a palavra certa: some do chat e vira aviso de acerto
  const s1 = await dono.waitFor('game:state', (e) => e.roomId === r2.id && e.state.phase === 'choose');
  const drawer = s1.state.drawer === dono.me.id ? dono : bia;
  const guesser = drawer === dono ? bia : dono;
  const mine = drawer === dono ? s1 : await bia.waitFor('game:state', (e) => e.roomId === r2.id && e.state.choices);
  drawer.send({ t: 'game:input', roomId: r2.id, cell: 0 });
  await guesser.waitFor('game:state', (e) => e.roomId === r2.id && e.state.phase === 'draw');
  drawer.send({ t: 'game:input', roomId: r2.id, stroke: { c: 0, w: 1, p: [[1, 1], [900, 900]] } });
  await guesser.waitFor('game:events', (e) => e.events.some((ev) => ev.type === 'stroke'));
  const sync = await guesser.request({ t: 'game:sync', roomId: r2.id });
  assert.equal(sync.data.strokes.length, 1);
  await guesser.request({ t: 'game:chat', roomId: r2.id, text: mine.state.choices[0].word });
  await drawer.waitFor('game:chat', (e) => /acertou/.test(e.line.text));
  assert.ok(!drawer.events.some((e) => e.t === 'game:chat' && e.line.text === mine.state.choices[0].word));
  await dono.request({ t: 'game:leave' });
  await bia.request({ t: 'game:leave' });
  const stats = await bia.request({ t: 'games:stats', userId: dono.me.id });
  assert.ok(Array.isArray(stats.byGame) && Array.isArray(stats.achievements));
  assert.ok(stats.achievements.some((a) => a.id === 'primeira'));
});
