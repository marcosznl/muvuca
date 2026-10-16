// Voz (LiveKit): token para entrar, quem está em cada sala e permissões de quem já está lá
import { AccessToken, RoomServiceClient, TrackSource } from 'livekit-server-sdk';
import { API_KEY, API_SECRET, LIVEKIT_HTTP_URL, LIVEKIT_URL, VOICE_POLL_MS } from './config.js';
import { db } from './store.js';
import { sockets, sendToUser } from './realtime.js';
import { requireUser } from './guards.js';
import { HttpError, readBody, clientIp } from './util.js';
import { audit } from './audit.js';
import { PERMS, computePerms, can, canSeeChannel } from '../public/js/permissions.js';

export const roomService = new RoomServiceClient(LIVEKIT_HTTP_URL, API_KEY, API_SECRET);

function publishGrant(perms) {
  const sources = [];
  if (can(perms, PERMS.SPEAK)) sources.push(TrackSource.MICROPHONE);
  if (can(perms, PERMS.VIDEO)) sources.push(TrackSource.CAMERA, TrackSource.SCREEN_SHARE, TrackSource.SCREEN_SHARE_AUDIO);
  return { canPublish: sources.length > 0, canPublishSources: sources, canPublishData: true };
}

// POST /token: só membros com permissão de conectar; microfone/vídeo conforme os cargos
// Passe de "foi movido": vale 30 s, uma vez, só para aquele canal
const moveTickets = new Map(); // userId -> { channelId, until }
export function grantMove(userId, channelId) { moveTickets.set(userId, { channelId, until: Date.now() + 30_000 }); }
function takeMoveTicket(userId, channelId) {
  const t = moveTickets.get(userId);
  if (!t || t.channelId !== channelId || t.until < Date.now()) return false;
  moveTickets.delete(userId);
  return true;
}

export async function voiceToken(req) {
  const user = requireUser(req);
  const body = await readBody(req);
  const channel = db.channel(body.channel);
  if (!channel || channel.type !== 'voice' || !db.isMember(channel.server_id, user.id)) {
    throw new HttpError(404, 'Canal de voz não encontrado.');
  }
  const snap = db.snapshot(channel.server_id);
  // Canal privado sem acesso: nem existe (vale também para quem foi movido)
  if (!canSeeChannel(snap, user.id, snap.channels.find((c) => c.id === channel.id))) throw new HttpError(404, 'Canal de voz não encontrado.');
  const perms = computePerms(snap, user.id);
  // Movido por alguém com "Mover membros": entra mesmo sem permissão de conectar ou com o canal cheio (como no Discord)
  const moved = takeMoveTicket(user.id, channel.id);
  if (!moved && !can(perms, PERMS.CONNECT)) throw new HttpError(403, 'Você não tem permissão para entrar neste canal.');
  // Limite de pessoas do canal (quem pode gerenciar canais entra mesmo cheio, como no Discord)
  const limit = snap.channels.find((c) => c.id === channel.id)?.userLimit ?? 0;
  if (limit > 0 && !moved && !can(perms, PERMS.MANAGE_CHANNELS)) {
    const inside = await roomService.listParticipants(channel.id).then((ps) => ps.map((p) => p.identity)).catch(() => voicePeople(channel.id).map((p) => p.id));
    if (inside.filter((id) => id !== user.id).length >= limit) throw new HttpError(403, `Esse canal está cheio (máximo de ${limit} ${limit === 1 ? 'pessoa' : 'pessoas'}).`);
  }

  // Entrada em canal de voz fica na auditoria (menos nas ligações das mensagens diretas)
  if (snap.kind !== 'dm') audit('voice:join', { user, ip: clientIp(req), serverId: snap.id, detail: { servidor: snap.name, canal: channel.name, ...(moved ? { movido: true } : {}) } });
  const at = new AccessToken(API_KEY, API_SECRET, {
    identity: user.id, name: user.name, ttl: '6h',
  });
  at.addGrant({
    room: channel.id,
    roomJoin: true,
    canSubscribe: true,
    canUpdateOwnMetadata: true,
    ...publishGrant(perms),
  });
  const host = (req.headers.host || 'localhost').replace(/:\d+$/, '');
  // Modo local (sem LIVEKIT_URL): o LiveKit escuta só em 127.0.0.1
  return { token: await at.toJwt(), url: LIVEKIT_URL || `ws://${host === 'localhost' ? '127.0.0.1' : host}:7880` };
}

// ---------- Quem está em cada canal de voz (consulta o LiveKit) ----------

let voiceState = {}; // channelId -> [{ id, name, muted, deafened, camera, streaming }]
let voiceErrorLogged = false;

// Em qual canal de voz a pessoa está agora (ou null)
export function voiceChannelOf(userId) {
  for (const [channelId, people] of Object.entries(voiceState)) if (people.some((p) => p.id === userId)) return channelId;
  return null;
}
export const voicePeople = (channelId) => voiceState[channelId] ?? [];
export const voiceAll = () => voiceState;

// cache: os servidores já montados nesta rodada (o aviso vai para todo mundo de uma vez)
export function voiceFor(userId, cache = new Map()) {
  const out = {};
  for (const serverId of db.serverIdsOf({ id: userId })) {
    if (!cache.has(serverId)) cache.set(serverId, db.snapshot(serverId));
    const snap = cache.get(serverId);
    // Canal de voz privado sem acesso: nem aparece quem está lá dentro
    for (const c of snap?.channels ?? []) if (c.type === 'voice' && canSeeChannel(snap, userId, c)) out[c.id] = voiceState[c.id] ?? [];
  }
  return out;
}

// Consulta periódica + consulta imediata quando alguém avisa que mudou algo (entrou, saiu, mutou, live...)
let pollTimer = null;
let polling = false;
let pollAgain = false;
export function scheduleVoicePoll(delay) {
  if (polling) { pollAgain = true; return; }
  clearTimeout(pollTimer);
  pollTimer = setTimeout(pollVoice, delay);
}

export async function pollVoice() {
  polling = true;
  try {
    const next = {};
    const ids = db.voiceChannels().map((c) => c.id);
    const rooms = ids.length ? await roomService.listRooms(ids) : [];
    for (const r of rooms) {
      // Não confia no contador numParticipants: o LiveKit atualiza com atraso e a sala parecia vazia
      const participants = await roomService.listParticipants(r.name);
      if (!participants.length) continue;
      next[r.name] = participants
        .sort((a, b) => Number(a.joinedAt) - Number(b.joinedAt))
        .map((p) => {
          const has = (source, unmuted) => p.tracks.some((t) => t.source === source && (!unmuted || !t.muted));
          return {
            id: p.identity,
            name: p.name,
            muted: !has(TrackSource.MICROPHONE, true),
            deafened: p.attributes?.deafened === '1',
            camera: has(TrackSource.CAMERA, true),
            streaming: has(TrackSource.SCREEN_SHARE),
          };
        });
    }
    if (JSON.stringify(next) !== JSON.stringify(voiceState)) {
      voiceState = next;
      const cache = new Map();
      for (const id of sockets.keys()) sendToUser(id, { t: 'voice', voice: voiceFor(id, cache) });
    }
    voiceErrorLogged = false;
  } catch (err) {
    if (!voiceErrorLogged) console.error('Falha ao consultar o LiveKit:', err.message);
    voiceErrorLogged = true;
  } finally {
    polling = false;
    const soon = pollAgain;
    pollAgain = false;
    scheduleVoicePoll(soon ? 100 : VOICE_POLL_MS);
  }
}

// Aplica as permissões atuais a quem já está na voz (ex.: perdeu o cargo que permitia transmitir)
export async function syncVoicePermissions(serverId) {
  const snap = db.snapshot(serverId);
  if (!snap) return;
  for (const ch of snap.channels.filter((c) => c.type === 'voice')) {
    for (const p of voiceState[ch.id] ?? []) {
      const perms = snap.members.some((m) => m.id === p.id) ? computePerms(snap, p.id) : 0;
      try {
        if (!can(perms, PERMS.CONNECT)) await roomService.removeParticipant(ch.id, p.id);
        else await roomService.updateParticipant(ch.id, p.id, { permission: { canSubscribe: true, ...publishGrant(perms) } });
      } catch (err) {
        console.error('Não foi possível atualizar a voz de', p.name, err.message);
      }
    }
  }
}

// Trocou de nome: quem está numa chamada com a pessoa vê o nome novo na hora
export function renameInVoice(userId, name) {
  for (const ch of db.voiceChannels()) {
    if (db.isMember(ch.server_id, userId)) roomService.updateParticipant(ch.id, userId, { name }).catch(() => {});
  }
}

export async function closeVoiceRoom(channelId) {
  try { await roomService.deleteRoom(channelId); } catch {}
}
