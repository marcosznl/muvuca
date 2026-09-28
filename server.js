// Muvuca: servidor do site (HTTP + WebSocket). Cada assunto mora num arquivo em src/.
import http from 'node:http';
import { WebSocketServer } from 'ws';
import { PORT, HOST, ACTION_RATE } from './src/config.js';
import { db } from './src/store.js';
import { sockets, send, broadcastPresence, presenceMessage, presencePref, autoIdle } from './src/realtime.js';
import { register, login, cleanupAuthFails } from './src/auth.js';
import { voiceToken, voiceFor, pollVoice } from './src/voice.js';
import { music, musicFor } from './src/music-rooms.js';
import { uploadEmoji, serveEmoji } from './src/emojis.js';
import { uploadImage, serveImage } from './src/images.js';
import { uploadAttachment, serveFile, cleanupFiles } from './src/attachments.js';
import { serveStatic } from './src/static.js';
import { actions, RATE_FREE } from './src/actions/index.js';
import { leaveRoom } from './src/games/lobby.js';
import { publicKey } from './src/push.js';
import { uploadSound, serveSound } from './src/soundboard.js';
import { HttpError, ActionError, json, bearer } from './src/util.js';

// ---------- HTTP ----------

// Rotas com dados (o resto é arquivo do site)
const routes = {
  'POST /api/register': (req) => register(req),
  'POST /api/login': (req) => login(req),
  'POST /api/logout': (req) => { db.deleteSession(bearer(req)); return { ok: true }; },
  'POST /token': (req) => voiceToken(req),
  'POST /api/emojis': (req, url) => uploadEmoji(req, url),
  'POST /api/image': (req, url) => uploadImage(req, url),
  'POST /api/attach': (req, url) => uploadAttachment(req, url),
  'POST /api/sound': (req, url) => uploadSound(req, url),
};

// Arquivos enviados pelas pessoas: /prefixo/<id>
const files = {
  '/file/': (req, res, id) => serveFile(req, res, id),
  '/img/': (req, res, id) => serveImage(res, id),
  '/emoji/': (req, res, id) => serveEmoji(req, res, id),
  '/sound/': (req, res, id) => serveSound(req, res, id),
};

const startedAt = Date.now();

// Rotas de leitura simples (GET)
const getRoutes = {
  // Para um monitor externo (ex.: UptimeRobot) saber se o site está no ar
  '/health': () => ({ ok: true, upSince: new Date(startedAt).toISOString(), online: sockets.size }),
  '/api/push-key': () => ({ key: publicKey() }),
};

function inviteInfo(url) {
  const info = db.invite(decodeURIComponent(url.pathname.slice('/api/invite/'.length)));
  if (!info) throw new HttpError(404, 'Convite inválido ou expirado.');
  return { name: info.name, color: info.color, icon: info.icon, memberCount: info.memberCount };
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  try {
    const route = routes[`${req.method} ${url.pathname}`];
    if (route) return json(res, 200, await route(req, url));
    if (req.method !== 'GET') return json(res, 404, { error: 'Não encontrado' });
    if (getRoutes[url.pathname]) return json(res, 200, getRoutes[url.pathname]());
    if (url.pathname.startsWith('/api/invite/')) return json(res, 200, inviteInfo(url));
    const prefix = Object.keys(files).find((p) => url.pathname.startsWith(p));
    if (prefix) return await files[prefix](req, res, url.pathname.slice(prefix.length));
    return await serveStatic(req, res, url.pathname);
  } catch (err) {
    if (err instanceof HttpError) return json(res, err.status, { error: err.message });
    console.error(err);
    json(res, 500, { error: 'Erro interno' });
  }
});

// ---------- WebSocket (tempo real) ----------

const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 16 * 1024 });

// Primeira mensagem: { t: 'hello', token }. Responde com tudo o que o site precisa para abrir.
function welcome(ws, token) {
  const user = db.userBySession(token);
  if (!user) {
    send(ws, { t: 'error', code: 'auth', message: 'Sua sessão expirou. Entre de novo.' });
    ws.close();
    return null;
  }
  const firstSocket = !sockets.has(user.id);
  if (firstSocket) sockets.set(user.id, new Set());
  sockets.get(user.id).add(ws);
  presencePref.set(user.id, user.presence);
  const presence = presenceMessage();
  send(ws, {
    t: 'welcome',
    you: user,
    servers: db.serverIdsOf(user).map((id) => db.snapshot(id)),
    online: presence.online,
    status: presence.status,
    activity: presence.activity,
    voice: voiceFor(user.id),
    music: musicFor(user.id),
    unread: db.unread(user.id),
    mutes: db.mutes(user.id),
    friends: db.friendsOf(user.id),
    readState: db.readState(user.id),
  });
  music.cancelLeave(user.id); // voltou a tempo depois de uma queda: continua na sala de música
  if (firstSocket) broadcastPresence();
  return user;
}

async function runAction(ws, user, m, actionTimes) {
  const handler = Object.hasOwn(actions, m.t) ? actions[m.t] : null;
  if (!handler) return;
  if (!RATE_FREE.has(m.t)) {
    const now = Date.now();
    while (actionTimes.length && now - actionTimes[0] > ACTION_RATE.windowMs) actionTimes.shift();
    // Com o req, o site mostra este aviso na hora (sem ele, esperava 10 s e dizia "o servidor não respondeu")
    if (actionTimes.length >= ACTION_RATE.count) return send(ws, { t: 'error', message: 'Muitas ações seguidas, espere um pouco.', req: m.req });
    actionTimes.push(now);
  }
  try {
    const reply = await handler(user, m, ws);
    if (reply) send(ws, { ...reply, req: m.req });
    else if (m.req) send(ws, { t: 'ok', req: m.req }); // confirma ações sem resposta própria
  } catch (err) {
    if (err instanceof ActionError) send(ws, { t: 'error', message: err.message, req: m.req });
    else { console.error(err); send(ws, { t: 'error', message: 'Erro interno.', req: m.req }); }
  }
}

wss.on('connection', (ws) => {
  let user = null;
  const actionTimes = [];
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
  const helloTimeout = setTimeout(() => { if (!user) ws.close(); }, 10_000);

  ws.on('message', async (raw) => {
    let m;
    try { m = JSON.parse(raw); } catch { return; }
    if (user) return runAction(ws, user, m, actionTimes);
    if (m.t !== 'hello') return;
    clearTimeout(helloTimeout);
    user = welcome(ws, m.token);
  });

  ws.on('close', () => {
    clearTimeout(helloTimeout);
    if (!user) return;
    const set = sockets.get(user.id);
    set?.delete(ws);
    if (set && set.size === 0) {
      sockets.delete(user.id);
      autoIdle.delete(user.id);
      broadcastPresence();
      music.disconnected(user.id);
      leaveRoom(user.id); // fechou o site: sai da sala de jogo
    }
  });
});

// ---------- Tarefas periódicas ----------

// Derruba conexões mortas (ex.: Wi-Fi caiu sem avisar)
setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) { ws.terminate(); continue; }
    ws.isAlive = false;
    ws.ping();
  }
  cleanupAuthFails();
}, 30_000);
setInterval(() => db.purgeExpiredSessions(), 3_600_000);
setInterval(cleanupFiles, 30 * 60_000); // anexos abandonados e de mensagens apagadas

server.listen(PORT, HOST, () => {
  console.log(`Muvuca rodando em http://${HOST}:${PORT}`);
  pollVoice();
});
