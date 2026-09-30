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

test('anexo: documento vai sempre como download (nunca abre como página do site)', async () => {
  const html = Buffer.from('<html><script>alert(1)</script></html>');
  const up = await ana.upload('/api/attach', { channel: 'geral', name: 'relatório final.pdf' }, html);
  assert.equal(up.status, 200);
  assert.equal(up.body.kind, 'file');
  assert.equal(up.body.name, 'relatório final.pdf');
  const msg = await ana.say('geral', '', { attachments: [up.body.id] });
  assert.equal(msg.attachments[0].kind, 'file');
  const file = await fetch(server.base + msg.attachments[0].url);
  assert.equal(file.status, 200);
  assert.equal(file.headers.get('content-type'), 'application/octet-stream');
  assert.match(file.headers.get('content-disposition'), /^attachment; filename\*=UTF-8''relat%C3%B3rio%20final\.pdf$/);
  assert.equal(file.headers.get('content-security-policy'), 'sandbox');
  assert.equal(Buffer.from(await file.arrayBuffer()).equals(html), true);
});

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

test('anexo: vídeo aceita pedaços (Range); programa é recusado', async () => {
  const up = await ana.upload('/api/attach', { channel: 'geral', name: 'v.webm' }, WEBM);
  assert.equal(up.body.kind, 'video');
  const msg = await ana.say('geral', 'video', { attachments: [up.body.id] });
  const part = await fetch(server.base + msg.attachments[0].url, { headers: { Range: 'bytes=0-3' } });
  assert.equal(part.status, 206);
  assert.equal(part.headers.get('content-range'), `bytes 0-3/${WEBM.length}`);
  const bad = await ana.upload('/api/attach', { channel: 'geral', name: 'virus.exe' }, Buffer.from('MZ não sou mídia'));
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

test('banner do perfil: GIF animado maior que a foto; remover apaga o arquivo', async () => {
  const gif = Buffer.concat([Buffer.from('GIF89a'), Buffer.alloc(8 * 1024 * 1024)]); // 8 MB: passa do limite da foto, cabe no banner (até 10 MB)
  assert.equal((await ana.upload('/api/image', { for: 'avatar' }, gif)).status, 413);
  const huge = Buffer.concat([Buffer.from('GIF89a'), Buffer.alloc(11 * 1024 * 1024)]);
  assert.equal((await ana.upload('/api/image', { for: 'banner' }, huge)).status, 413, 'mais de 10 MB não entra');
  const up = await ana.upload('/api/image', { for: 'banner' }, gif);
  assert.equal(up.status, 200);
  await sleep(150);
  assert.equal(ana.me.bannerImage, up.body.id);
  const img = await fetch(`${server.base}/img/${up.body.id}`);
  assert.equal(img.headers.get('content-type'), 'image/gif');
  await ana.request({ t: 'banner:remove' });
  await sleep(150);
  assert.equal(ana.me.bannerImage, null);
  assert.equal((await fetch(`${server.base}/img/${up.body.id}`)).status, 404);
});

test('amigos: pedir pelo @usuário, aceitar e desfazer; os dois lados veem na hora', async () => {
  assert.match((await ana.request({ t: 'friend:add', username: '@ninguem-aqui' })).message, /Não achei/);
  assert.match((await ana.request({ t: 'friend:add', userId: ana.me.id })).message, /si mesmo/);
  const res = await ana.request({ t: 'friend:add', username: '@DONO' });
  assert.equal(res.status, 'outgoing');
  const pedido = await dono.waitFor('friends', (e) => e.friends.some((f) => f.user.id === ana.me.id));
  assert.equal(pedido.friends.find((f) => f.user.id === ana.me.id).status, 'incoming');
  assert.match((await ana.request({ t: 'friend:add', userId: dono.me.id })).message, /já mandou/);
  assert.equal((await dono.request({ t: 'friend:accept', userId: ana.me.id })).t, 'ok');
  const aceito = await ana.waitFor('friends', (e) => e.friends.some((f) => f.user.id === dono.me.id && f.status === 'friend'));
  assert.equal(aceito.friends[0].user.username, 'dono');
  await dono.request({ t: 'friend:remove', userId: ana.me.id });
  await ana.waitFor('friends', (e) => !e.friends.length);
  // Pedido cruzado vira amizade direto
  await ana.request({ t: 'friend:add', userId: dono.me.id });
  assert.equal((await dono.request({ t: 'friend:add', userId: ana.me.id })).status, 'friend');
  await ana.request({ t: 'friend:remove', userId: dono.me.id });
});

test('ligação direta: conversa tem canal de chamada; toca, recusa e fica o aviso de chamada perdida', async () => {
  await ana.request({ t: 'dm:open', userIds: [dono.me.id] });
  const conv = (await ana.waitFor('server', (e) => e.server.kind === 'dm')).server;
  const call = conv.channels.find((c) => c.type === 'voice');
  assert.ok(call, 'conversa sem canal de chamada');
  const tok = await ana.post('/token', { channel: call.id });
  assert.equal(tok.status, 200); // DM deixa entrar na voz
  const start = await ana.request({ t: 'call:start', serverId: conv.id });
  assert.equal(start.channelId, call.id);
  const ring = await dono.waitFor('call:ring', (e) => e.serverId === conv.id);
  assert.equal(ring.from.id, ana.me.id);
  await dono.request({ t: 'call:decline', serverId: conv.id });
  const stop = await ana.waitFor('call:stop', (e) => e.serverId === conv.id);
  assert.equal(stop.reason, 'declined');
  // Ligar de novo logo em seguida: precisa esperar (ninguém fica insistindo)
  assert.match((await ana.request({ t: 'call:start', serverId: conv.id })).message, /Espere/);
  // A outra pessoa liga e desiste: aviso de chamada perdida na conversa
  await dono.request({ t: 'call:start', serverId: conv.id });
  await ana.waitFor('call:ring');
  await dono.request({ t: 'call:cancel', serverId: conv.id });
  const missed = await ana.waitFor('msg', (e) => e.msg.system && e.msg.kind === 'call' && /perdida/.test(e.msg.text));
  assert.match(missed.msg.text, new RegExp(dono.me.id));
  // Servidor comum não tem ligação direta
  assert.match((await ana.request({ t: 'call:start', serverId: home })).message, /mensagens diretas/);
});

test('grupo: qualquer pessoa renomeia; conversa a dois não tem nome', async () => {
  const caio = await new Person(server, 'caio3').register();
  await ana.request({ t: 'dm:open', userIds: [dono.me.id, caio.me.id] });
  const grupo = (await ana.waitFor('server', (e) => e.server.kind === 'dm' && e.server.members.length === 3)).server;
  assert.equal(grupo.dmName, null);
  await caio.request({ t: 'dm:rename', serverId: grupo.id, name: '  Galera do  Bomberman 💣 ' });
  const renamed = await ana.waitFor('server', (e) => e.server.id === grupo.id && e.server.dmName);
  assert.equal(renamed.server.dmName, 'Galera do Bomberman 💣');
  const aviso = await ana.waitFor('msg', (e) => e.msg.kind === 'rename');
  assert.match(aviso.msg.text, /Galera do Bomberman/);
  await dono.request({ t: 'dm:rename', serverId: grupo.id, name: '' });
  await ana.waitFor('server', (e) => e.server.id === grupo.id && e.server.dmName === null);
  const dupla = (await ana.request({ t: 'dm:open', userIds: [dono.me.id] }), ana.servers.find((s) => s.kind === 'dm' && s.members.length === 2));
  if (dupla) assert.match((await ana.request({ t: 'dm:rename', serverId: dupla.id, name: 'x' })).message, /grupos/);
  caio.close();
});

test('limite de pessoas do canal de voz: só quem gerencia canais muda; vai de 0 (sem limite) a 25', async () => {
  const voz = dono.server_(home).channels.find((c) => c.type === 'voice');
  assert.equal(voz.userLimit, 0);
  assert.match((await ana.request({ t: 'channel:settings', channelId: voz.id, name: voz.name, bitrate: 128, userLimit: 5 })).message, /permissão/);
  assert.match((await dono.request({ t: 'channel:settings', channelId: voz.id, name: voz.name, bitrate: 128, userLimit: 99 })).message, /25/);
  assert.equal((await dono.request({ t: 'channel:settings', channelId: voz.id, name: voz.name, bitrate: 128, userLimit: 5 })).t, 'ok');
  const snap = await ana.waitFor('server', (e) => e.server.id === home && e.server.channels.some((c) => c.id === voz.id && c.userLimit === 5));
  assert.ok(snap);
  await dono.request({ t: 'channel:settings', channelId: voz.id, name: voz.name, bitrate: 128, userLimit: 0 });
});

test('segurança: cabeçalhos em todas as respostas e CSP com a impressão digital dos scripts embutidos', async () => {
  const page = await fetch(`${server.base}/`);
  assert.equal(page.headers.get('x-frame-options'), 'DENY');
  assert.equal(page.headers.get('x-content-type-options'), 'nosniff');
  const csp = page.headers.get('content-security-policy');
  assert.match(csp, /frame-ancestors 'none'/);
  assert.match(csp, /script-src 'self' blob: 'wasm-unsafe-eval' 'sha256-[A-Za-z0-9+/=]+'/);
  assert.doesNotMatch(csp, /unsafe-inline'[^;]*script|script-src[^;]*unsafe-inline/);
  const api = await fetch(`${server.base}/health`);
  assert.equal(api.headers.get('x-frame-options'), 'DENY');
});

test('segurança: 10 senhas erradas na mesma conta bloqueiam a conta por um tempo (de qualquer IP)', async () => {
  const tries = [];
  for (let i = 0; i < 11; i++) {
    tries.push((await fetch(`${server.base}/api/login`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': `10.9.${i}.1` },
      body: JSON.stringify({ username: 'caio3', password: `errada-${i}` }),
    })).status);
  }
  assert.equal(tries[0], 401);
  assert.equal(tries[10], 429); // IPs diferentes, mesma conta: bloqueou
});

test('trocar senha: confere a atual, derruba os outros aparelhos e mantém este conectado', async () => {
  const pc = await new Person(server, 'dudu').register();
  // O mesmo usuário num segundo aparelho
  const phone = new Person(server, 'dudu');
  phone.token = (await phone.post('/api/login', { username: 'dudu', password: 'senha-123' })).body.token;
  await phone.connect();
  assert.equal((await pc.post('/api/password', { current: 'errada', password: 'nova-senha-1' })).status, 401);
  assert.equal((await pc.post('/api/password', { current: 'senha-123', password: 'curta' })).status, 400);
  const ok = await pc.post('/api/password', { current: 'senha-123', password: 'nova-senha-1' });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.others, 1);
  // O outro aparelho recebe o aviso e sai; o token dele não vale mais
  const kicked = await phone.waitFor('error', (e) => e.code === 'auth');
  assert.match(kicked.message, /senha foi trocada/);
  assert.equal((await phone.post('/api/password', { current: 'nova-senha-1', password: 'outra-senha-2' })).status, 401);
  // Este aparelho continua funcionando
  assert.equal((await pc.request({ t: 'status:text', text: 'ainda aqui' })).t, 'ok');
  // Senha antiga não entra mais; a nova sim
  assert.equal((await pc.post('/api/login', { username: 'dudu', password: 'senha-123' })).status, 401);
  assert.equal((await pc.post('/api/login', { username: 'dudu', password: 'nova-senha-1' })).status, 200);
  pc.close();
  phone.close();
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
  for (const g of games.filter((x) => x.minPlayers <= 1)) {
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

test('a sessão se renova com o uso (30 dias a partir do último uso)', async () => {
  const { DatabaseSync } = await import('node:sqlite');
  const path = await import('node:path');
  const file = path.join(server.dir, 'teste.db');
  const p = new Person(server, 'ana');
  const res = await p.post('/api/login', { username: 'ana', password: 'senha-123' });
  p.token = res.body.token;
  const { createHash } = await import('node:crypto');
  const hash = createHash('sha256').update(p.token).digest('hex');
  const db = new DatabaseSync(file);
  try {
    assert.ok(db.prepare('SELECT 1 FROM sessions WHERE token_hash = ?').get(hash), 'a sessão existe');
    // Faz de conta que a sessão foi criada há 20 dias (faltam 10)
    const soon = Date.now() + 10 * 86_400_000;
    db.prepare('UPDATE sessions SET expires_at = ? WHERE token_hash = ?').run(soon, hash);
    await p.connect(); // usar o Muvuca
    const after = db.prepare('SELECT expires_at FROM sessions WHERE token_hash = ?').get(hash).expires_at;
    assert.ok(after > Date.now() + 29 * 86_400_000, 'voltou a valer por 30 dias');
    p.close();
  } finally { db.close(); }
});

test('a política de segurança deixa rodar WebAssembly (supressão de ruído da call)', async () => {
  const res = await fetch(`${server.base}/`);
  const csp = res.headers.get('content-security-policy') ?? '';
  const script = csp.split(';').find((d) => d.trim().startsWith('script-src')) ?? '';
  assert.match(script, /'wasm-unsafe-eval'/, 'sem isso o microfone da call fica mudo');
  assert.doesNotMatch(script, /'unsafe-eval'/, 'eval de JavaScript continua bloqueado');
});

test('2º aparelho na call: identidade "conta:2", sem microfone, nome avisando', async () => {
  const payload = (tok) => JSON.parse(Buffer.from(tok.split('.')[1], 'base64url').toString());
  const main = payload((await ana.post('/token', { channel: 'sala-1' })).body.token);
  const second = payload((await ana.post('/token', { channel: 'sala-1', second: true })).body.token);
  assert.equal(main.sub, ana.me.id);
  assert.equal(second.sub, `${ana.me.id}:2`);
  assert.match(second.name, /\(2º aparelho\)$/);
  assert.equal(second.attributes?.companion, '1');
  // Microfone (fonte 2) só no aparelho principal; câmera e tela nos dois
  const sources = (p) => (p.video.canPublishSources ?? []).map((x) => String(x).toLowerCase());
  assert.ok(sources(main).some((x) => x.includes('microphone') || x === '2'));
  assert.ok(!sources(second).some((x) => x.includes('microphone') || x === '2'));
  assert.ok(sources(second).some((x) => x.includes('camera') || x === '1'));
});

test('mover da call: só com "Mover membros", só quem está numa call do servidor', async () => {
  const semPermissao = await ana.request({ t: 'voice:move', userId: dono.me.id, channelId: 'sala-1' });
  assert.equal(semPermissao.t, 'error');
  assert.match(semPermissao.message, /permissão para mover/);
  // O dono pode, mas a Ana não está em nenhuma call (sem LiveKit no teste)
  const foraDaCall = await dono.request({ t: 'voice:move', userId: ana.me.id, channelId: 'sala-1' });
  assert.match(foraDaCall.message, /não está numa call/);
  assert.match((await dono.request({ t: 'voice:move', userId: ana.me.id, channelId: 'geral' })).message, /não encontrado/);
});

test('apelido no servidor: só com "Gerenciar apelidos", aparece no servidor e vazio volta ao nome da conta', async () => {
  const nick = (who, userId, value) => who.request({ t: 'member:nick', serverId: home, userId, nick: value });
  const semPermissao = await nick(ana, dono.me.id, 'chefinho');
  assert.equal(semPermissao.t, 'error');
  assert.match(semPermissao.message, /permissão para mudar apelidos/);
  assert.equal((await nick(dono, ana.me.id, '  Aninha   da  Silva ')).t, 'ok');
  const ev = await ana.waitFor('server', (e) => e.server.id === home && e.server.members.some((x) => x.id === ana.me.id && x.nick));
  const mem = ev.server.members.find((x) => x.id === ana.me.id);
  assert.equal(mem.nick, 'Aninha da Silva');
  assert.equal(mem.name, 'Aninha da Silva');
  assert.ok(mem.globalName && mem.globalName !== mem.nick, 'o nome da conta continua disponível');
  ana.events = ana.events.filter((e) => e.t !== 'server'); // só vale o aviso que vem depois de tirar o apelido
  assert.equal((await nick(dono, ana.me.id, '')).t, 'ok');
  const back = await ana.waitFor('server', (e) => e.server.id === home && e.server.members.some((x) => x.id === ana.me.id && !x.nick));
  assert.equal(back.server.members.find((x) => x.id === ana.me.id).name, mem.globalName);
});

test('ordem dos servidores na coluna: cada pessoa escolhe a sua e ela volta ao entrar de novo', async () => {
  await dono.request({ t: 'server:create', name: 'Segundo' });
  const segundo = (await dono.waitFor('server', (e) => e.server.name === 'Segundo')).server.id;
  const ids = [segundo, home, 'servidor-que-nao-e-meu'];
  assert.equal((await dono.request({ t: 'servers:order', ids })).t, 'ok');
  const ev = await dono.waitFor('servers:order');
  assert.deepEqual(ev.ids, [segundo, home], 'o que não é da pessoa é ignorado');
  // Entrando de novo (outra aba): a lista já vem na ordem escolhida
  const outra = new Person(server, 'dono');
  outra.token = dono.token;
  await outra.connect();
  const ordem = outra.servers.filter((s) => s.kind !== 'dm').map((s) => s.id);
  assert.deepEqual(ordem.slice(0, 2), [segundo, home]);
  outra.close();
});
