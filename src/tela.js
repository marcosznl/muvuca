// Salas de tela: salas avulsas só para compartilhar a tela, criadas pelo bot Muvuca do Discord
// (/tela, ver src/bot-discord.js).
// Um link único por sala. Quem abre entra com a conta do Discord (só membros do servidor do Discord
// onde a sala foi criada) e aparece com o nome e a foto de lá; ninguém precisa de conta no Muvuca.
// A sala fecha sozinha depois de TELA_VAZIA_MS sem ninguém dentro.
// Tudo fica na memória: se o servidor reiniciar, os links abertos param de funcionar.
import crypto from 'node:crypto';
import { AccessToken, TrackSource } from 'livekit-server-sdk';
import { API_KEY, API_SECRET, LIVEKIT_URL, PUBLIC_URL, DISCORD_CLIENT_ID, DISCORD_CLIENT_SECRET, DISCORD_API, TELA_VAZIA_MS } from './config.js';
import { roomService } from './voice.js';
import { HttpError, readBody, clean } from './util.js';
import { serveStatic } from './static.js';

const POR_PESSOA = 2;          // salas abertas ao mesmo tempo por pessoa do Discord
const TOTAL = 20;              // salas abertas ao mesmo tempo no total
const LOGIN_MS = 10 * 60_000;  // tempo para concluir o login no Discord
const SESSAO_MS = 12 * 3_600_000;
const COOKIE = 'tela';
const SEGURO = PUBLIC_URL.startsWith('https:');
const REDIRECT_URI = `${PUBLIC_URL}/tela/callback`;
const ID_DISCORD = /^\d{5,25}$/;
const CODIGO = /^[A-Za-z0-9_-]{12}$/;

const salas = new Map();   // código -> { codigo, guildId, guildName, criador, ocupadaEm }
const logins = new Map();  // state do OAuth -> { sala, ate }
const sessoes = new Map(); // cookie -> { sala, id, nome, avatar, ate }

const nomeDaSala = (codigo) => `tela-${codigo}`;
const aleatorio = (bytes) => crypto.randomBytes(bytes).toString('base64url');

// Pedida pelo /tela do bot Muvuca
export function criarSala(b) {
  const guildId = String(b.guildId ?? ''), criador = String(b.userId ?? '');
  if (!ID_DISCORD.test(guildId) || !ID_DISCORD.test(criador)) throw new Error('Servidor ou pessoa do Discord inválidos.');
  const abertas = [...salas.values()];
  if (abertas.filter((s) => s.criador === criador).length >= POR_PESSOA) {
    throw new Error(`Você já tem ${POR_PESSOA} salas de tela abertas. Use uma delas ou espere fechar (5 minutos vazia).`);
  }
  if (abertas.length >= TOTAL) throw new Error('Muitas salas de tela abertas agora. Tente de novo daqui a pouco.');
  const codigo = aleatorio(9);
  salas.set(codigo, { codigo, guildId, guildName: clean(b.guildName, 100) || 'Discord', criador, ocupadaEm: Date.now() });
  return { ok: true, codigo, link: `${PUBLIC_URL}/tela/${codigo}` };
}

function encerrar(codigo) {
  salas.delete(codigo);
  for (const [token, s] of sessoes) if (s.sala === codigo) sessoes.delete(token);
  roomService.deleteRoom(nomeDaSala(codigo)).catch(() => {});
}

// Fecha as salas vazias e esquece logins e sessões vencidos
async function verificarSalas() {
  const agora = Date.now();
  for (const sala of salas.values()) {
    const pessoas = await roomService.listParticipants(nomeDaSala(sala.codigo)).then((ps) => ps.length).catch(() => 0);
    if (pessoas > 0) sala.ocupadaEm = agora;
    else if (agora - sala.ocupadaEm >= TELA_VAZIA_MS) encerrar(sala.codigo);
  }
  for (const [state, l] of logins) if (l.ate < agora) logins.delete(state);
  for (const [token, s] of sessoes) if (s.ate < agora) sessoes.delete(token);
}
let verificando = false;
setInterval(() => {
  if (verificando) return;
  verificando = true;
  verificarSalas().finally(() => { verificando = false; });
}, Math.min(30_000, Math.max(50, TELA_VAZIA_MS / 3))).unref();

function redirecionar(res, destino, headers = {}) {
  res.writeHead(302, { Location: destino, 'Cache-Control': 'no-store', ...headers });
  res.end();
}

function cookieDe(req) {
  for (const parte of String(req.headers.cookie ?? '').split(';')) {
    const [nome, ...valor] = parte.trim().split('=');
    if (nome === COOKIE) return valor.join('=');
  }
  return '';
}

// GET /tela/entrar?sala=<código>: manda para o login do Discord
function entrarComDiscord(res, url) {
  const sala = String(url.searchParams.get('sala') ?? '');
  if (!salas.has(sala)) return redirecionar(res, `/tela/${encodeURIComponent(sala)}`);
  if (!DISCORD_CLIENT_ID || !DISCORD_CLIENT_SECRET) return redirecionar(res, `/tela/${sala}?erro=config`);
  if (logins.size >= 1000) logins.delete(logins.keys().next().value); // não deixa a lista crescer sem fim
  const state = aleatorio(16);
  logins.set(state, { sala, ate: Date.now() + LOGIN_MS });
  const params = new URLSearchParams({
    client_id: DISCORD_CLIENT_ID, response_type: 'code', redirect_uri: REDIRECT_URI,
    scope: 'identify guilds.members.read', state, prompt: 'none', // quem já autorizou não vê a tela de novo
  });
  redirecionar(res, `https://discord.com/oauth2/authorize?${params}`);
}

async function discord(caminho, opcoes) {
  const resposta = await fetch(`${DISCORD_API}${caminho}`, { ...opcoes, signal: AbortSignal.timeout(10_000) });
  return { status: resposta.status, corpo: await resposta.json().catch(() => null) };
}

function fotoDe(guildId, user, membro) {
  if (membro?.avatar) return `https://cdn.discordapp.com/guilds/${guildId}/users/${user.id}/avatars/${membro.avatar}.png?size=128`;
  if (user.avatar) return `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.png?size=128`;
  return `https://cdn.discordapp.com/embed/avatars/${Number((BigInt(user.id) >> 22n) % 6n)}.png`;
}

// GET /tela/callback: o Discord volta com o código; confere se a pessoa é membro do servidor da sala
async function voltaDoDiscord(res, url) {
  const state = String(url.searchParams.get('state') ?? '');
  const login = logins.get(state);
  logins.delete(state); // cada login vale uma vez
  if (!login || login.ate < Date.now()) throw new HttpError(400, 'Esse login venceu. Abra o link da sala de novo.');
  const sala = salas.get(login.sala);
  if (!sala) return redirecionar(res, `/tela/${login.sala}`);
  const voltar = (erro) => redirecionar(res, `/tela/${sala.codigo}?erro=${erro}`);
  const code = url.searchParams.get('code');
  if (!code) return voltar('cancelado'); // a pessoa recusou no Discord

  let user, membro;
  try {
    const troca = await discord('/oauth2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: DISCORD_CLIENT_ID, client_secret: DISCORD_CLIENT_SECRET,
        grant_type: 'authorization_code', code, redirect_uri: REDIRECT_URI,
      }),
    });
    if (troca.status !== 200 || !troca.corpo?.access_token) return voltar('discord');
    const auth = { headers: { Authorization: `Bearer ${troca.corpo.access_token}` } };
    const eu = await discord('/users/@me', auth);
    if (eu.status !== 200 || !ID_DISCORD.test(String(eu.corpo?.id ?? ''))) return voltar('discord');
    user = eu.corpo;
    const m = await discord(`/users/@me/guilds/${sala.guildId}/member`, auth);
    if (m.status === 404) return voltar('membro');
    if (m.status !== 200) return voltar('discord');
    membro = m.corpo;
  } catch {
    return voltar('discord');
  }

  const token = aleatorio(32);
  sessoes.set(token, {
    sala: sala.codigo,
    id: user.id,
    nome: clean(membro.nick || user.global_name || user.username, 64) || 'Alguém',
    avatar: fotoDe(sala.guildId, user, membro),
    ate: Date.now() + SESSAO_MS,
  });
  const cookie = `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSAO_MS / 1000}${SEGURO ? '; Secure' : ''}`;
  redirecionar(res, `/tela/${sala.codigo}`, { 'Set-Cookie': cookie });
}

// GET /tela/...: login, volta do Discord e a página da sala
export async function paginaTela(req, res, url) {
  const resto = url.pathname.slice('/tela/'.length);
  if (resto === 'entrar') return entrarComDiscord(res, url);
  if (resto === 'callback') return voltaDoDiscord(res, url);
  if (!CODIGO.test(resto)) throw new HttpError(404, 'Não encontrado');
  return serveStatic(req, res, '/tela.html');
}

// POST /api/tela/entrar { sala }: token do LiveKit só para assistir e compartilhar a tela
export async function entrarNaSala(req) {
  const body = await readBody(req);
  const sala = salas.get(String(body.sala ?? ''));
  if (!sala) throw new HttpError(404, 'Esta sala foi encerrada.');
  const sessao = sessoes.get(cookieDe(req));
  if (!sessao || sessao.sala !== sala.codigo || sessao.ate < Date.now()) throw new HttpError(401, 'Entre com o Discord para continuar.');
  sala.ocupadaEm = Date.now();
  const at = new AccessToken(API_KEY, API_SECRET, {
    identity: `discord-${sessao.id}`, name: sessao.nome, ttl: '6h',
    metadata: JSON.stringify({ discordId: sessao.id, avatar: sessao.avatar }),
  });
  at.addGrant({
    room: nomeDaSala(sala.codigo),
    roomJoin: true,
    canSubscribe: true,
    canPublish: true,
    canPublishSources: [TrackSource.SCREEN_SHARE, TrackSource.SCREEN_SHARE_AUDIO],
    canPublishData: false,
    canUpdateOwnMetadata: false,
  });
  const host = (req.headers.host || 'localhost').replace(/:\d+$/, '');
  return {
    token: await at.toJwt(),
    url: LIVEKIT_URL || `ws://${host === 'localhost' ? '127.0.0.1' : host}:7880`,
    sala: { nome: sala.guildName },
    voce: { id: sessao.id, nome: sessao.nome, avatar: sessao.avatar },
  };
}
