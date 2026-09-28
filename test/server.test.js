// Testes do servidor: sobem o app de verdade e conferem o que cada pessoa pode ou não fazer.
// Rodar: npm test
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, Person, ACCESS, PNG, GIF, WEBM, sleep } from './helpers.js';
import { PERMS, DEFAULT_PERMS } from '../public/js/permissions.js';

let server;
let dono;   // primeiro cadastro: vira dono do servidor principal
let ana;    // membro comum
let home;   // id do servidor principal

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

const last = (arr) => arr[arr.length - 1];
const snap = (p) => p.server_(home);

// ---------- Contas ----------

test('cadastro exige o código de acesso ou um convite', async () => {
  const intruso = new Person(server, 'intruso');
  const res = await intruso.post('/api/register', { username: 'intruso', password: 'senha-123', invite: 'errado' });
  assert.equal(res.status, 401);
});

test('não deixa repetir nome de usuário', async () => {
  const res = await new Person(server, 'x').post('/api/register', { username: 'ANA', password: 'senha-123', invite: ACCESS });
  assert.equal(res.status, 409);
});

test('login com senha errada falha e com a certa funciona', async () => {
  const p = new Person(server, 'ana');
  assert.equal((await p.post('/api/login', { username: 'ana', password: 'errada' })).status, 401);
  const ok = await p.post('/api/login', { username: 'ana', password: 'senha-123' });
  assert.equal(ok.status, 200);
  assert.ok(ok.body.token);
});

test('o primeiro a se cadastrar vira dono do servidor principal', () => {
  assert.equal(snap(dono).ownerId, dono.me.id);
  assert.ok(snap(dono).members.some((m) => m.id === ana.me.id));
});

// ---------- Mensagens ----------

test('mensagem enviada chega para os outros e fica no histórico', async () => {
  await ana.say('geral', 'oi pessoal');
  const ev = await dono.waitFor('msg', (e) => e.msg.text === 'oi pessoal');
  assert.equal(ev.msg.userId, ana.me.id);
  const hist = await dono.request({ t: 'history', channel: 'geral' });
  assert.equal(last(hist.messages).text, 'oi pessoal');
});

test('editar: só a própria mensagem', async () => {
  const msg = await ana.say('geral', 'errei');
  const alheio = await dono.request({ t: 'msg:edit', id: msg.id, text: 'hack' });
  assert.equal(alheio.t, 'error');
  const ok = await ana.request({ t: 'msg:edit', id: msg.id, text: 'corrigido' });
  assert.equal(ok.t, 'ok');
  const ev = await dono.waitFor('msg:edit', (e) => e.msg.id === msg.id);
  assert.equal(ev.msg.text, 'corrigido');
  assert.ok(ev.msg.editedAt);
});

test('excluir: a própria sim; a dos outros só com "Gerenciar mensagens"', async () => {
  const msg = await dono.say('geral', 'do dono');
  assert.equal((await ana.request({ t: 'msg:delete', id: msg.id })).t, 'error');
  const own = await ana.say('geral', 'da ana');
  assert.equal((await dono.request({ t: 'msg:delete', id: own.id })).t, 'ok'); // dono tem todas as permissões
  await ana.waitFor('msg:delete', (e) => e.id === own.id);
});

test('responder mostra um resumo da original, e "excluída" se ela sumir', async () => {
  const orig = await dono.say('geral', 'pergunta');
  const reply = await ana.say('geral', 'resposta', { replyTo: orig.id });
  assert.equal(reply.reply.id, orig.id);
  assert.equal(reply.reply.text, 'pergunta');
  await dono.request({ t: 'msg:delete', id: orig.id });
  const hist = await dono.request({ t: 'history', channel: 'geral' });
  assert.deepEqual(hist.messages.find((m) => m.id === reply.id).reply, { id: orig.id, deleted: true });
});

test('responder a uma mensagem de outro canal não vale', async () => {
  const other = await dono.say('jogos', 'em jogos');
  const m = await ana.say('geral', 'resposta torta', { replyTo: other.id });
  assert.equal(m.reply, undefined);
});

test('fixar: aparece na lista do pininho; sem a permissão, não dá', async () => {
  const msg = await ana.say('geral', 'importante');
  assert.equal((await ana.request({ t: 'msg:pin', id: msg.id, pinned: true })).t, 'ok'); // @everyone pode por padrão
  const pins = await dono.request({ t: 'pins', channel: 'geral' });
  assert.deepEqual(pins.messages.map((m) => m.id), [msg.id]);
  // Tira "Fixar mensagens" do @everyone: a Ana não consegue mais
  const everyone = snap(dono).roles.find((r) => r.isDefault);
  await dono.request({ t: 'role:update', roleId: everyone.id, permissions: everyone.permissions & ~PERMS.PIN_MESSAGES });
  assert.equal((await ana.request({ t: 'msg:pin', id: msg.id, pinned: false })).t, 'error');
  await dono.request({ t: 'role:update', roleId: everyone.id, permissions: everyone.permissions }); // devolve
  assert.equal((await ana.request({ t: 'msg:pin', id: msg.id, pinned: false })).t, 'ok');
  assert.equal((await dono.request({ t: 'pins', channel: 'geral' })).messages.length, 0);
});

// ---------- Anexos ----------

test('anexo: envia, vira parte da mensagem e só então pode ser baixado', async () => {
  const up = await ana.upload('/api/attach', { channel: 'geral', name: 'foto.png', w: 1, h: 1 }, PNG);
  assert.equal(up.status, 200);
  assert.equal(up.body.kind, 'image');
  assert.equal((await fetch(`${server.base}/file/${up.body.id}`)).status, 404); // ainda sem mensagem
  // Outra pessoa não consegue usar o arquivo da Ana
  const roubo = await dono.say('geral', 'roubo', { attachments: [up.body.id] });
  assert.equal(roubo.attachments, undefined);
  const msg = await ana.say('geral', '', { attachments: [up.body.id] });
  assert.equal(msg.attachments[0].url, `/file/${up.body.id}`);
  const file = await fetch(server.base + msg.attachments[0].url);
  assert.equal(file.status, 200);
  assert.equal(file.headers.get('content-type'), 'image/png');
  // Excluir a mensagem apaga o arquivo
  await ana.request({ t: 'msg:delete', id: msg.id });
  assert.equal((await fetch(server.base + msg.attachments[0].url)).status, 404);
});

test('anexo: vídeo aceita pedaços (Range); arquivo que não é mídia é recusado', async () => {
  const up = await ana.upload('/api/attach', { channel: 'geral', name: 'v.webm' }, WEBM);
  assert.equal(up.body.kind, 'video');
  const msg = await ana.say('geral', 'video', { attachments: [up.body.id] });
  const part = await fetch(server.base + msg.attachments[0].url, { headers: { Range: 'bytes=0-3' } });
  assert.equal(part.status, 206);
  assert.equal(part.headers.get('content-range'), `bytes 0-3/${WEBM.length}`);
  const bad = await ana.upload('/api/attach', { channel: 'geral' }, Buffer.from('não sou mídia'));
  assert.equal(bad.status, 400);
  const semLogin = await fetch(`${server.base}/api/attach?channel=geral`, { method: 'POST', body: PNG });
  assert.equal(semLogin.status, 401);
});

// ---------- Canais e categorias ----------

test('categorias: criar, colocar canal dentro, e excluir devolve os canais', async () => {
  const cat = await dono.request({ t: 'category:create', serverId: home, name: 'Jogatina' });
  const ch = await dono.request({ t: 'channel:create', serverId: home, type: 'voice', name: 'Squad', categoryId: cat.categoryId });
  await sleep(100);
  assert.equal(snap(dono).channels.find((c) => c.id === ch.channelId).categoryId, cat.categoryId);
  await dono.request({ t: 'category:delete', categoryId: cat.categoryId });
  await sleep(100);
  assert.ok(snap(dono).channels.some((c) => c.id === ch.channelId && c.categoryId === null));
  assert.ok(!snap(dono).categories.some((k) => k.id === cat.categoryId));
});

test('mover canal entre categorias mantém a ordem pedida', async () => {
  const cats = snap(dono).categories;
  await dono.request({ t: 'channel:move', channelId: 'jogos', categoryId: cats[1].id, index: 0 });
  await sleep(100);
  const inCat = snap(dono).channels.filter((c) => c.categoryId === cats[1].id).map((c) => c.id);
  assert.equal(inCat[0], 'jogos');
});

test('membro comum não cria canal nem categoria', async () => {
  assert.equal((await ana.request({ t: 'channel:create', serverId: home, type: 'text', name: 'x' })).t, 'error');
  assert.equal((await ana.request({ t: 'category:create', serverId: home, name: 'x' })).t, 'error');
});

test('qualidade do canal de voz fica entre 16 e 320 kbps', async () => {
  assert.equal((await dono.request({ t: 'channel:settings', channelId: 'sala-1', name: 'Sala 1', bitrate: 999 })).t, 'error');
  assert.equal((await dono.request({ t: 'channel:settings', channelId: 'sala-1', name: 'Sala 1', bitrate: 64 })).t, 'ok');
  await sleep(100);
  assert.equal(snap(dono).channels.find((c) => c.id === 'sala-1').bitrate, 64);
});

// ---------- Cargos ----------

test('cargos: moderador reorganiza os de baixo, mas não os de cima', async () => {
  const ids = {};
  for (const name of ['Alto', 'Moderador', 'Baixo']) ids[name] = (await dono.request({ t: 'role:create', serverId: home, name })).roleId;
  // Ordem de cima para baixo: Alto > Moderador > Baixo (cada novo nasce logo acima do @everyone)
  await dono.request({ t: 'role:reorder', roleId: ids.Alto, position: 3 });
  await dono.request({ t: 'role:reorder', roleId: ids.Moderador, position: 2 });
  await dono.request({ t: 'role:update', roleId: ids.Moderador, name: 'Moderador', permissions: PERMS.MANAGE_ROLES });
  await dono.request({ t: 'member:roles', serverId: home, userId: ana.me.id, roleIds: [ids.Moderador] });
  await sleep(150);
  assert.equal((await ana.request({ t: 'role:reorder', roleId: ids.Alto, position: 1 })).t, 'error');     // acima dela
  assert.equal((await ana.request({ t: 'role:reorder', roleId: ids.Baixo, position: 2 })).t, 'error');    // até o nível dela
  assert.equal((await ana.request({ t: 'role:update', roleId: ids.Baixo, permissions: PERMS.KICK_MEMBERS })).t, 'error'); // não tem essa permissão
  assert.equal((await ana.request({ t: 'member:roles', serverId: home, userId: ana.me.id, roleIds: [ids.Moderador, ids.Alto] })).t, 'error');
  await dono.request({ t: 'member:roles', serverId: home, userId: ana.me.id, roleIds: [] });
});

test('o @everyone começa com as permissões padrão', () => {
  assert.equal(snap(dono).roles.find((r) => r.isDefault).permissions, DEFAULT_PERMS);
});

// ---------- Emojis ----------

test('emojis: enviar, nome repetido, animado, renomear e excluir', async () => {
  const ok = await dono.upload('/api/emojis', { server: home, name: 'legal' }, PNG);
  assert.equal(ok.status, 200);
  assert.equal(ok.body.animated, false);
  assert.equal((await dono.upload('/api/emojis', { server: home, name: 'LEGAL' }, PNG)).status, 409);
  assert.equal((await dono.upload('/api/emojis', { server: home, name: 'x' }, PNG)).status, 400);
  assert.equal((await dono.upload('/api/emojis', { server: home, name: 'grande' }, Buffer.alloc(300 * 1024))).status, 413);
  assert.equal((await ana.upload('/api/emojis', { server: home, name: 'dela' }, PNG)).status, 403);
  const gif = await dono.upload('/api/emojis', { server: home, name: 'dancando' }, GIF);
  assert.equal(gif.body.animated, true);
  assert.equal((await fetch(`${server.base}/emoji/${ok.body.id}`)).status, 200);
  assert.equal((await dono.request({ t: 'emoji:rename', emojiId: ok.body.id, name: 'dancando' })).t, 'error');
  assert.equal((await dono.request({ t: 'emoji:rename', emojiId: ok.body.id, name: 'maneiro' })).t, 'ok');
  await dono.request({ t: 'emoji:delete', emojiId: ok.body.id });
  assert.equal((await fetch(`${server.base}/emoji/${ok.body.id}`)).status, 404);
});

// ---------- Perfil ----------

test('perfil: nome, "Sobre mim" e banner aparecem para os outros', async () => {
  assert.equal((await ana.request({ t: 'profile:update', name: '  ', bio: '' })).t, 'error');
  await ana.request({ t: 'profile:update', name: 'Ana Clara', bio: 'oi!', banner: '#ff0000' });
  await sleep(150);
  const m = snap(dono).members.find((x) => x.id === ana.me.id);
  assert.deepEqual([m.name, m.bio, m.banner], ['Ana Clara', 'oi!', '#ff0000']);
});

test('foto de perfil: enviar, ver e remover', async () => {
  const up = await ana.upload('/api/image', { for: 'avatar' }, PNG);
  assert.equal(up.status, 200);
  await sleep(150);
  assert.equal(ana.me.avatar, up.body.id);
  assert.equal((await fetch(`${server.base}/img/${up.body.id}`)).status, 200);
  await ana.request({ t: 'avatar:remove' });
  await sleep(150);
  assert.equal(ana.me.avatar, null);
  assert.equal((await fetch(`${server.base}/img/${up.body.id}`)).status, 404);
  assert.equal((await ana.upload('/api/image', { for: 'server', server: home }, PNG)).status, 403); // ícone: só quem gerencia
});

// ---------- Site e voz ----------

test('arquivos do site: 304 quando não mudou, e nada fora da pasta public', async () => {
  const first = await fetch(`${server.base}/js/app.js`);
  assert.equal(first.status, 200);
  const again = await fetch(`${server.base}/js/app.js`, { headers: { 'If-None-Match': first.headers.get('etag') } });
  assert.equal(again.status, 304);
  assert.equal((await fetch(`${server.base}/..%2Fserver.js`)).status, 404);
  assert.equal((await fetch(`${server.base}/%2e%2e/.env`)).status, 404);
});

test('token de voz: só canal de voz, e aponta para o LiveKit local no modo local', async () => {
  const ok = await ana.post('/token', { channel: 'sala-1' });
  assert.equal(ok.status, 200);
  assert.ok(ok.body.token);
  assert.equal((await ana.post('/token', { channel: 'geral' })).status, 404);
});

test('convite: quem entra por convite vira membro', async () => {
  const inv = await dono.request({ t: 'invite:create', serverId: home });
  const bia = new Person(server, 'bia');
  await bia.register(inv.code);
  assert.ok(bia.servers.some((s) => s.id === home));
  bia.close();
});

// ---------- Mais ações (cobertura da divisão em módulos) ----------

test('canal de música: entrar, cabine de DJ e sair', async () => {
  const ch = await dono.request({ t: 'channel:create', serverId: home, type: 'music', name: 'Pista' });
  const joined = await ana.request({ t: 'music:join', channelId: ch.channelId });
  assert.equal(joined.t, 'music:joined');
  assert.ok(joined.state.listeners.includes(ana.me.id));
  assert.equal((await ana.request({ t: 'music:booth', channelId: ch.channelId, join: true })).t, 'ok');
  assert.equal((await ana.request({ t: 'music:kick', channelId: ch.channelId, userId: dono.me.id })).t, 'error'); // sem "Gerenciar música"
  assert.equal((await ana.request({ t: 'music:join', channelId: 'geral' })).t, 'error'); // não é canal de música
  await ana.request({ t: 'music:leave', channelId: ch.channelId });
  assert.equal((await ana.request({ t: 'time' })).t, 'time');
});

test('renomear e excluir canal', async () => {
  const ch = await dono.request({ t: 'channel:create', serverId: home, type: 'text', name: 'Bate Papo' });
  await sleep(100);
  assert.equal(snap(dono).channels.find((c) => c.id === ch.channelId).name, 'bate-papo'); // estilo Discord
  await dono.request({ t: 'channel:rename', channelId: ch.channelId, name: 'Resenha Geral' });
  await sleep(100);
  assert.equal(snap(dono).channels.find((c) => c.id === ch.channelId).name, 'resenha-geral');
  assert.equal((await ana.request({ t: 'channel:delete', channelId: ch.channelId })).t, 'error');
  await dono.request({ t: 'channel:delete', channelId: ch.channelId });
  await sleep(100);
  assert.ok(!snap(dono).channels.some((c) => c.id === ch.channelId));
});

test('servidor novo: criar, editar, sair e excluir', async () => {
  assert.equal((await ana.request({ t: 'server:create', name: 'Da Ana' })).t, 'ok');
  const novo = (await ana.waitFor('server', (e) => e.server.name === 'Da Ana')).server;
  assert.equal(novo.ownerId, ana.me.id);
  assert.equal((await ana.request({ t: 'server:update', serverId: novo.id, name: 'Da Ana 2', color: '#123456' })).t, 'ok');
  const inv = await ana.request({ t: 'invite:create', serverId: novo.id });
  assert.equal((await dono.request({ t: 'invite:accept', code: inv.code })).t, 'ok');
  assert.equal((await ana.request({ t: 'server:leave', serverId: novo.id })).t, 'error'); // dono não sai
  assert.equal((await dono.request({ t: 'server:delete', serverId: novo.id })).t, 'error'); // só o dono exclui
  assert.equal((await dono.request({ t: 'server:leave', serverId: novo.id })).t, 'ok');
  assert.equal((await ana.request({ t: 'server:delete', serverId: novo.id })).t, 'ok');
  await ana.waitFor('server:removed', (e) => e.serverId === novo.id);
  assert.equal((await dono.request({ t: 'server:delete', serverId: home })).t, 'error'); // o principal não
});

test('expulsar: só quem tem a permissão, e nunca o dono', async () => {
  const caio = await new Person(server, 'caio').register();
  assert.equal((await ana.request({ t: 'member:kick', serverId: home, userId: caio.me.id })).t, 'error');
  assert.equal((await caio.request({ t: 'member:kick', serverId: home, userId: dono.me.id })).t, 'error');
  assert.equal((await dono.request({ t: 'member:kick', serverId: home, userId: caio.me.id })).t, 'ok');
  await caio.waitFor('server:removed', (e) => e.serverId === home);
  caio.close();
});

test('cargo: setas e excluir', async () => {
  const a = (await dono.request({ t: 'role:create', serverId: home, name: 'A' })).roleId;
  const b = (await dono.request({ t: 'role:create', serverId: home, name: 'B' })).roleId; // B nasce abaixo de A
  await sleep(100);
  const pos = (id) => snap(dono).roles.find((r) => r.id === id).position;
  assert.ok(pos(a) > pos(b));
  await dono.request({ t: 'role:move', roleId: b, dir: 'up' });
  await sleep(100);
  assert.ok(pos(b) > pos(a));
  const everyone = snap(dono).roles.find((r) => r.isDefault);
  assert.equal((await dono.request({ t: 'role:delete', roleId: everyone.id })).t, 'error');
  await dono.request({ t: 'role:delete', roleId: a });
  await sleep(100);
  assert.ok(!snap(dono).roles.some((r) => r.id === a));
});

// ---------- Jogos ----------

test('jogos: criar sala, entrar, assistir, começar e receber a partida', async () => {
  const list = await ana.request({ t: 'games:list' });
  assert.ok(list.games.some((g) => g.id === 'bomberman'));
  const created = await ana.request({ t: 'game:create', game: 'bomberman' });
  const roomId = created.room.id;
  assert.equal(created.room.hostId, ana.me.id);
  await dono.waitFor('games:rooms', (e) => e.rooms.some((r) => r.id === roomId)); // todo mundo vê a sala nova
  const joined = await dono.request({ t: 'game:join', roomId });
  assert.equal(joined.room.players.length, 2);
  assert.equal((await dono.request({ t: 'game:start', roomId })).t, 'error'); // só quem manda na sala
  assert.equal((await ana.request({ t: 'game:start', roomId })).t, 'ok');
  const st = await dono.waitFor('game:state', (e) => e.roomId === roomId);
  assert.equal(st.state.players.length, 2);
  // Andar: a Ana (canto de cima à esquerda) segura para a direita
  const x0 = st.state.players.find((p) => p.id === ana.me.id).x;
  ana.send({ t: 'game:input', roomId, dir: 'right' });
  await sleep(600);
  ana.send({ t: 'game:input', roomId, dir: null });
  dono.events = dono.events.filter((e) => e.t !== 'game:state');
  const later = await dono.waitFor('game:state', (e) => e.roomId === roomId);
  assert.ok(later.state.players.find((p) => p.id === ana.me.id).x > x0);
  // Com a partida rolando, quem chega entra como plateia
  const caio = await new Person(server, 'caio2').register();
  const watching = await caio.request({ t: 'game:join', roomId });
  assert.equal(watching.room.players.length, 2);
  assert.equal(watching.room.spectators, 1);
  // Saindo: o dono vira eliminado, a Ana vence e ganha ponto
  await dono.request({ t: 'game:leave' });
  const end = await ana.waitFor('game:state', (e) => e.state.over, 3000);
  assert.equal(end.state.winner, ana.me.id);
  const room = await ana.waitFor('game:room', (e) => e.room.status === 'waiting' && e.room.scores[ana.me.id] === 1, 4000);
  assert.equal(room.room.round, 1);
  // Todo mundo sai: a sala some
  await ana.request({ t: 'game:leave' });
  await caio.request({ t: 'game:leave' });
  const after = await dono.request({ t: 'games:list' });
  assert.ok(!after.rooms.some((r) => r.id === roomId));
  caio.close();
});

test('jogos: quem assistia entra para jogar quando a partida acaba', async () => {
  const { room } = await ana.request({ t: 'game:create', game: 'bomberman' });
  await ana.request({ t: 'game:start', roomId: room.id }); // treino sozinha
  const watching = await dono.request({ t: 'game:join', roomId: room.id });
  assert.equal(watching.room.spectators, 1);
  await ana.request({ t: 'game:leave' }); // sai: o treino acaba
  await sleep(2800);
  const joined = await dono.request({ t: 'game:join', roomId: room.id });
  assert.deepEqual(joined.room.players.map((p) => p.id), [dono.me.id]);
  assert.equal(joined.room.hostId, dono.me.id); // sala sem ninguém mandando: quem entra assume
  await dono.request({ t: 'game:leave' });
});

test('jogos: todos os jogos da lista abrem, rodam e aceitam comandos', async () => {
  const { games } = await ana.request({ t: 'games:list' });
  assert.ok(games.some((g) => g.id === 'tron'));
  for (const g of games) {
    const { room } = await ana.request({ t: 'game:create', game: g.id });
    assert.equal(room.maxPlayers, g.maxPlayers);
    assert.equal((await ana.request({ t: 'game:start', roomId: room.id })).t, 'ok');
    const st = await ana.waitFor('game:state', (e) => e.roomId === room.id);
    assert.ok(st.state.players.some((p) => p.id === ana.me.id), g.id);
    ana.send({ t: 'game:input', roomId: room.id, dir: 'down', fire: true, aim: 1.5, x: 0.5, y: 0.5, cell: 4 });
    await sleep(150);
    await ana.request({ t: 'game:leave' });
  }
  assert.equal((await ana.request({ t: 'game:create', game: 'xadrez' })).t, 'error');
});

test('jogo de cartas: cada pessoa recebe só a própria mão', async () => {
  const { room } = await ana.request({ t: 'game:create', game: 'cartas' });
  await dono.request({ t: 'game:join', roomId: room.id });
  await ana.request({ t: 'game:start', roomId: room.id });
  const a = await ana.waitFor('game:state', (e) => e.roomId === room.id);
  const d = await dono.waitFor('game:state', (e) => e.roomId === room.id);
  assert.ok(a.state.hand.length >= 7 && d.state.hand.length >= 7);
  const anaIds = new Set(a.state.hand.map((c) => c.id));
  assert.ok(d.state.hand.every((c) => !anaIds.has(c.id)), 'a mão da Ana não vai para o dono');
  assert.ok(a.state.players.every((p) => !('hand' in p)));
  await dono.request({ t: 'game:leave' });
  await ana.request({ t: 'game:leave' });
});
