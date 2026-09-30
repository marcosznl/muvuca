// Conexões abertas (WebSocket) e envio de avisos para quem está online
import { db } from './store.js';
import { canSeeChannel, serverViewFor } from '../public/js/permissions.js';

export const sockets = new Map(); // userId -> Set<ws> (a mesma conta pode estar em várias abas)

export function send(ws, msg) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
}

export function sendToUser(userId, msg) {
  for (const ws of sockets.get(userId) ?? []) send(ws, msg);
}

// Para todos os membros; se o aviso é de um canal privado, só para quem enxerga o canal
export function sendToServer(serverId, msg) {
  const snap = db.snapshot(serverId);
  const channelId = msg.channel ?? msg.channelId ?? msg.msg?.channel ?? null;
  const channel = channelId ? snap?.channels.find((c) => c.id === channelId) : null;
  for (const m of snap?.members ?? []) if (!channel || canSeeChannel(snap, m.id, channel)) sendToUser(m.id, msg);
}

// Status escolhido (online, ausente, não perturbe, invisível) e ausência automática (sem mexer no site)
export const PRESENCES = ['online', 'idle', 'dnd', 'invisible'];
export const presencePref = new Map(); // userId -> status escolhido
export const autoIdle = new Set();     // userId que está parado há um tempo

export function statusOf(userId) {
  const pref = presencePref.get(userId) ?? 'online';
  return pref === 'online' && autoIdle.has(userId) ? 'idle' : pref;
}

// Invisível: conectado, mas aparece offline para os outros
export const onlineIds = () => [...sockets.keys()].filter((id) => statusOf(id) !== 'invisible');

// Quem está jogando o quê (a área de jogos informa; evita importar os jogos aqui)
let activityOf = () => ({});
export const setActivityProvider = (fn) => { activityOf = fn; };

export function presenceMessage() {
  const online = onlineIds();
  const status = {};
  for (const id of online) if (statusOf(id) !== 'online') status[id] = statusOf(id);
  const all = activityOf();
  const activity = Object.fromEntries(online.filter((id) => all[id]).map((id) => [id, all[id]]));
  return { t: 'presence', online, status, activity };
}

export function broadcastPresence() {
  const msg = presenceMessage();
  for (const id of sockets.keys()) sendToUser(id, msg);
}

// Alguma aba da pessoa está aberta e à vista? (senão vale mandar notificação no celular)
export const isWatching = (userId) => [...(sockets.get(userId) ?? [])].some((ws) => !ws.hidden);

// Manda o estado novo do servidor para todos os membros conectados
export function pushServer(serverId) {
  const snap = db.snapshot(serverId);
  if (snap) for (const m of snap.members) sendToUser(m.id, { t: 'server', server: serverViewFor(snap, m.id) });
}

// Mudou algo da pessoa (nome, foto): aparece em todos os servidores dela e no painel dela
export function pushUser(userId) {
  for (const serverId of db.serverIdsOf({ id: userId })) pushServer(serverId);
  sendToUser(userId, { t: 'me', you: db.userById(userId) });
  for (const f of db.friendsOf(userId)) sendToUser(f.user.id, { t: 'friends', friends: db.friendsOf(f.user.id) });
}
