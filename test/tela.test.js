// Bot Muvuca do Discord e salas de tela: /tela pelo endpoint de interações (assinado como o Discord
// assina), login com o Discord (falso, aqui), token só de tela e fechamento da sala vazia.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import crypto from 'node:crypto';
import { startServer, freePort, sleep } from './helpers.js';

const GUILD = '111111111111111111';
const OUTRA_GUILD = '222222222222222222';
const PESSOA = '333333333333333333';
const VAZIA_MS = 1500;

// Par de chaves no lugar do Discord: a pública vai para o servidor, a privada assina as interações
const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
const CHAVE_PUBLICA = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('hex');

let server, discord;
const pedidosDiscord = [];

// Discord falso: o código "ok" é de um membro do servidor GUILD; "fora", de alguém que não é
function discordFalso(port) {
  const srv = http.createServer((req, res) => {
    const responder = (status, corpo) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(corpo)); };
    let corpo = '';
    req.on('data', (c) => { corpo += c; });
    req.on('end', () => {
      pedidosDiscord.push({ metodo: req.method, url: req.url, auth: req.headers.authorization, corpo });
      if (req.method === 'PUT' && req.url === '/applications/cliente-teste/commands') return responder(200, JSON.parse(corpo));
      if (req.url === `/guilds/${GUILD}`) return responder(500, { message: 'o app não usa o token do bot para isso' });
      if (req.url === '/oauth2/token') {
        const p = new URLSearchParams(corpo);
        if (p.get('client_secret') !== 'segredo-discord' || !['ok', 'fora'].includes(p.get('code'))) return responder(400, { error: 'invalid_grant' });
        return responder(200, { access_token: `acesso-${p.get('code')}` });
      }
      const quem = String(req.headers.authorization ?? '').replace('Bearer acesso-', '');
      if (req.url === '/users/@me') return responder(200, { id: PESSOA, username: 'ana', global_name: 'Ana', avatar: 'abc' });
      if (req.url === '/users/@me/guilds') return responder(200, [{ id: '999', name: 'Outro' }, { id: GUILD, name: 'Meu Servidor' }]);
      if (req.url === `/users/@me/guilds/${GUILD}/member`) {
        return quem === 'ok' ? responder(200, { nick: 'Ana do Servidor', avatar: null }) : responder(404, { message: 'Unknown Guild' });
      }
      responder(404, {});
    });
  });
  return new Promise((r) => srv.listen(port, '127.0.0.1', () => r(srv)));
}

before(async () => {
  const port = await freePort();
  discord = await discordFalso(port);
  server = await startServer({
    DISCORD_CLIENT_ID: 'cliente-teste',
    DISCORD_CLIENT_SECRET: 'segredo-discord',
    DISCORD_PUBLIC_KEY: CHAVE_PUBLICA,
    DISCORD_BOT_TOKEN: 'token-do-bot',
    DISCORD_API: `http://127.0.0.1:${port}`,
    TELA_VAZIA_MS: String(VAZIA_MS),
  });
});

after(async () => {
  await server?.stop();
  discord?.close();
});

// Interação como o Discord manda: corpo assinado com o horário
async function interagir(corpo, { assinar = true } = {}) {
  const texto = JSON.stringify(corpo);
  const quando = String(Math.floor(Date.now() / 1000));
  const assinatura = crypto.sign(null, Buffer.from(quando + texto), privateKey).toString('hex');
  const res = await fetch(`${server.base}/discord/interacoes`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Signature-Timestamp': quando, 'X-Signature-Ed25519': assinar ? assinatura : '0'.repeat(128) },
    body: texto,
  });
  return { status: res.status, body: await res.json() };
}

const tela = (userId, guildId = GUILD) => interagir({ type: 2, data: { name: 'tela' }, guild_id: guildId, member: { user: { id: userId } } });

// Cria uma sala pelo /tela e devolve o código (tirado do link do botão)
async function criar(userId, guildId = GUILD) {
  const res = await tela(userId, guildId);
  const caixa = res.body.data.components[0];
  const link = caixa.components[1].components[0].url;
  return link.split('/tela/')[1];
}

const entrar = (sala, cookie = '') => fetch(`${server.base}/api/tela/entrar`, {
  method: 'POST', headers: { 'Content-Type': 'application/json', cookie }, body: JSON.stringify({ sala }),
}).then(async (r) => ({ status: r.status, body: await r.json() }));

const semSeguir = (caminho) => fetch(`${server.base}${caminho}`, { redirect: 'manual' });

// Faz o caminho do navegador: /tela/entrar -> Discord -> /tela/callback. Devolve a resposta da volta.
async function login(sala, code) {
  const ida = await semSeguir(`/tela/entrar?sala=${sala}`);
  const state = new URL(ida.headers.get('location')).searchParams.get('state');
  return semSeguir(`/tela/callback?code=${code}&state=${state}`);
}

const payload = (jwt) => JSON.parse(Buffer.from(jwt.split('.')[1], 'base64url').toString());

test('ao subir, o bot cadastra o /tela no Discord', async () => {
  const cadastro = pedidosDiscord.find((p) => p.metodo === 'PUT');
  assert.ok(cadastro, 'não cadastrou os comandos');
  assert.equal(cadastro.auth, 'Bot token-do-bot');
  const [comando] = JSON.parse(cadastro.corpo);
  assert.equal(comando.name, 'tela');
  assert.deepEqual(comando.contexts, [0], 'só em servidores');
});

test('interações só com a assinatura do Discord', async () => {
  assert.equal((await interagir({ type: 1 }, { assinar: false })).status, 401);
  const semCabecalho = await fetch(`${server.base}/discord/interacoes`, { method: 'POST', body: '{"type":1}' });
  assert.equal(semCabecalho.status, 401);
  const ping = await interagir({ type: 1 });
  assert.equal(ping.status, 200);
  assert.deepEqual(ping.body, { type: 1 });
});

test('/tela publica o link da sala no canal', async () => {
  const res = await tela('444444444444444444');
  assert.equal(res.status, 200);
  assert.equal(res.body.type, 4);
  assert.equal(res.body.data.flags & 64, 0, 'mensagem para todos, não só para quem pediu');
  const caixa = res.body.data.components[0];
  assert.match(caixa.components[0].content, /<@444444444444444444>/);
  assert.deepEqual(res.body.data.allowed_mentions, { parse: [] }, 'menciona sem notificar');
  const botao = caixa.components[1].components[0];
  assert.equal(botao.style, 5);
  assert.match(botao.url, /\/tela\/[A-Za-z0-9_-]{12}$/);
});

test('cada pessoa abre no máximo 2 salas de tela ao mesmo tempo', async () => {
  const pessoa = '555555555555555555';
  await criar(pessoa);
  await criar(pessoa);
  const terceira = await tela(pessoa);
  assert.equal(terceira.body.data.flags & 64, 64, 'o aviso só aparece para quem pediu');
  assert.match(terceira.body.data.content, /2 salas/);
  const foraDeServidor = await interagir({ type: 2, data: { name: 'tela' }, user: { id: pessoa } });
  assert.match(foraDeServidor.body.data.content, /dentro de um servidor/);
});

test('página da sala e ida para o login do Discord', async () => {
  const codigo = await criar('666666666666666666');
  const pagina = await fetch(`${server.base}/tela/${codigo}`);
  assert.equal(pagina.status, 200);
  assert.match(await pagina.text(), /Sala de tela/);
  assert.equal((await fetch(`${server.base}/tela/..%2Fserver.js`)).status, 404);

  const ida = await semSeguir(`/tela/entrar?sala=${codigo}`);
  assert.equal(ida.status, 302);
  const destino = new URL(ida.headers.get('location'));
  assert.equal(destino.origin, 'https://discord.com');
  assert.equal(destino.searchParams.get('client_id'), 'cliente-teste');
  assert.equal(destino.searchParams.get('scope'), 'identify guilds guilds.members.read');
  assert.ok(destino.searchParams.get('redirect_uri').endsWith('/tela/callback'));
  assert.ok(destino.searchParams.get('state'));
});

test('membro do servidor entra e recebe token só para a tela e a câmera (sem microfone)', async () => {
  const codigo = await criar('777777777777777777');
  assert.equal((await entrar(codigo)).status, 401, 'sem login não entra');

  const volta = await login(codigo, 'ok');
  assert.equal(volta.status, 302);
  assert.equal(volta.headers.get('location'), `/tela/${codigo}`);
  const cookie = volta.headers.get('set-cookie').split(';')[0];
  assert.match(volta.headers.get('set-cookie'), /HttpOnly/);

  const res = await entrar(codigo, cookie);
  assert.equal(res.status, 200);
  assert.equal(res.body.sala.nome, 'Meu Servidor', 'nome do servidor, da lista de servidores de quem entrou');
  assert.ok(!pedidosDiscord.some((p) => p.url.startsWith('/guilds/')), 'o app não consulta o servidor com o token do bot');
  assert.equal(res.body.voce.nome, 'Ana do Servidor', 'usa o apelido do servidor');
  assert.equal(res.body.voce.avatar, `https://cdn.discordapp.com/avatars/${PESSOA}/abc.png?size=128`);
  const t = payload(res.body.token);
  assert.equal(t.sub, `discord-${PESSOA}`);
  assert.equal(t.name, 'Ana do Servidor');
  assert.equal(JSON.parse(t.metadata).discordId, PESSOA);
  assert.equal(t.video.room, `tela-${codigo}`);
  assert.equal(t.video.canPublishData, false);
  const fontes = t.video.canPublishSources.map((x) => String(x).toLowerCase());
  assert.equal(fontes.length, 3);
  assert.ok(fontes.every((x) => x.includes('screen_share') || x.includes('camera') || ['1', '3', '4'].includes(x)), `fontes: ${fontes}`);
  assert.ok(!fontes.some((x) => x.includes('microphone') || x === '2'), 'sem microfone');

  // O login vale só para esta sala
  const outra = await criar('777777777777777777');
  assert.equal((await entrar(outra, cookie)).status, 401);
});

test('quem não é membro do servidor do Discord não entra', async () => {
  const codigo = await criar('888888888888888888');
  const volta = await login(codigo, 'fora');
  assert.equal(volta.headers.get('location'), `/tela/${codigo}?erro=membro`);
  assert.equal(volta.headers.get('set-cookie'), null);

  // Sala de outro servidor: o mesmo membro de GUILD também fica de fora
  const deOutro = await criar('888888888888888888', OUTRA_GUILD);
  assert.equal((await login(deOutro, 'ok')).headers.get('location'), `/tela/${deOutro}?erro=membro`);
});

test('cada login do Discord vale uma vez', async () => {
  const codigo = await criar('999999999999999999');
  const ida = await semSeguir(`/tela/entrar?sala=${codigo}`);
  const state = new URL(ida.headers.get('location')).searchParams.get('state');
  assert.equal((await semSeguir(`/tela/callback?code=ok&state=${state}`)).status, 302);
  assert.equal((await semSeguir(`/tela/callback?code=ok&state=${state}`)).status, 400);
  assert.equal((await semSeguir('/tela/callback?code=ok&state=inventado')).status, 400);
});

test('sala vazia fecha sozinha', async () => {
  const codigo = await criar('101010101010101010');
  const cookie = (await login(codigo, 'ok')).headers.get('set-cookie').split(';')[0];
  assert.equal((await entrar(codigo, cookie)).status, 200);
  await sleep(VAZIA_MS + 1500);
  assert.equal((await entrar(codigo, cookie)).status, 404);
  // A ida para o login de uma sala encerrada volta para a página (que mostra "encerrada")
  assert.equal((await semSeguir(`/tela/entrar?sala=${codigo}`)).headers.get('location'), `/tela/${codigo}`);
});
