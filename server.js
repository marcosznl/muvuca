// Muvuca: servidor do site (HTTP + WebSocket). Cada assunto mora num arquivo em src/.
import http from 'node:http';
import { WebSocketServer } from 'ws';
import { PORT, HOST, ACTION_RATE } from './src/config.js';
import { db } from './src/store.js';
import { sockets, send, broadcastPresence, presenceMessage, presencePref, autoIdle } from './src/realtime.js';
import { register, login, cleanupAuthFails, changePassword } from './src/auth.js';
import { voiceToken, voiceFor, pollVoice, voiceAll } from './src/voice.js';
import { serverViewFor } from './public/js/permissions.js';
import { setBusyCheck, setBandwidth } from './src/throttle.js';
import { INVITE_EXPIRY, deleteServerNow, transferServer, renameServer } from './src/actions/servers.js';
import { music, musicFor } from './src/music-rooms.js';
import { uploadEmoji, serveEmoji } from './src/emojis.js';
import { uploadImage, serveImage } from './src/images.js';
import { uploadAttachment, serveFile, cleanupFiles } from './src/attachments.js';
import { serveStatic } from './src/static.js';
import { actions, RATE_FREE } from './src/actions/index.js';
import { leaveRoom } from './src/games/lobby.js';
import { publicKey } from './src/push.js';
import { uploadSound, serveSound } from './src/soundboard.js';
import { HttpError, ActionError, json, bearer, clientIp, readBody } from './src/util.js';
import { ipBlocked, lockedOut, maintenance, disconnectUser, blockUser, blockIp, setMaintenance, adminDeleteMessage, adminDeleteFile, resetPassword, deleteAccount, reloadEveryone } from './src/moderation.js';
import { adjustXp } from './src/xp.js';
import { auditAction, audit, purgeAudit } from './src/audit.js';
import { internalStats, isInternal } from './src/internal.js';

// ---------- HTTP ----------

// Rotas com dados (o resto é arquivo do site)
const routes = {
  'POST /api/register': (req) => register(req),
  'POST /api/login': (req) => login(req),
  'POST /api/password': (req) => changePassword(req),
  'POST /api/logout': (req) => {
    const user = db.userBySession(bearer(req));
    if (user) audit('auth:logout', { user, ip: clientIp(req) });
    db.deleteSession(bearer(req));
    return { ok: true };
  },
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

// Cabeçalhos de segurança em todas as respostas (a CSP das páginas fica no src/static.js)
function securityHeaders(req, res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY'); // ninguém embute o Muvuca em outro site (clickjacking)
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Permissions-Policy', 'camera=(self), microphone=(self), display-capture=(self), geolocation=(), payment=(), usb=()');
  // Pelo link público (HTTPS via Caddy): o navegador passa a usar só HTTPS neste endereço
  if (req.headers['x-forwarded-proto'] === 'https') res.setHeader('Strict-Transport-Security', 'max-age=31536000');
}

// Ordens do painel administrativo (só de dentro do Mac, com a chave do painel)
// Trava de velocidade dos arquivos: "esperta" aperta só quando tem gente na voz
setBusyCheck(() => Object.values(voiceAll()).some((people) => people.length > 0));

const internalActions = {
  '/internal/user/disconnect': (b) => disconnectUser(String(b.userId)),
  '/internal/user/block': (b) => blockUser(String(b.userId), b.block === true, b.reason),
  '/internal/ip/block': (b) => blockIp(String(b.ip ?? ''), b.block === true, b.reason),
  '/internal/maintenance': (b) => setMaintenance(b),
  '/internal/reload': () => reloadEveryone(),
  '/internal/xp/adjust': (b) => adjustXp(String(b.userId), b.amount, { reset: b.reset === true }),
  '/internal/message/delete': (b) => adminDeleteMessage(b.id),
  '/internal/bandwidth': (b) => setBandwidth(b),
  '/internal/user/reset-password': (b) => resetPassword(String(b.userId ?? ''), b.password),
  '/internal/user/delete': (b) => deleteAccount(String(b.userId ?? '')),
  // Convites pelo painel: criados em nome do dono do servidor
  '/internal/invite/create': (b) => {
    const srv = db.server(String(b.serverId ?? ''));
    if (!srv || srv.kind === 'dm') throw new Error('Servidor não encontrado.');
    const expiresIn = INVITE_EXPIRY.includes(b.expiresIn) ? b.expiresIn : INVITE_EXPIRY[3];
    const maxUses = Number.isInteger(b.maxUses) && b.maxUses >= 1 && b.maxUses <= 100 ? b.maxUses : null;
    const code = db.createInvite(srv.id, { id: `u${srv.owner_id}` }, { expiresIn, maxUses });
    return { ok: true, code };
  },
  '/internal/invite/revoke': (b) => {
    const row = db.inviteRow(String(b.code ?? ''));
    if (!row) throw new Error('Convite não encontrado.');
    db.deleteInvite(row.code);
    return { ok: true };
  },
  '/internal/file/delete': (b) => adminDeleteFile(String(b.id ?? '')),
  // Servidores pelo painel: renomear, passar a posse (inclusive do principal) e excluir
  '/internal/server/rename': (b) => ({ ok: true, name: renameServer(serverForPanel(b.serverId), b.name) }),
  '/internal/server/transfer': async (b) => { await transferServer(serverForPanel(b.serverId), String(b.userId ?? '')); return { ok: true }; },
  '/internal/server/delete': async (b) => { await deleteServerNow(serverForPanel(b.serverId)); return { ok: true }; },
};
function serverForPanel(id) {
  const snap = db.snapshot(String(id ?? ''));
  if (!snap || snap.kind === 'dm') throw new Error('Servidor não encontrado.');
  return snap;
}

const server = http.createServer(async (req, res) => {
  securityHeaders(req, res);
  const url = new URL(req.url, 'http://x');
  // IP bloqueado pelo painel: não acessa nada
  if (ipBlocked(clientIp(req))) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('Acesso bloqueado.');
  }
  try {
    if (req.method === 'POST' && internalActions[url.pathname]) {
      if (!isInternal(req)) return json(res, 404, { error: 'Não encontrado' });
      try { return json(res, 200, await internalActions[url.pathname](await readBody(req))); } catch (err) { return json(res, 400, { error: err.message }); }
    }
    const route = routes[`${req.method} ${url.pathname}`];
    if (route) return json(res, 200, await route(req, url));
    if (req.method !== 'GET') return json(res, 404, { error: 'Não encontrado' });
    if (getRoutes[url.pathname]) return json(res, 200, getRoutes[url.pathname]());
    // Números para o painel administrativo (só de dentro do Mac, com a chave do painel)
    if (url.pathname === '/internal/stats' && isInternal(req)) return json(res, 200, internalStats(startedAt));
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
  ws.sessionToken = String(token ?? ''); // para a troca de senha saber qual aba manter conectada
  if (!user) {
    send(ws, { t: 'error', code: 'auth', message: 'Sua sessão expirou. Entre de novo.' });
    ws.close();
    return null;
  }
  // Senha temporária (dada pelo painel): primeiro troca a senha, depois entra
  if (db.mustChange(user.id)) {
    send(ws, { t: 'error', code: 'must_change', message: 'Escolha uma senha nova para continuar.' });
    ws.close();
    return null;
  }
  // Manutenção com acesso travado: só o dono entra
  if (lockedOut(user.id)) {
    send(ws, { t: 'error', code: 'maintenance', message: maintenance().message });
    ws.close();
    return null;
  }
  const firstSocket = !sockets.has(user.id);
  if (firstSocket) sockets.set(user.id, new Set());
  sockets.get(user.id).add(ws);
  db.touchSession(ws.sessionToken, { ip: ws.ip, ua: ws.ua }); // "aparelhos conectados": último uso e de onde
  presencePref.set(user.id, user.presence);
  db.touchUser(user.id);
  const presence = presenceMessage();
  const servers = db.serverIdsOf(user).map((id) => serverViewFor(db.snapshot(id), user.id));
  const visible = new Set(servers.flatMap((sv) => sv.channels.map((c) => c.id))); // canais privados sem acesso ficam de fora
  send(ws, {
    t: 'welcome',
    you: user,
    servers,
    online: presence.online,
    status: presence.status,
    activity: presence.activity,
    voice: voiceFor(user.id),
    music: musicFor(user.id),
    unread: Object.fromEntries(Object.entries(db.unread(user.id)).filter(([id]) => visible.has(id))),
    mutes: db.mutes(user.id),
    friends: db.friendsOf(user.id),
    readState: db.readState(user.id),
    maintenance: maintenance(),
    xpRank: db.xpRank(user.id),
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
  let record = null;
  try { record = auditAction(user, m, ws.ip); } catch (err) { console.error('auditoria:', err.message); }
  try {
    const reply = await handler(user, m, ws);
    try { record?.(); } catch (err) { console.error('auditoria:', err.message); }
    if (reply) send(ws, { ...reply, req: m.req });
    else if (m.req) send(ws, { t: 'ok', req: m.req }); // confirma ações sem resposta própria
  } catch (err) {
    if (err instanceof ActionError) send(ws, { t: 'error', message: err.message, req: m.req });
    else { console.error(err); send(ws, { t: 'error', message: 'Erro interno.', req: m.req }); }
  }
}

wss.on('connection', (ws, req) => {
  ws.ip = clientIp(req);
  ws.ua = String(req.headers['user-agent'] ?? '').slice(0, 300) || null;
  if (ipBlocked(ws.ip)) { ws.close(); return; }
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
      db.touchUser(user.id);
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
setInterval(() => { db.purgeExpiredSessions(); purgeAudit(); db.purgeXpEvents(Date.now() - 90 * 86_400_000); db.purgeClientErrors(Date.now() - 30 * 86_400_000); }, 3_600_000);
setInterval(cleanupFiles, 30 * 60_000); // anexos abandonados e de mensagens apagadas

server.listen(PORT, HOST, () => {
  console.log(`Muvuca rodando em http://${HOST}:${PORT}`);
  pollVoice();
});
