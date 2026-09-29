// Ações do painel administrativo sobre quem usa o Muvuca: desconectar ou bloquear uma conta, bloquear um IP
// e o modo manutenção (aviso para todo mundo e, se quiser, acesso travado para todos menos o dono).
import { db, HOME_SERVER } from './store.js';
import { sockets, send, broadcastPresence } from './realtime.js';
import { roomService, voiceChannelOf } from './voice.js';
import { uid } from '../db.js';

// ---------- IPs bloqueados (consultados em todo pedido: ficam em memória) ----------

const normIp = (ip) => String(ip ?? '').trim().replace(/^::ffff:/, '').toLowerCase();
let blockedIps = new Set(db.blockedIps().map((r) => normIp(r.ip)));
const LOOPBACK = new Set(['127.0.0.1', '::1', '']);
export const ipBlocked = (ip) => { const n = normIp(ip); return !LOOPBACK.has(n) && blockedIps.has(n); };

const ownerId = () => { const o = db.server(HOME_SERVER)?.owner_id; return o ? uid(o) : null; };

// Fecha as abas/apps de uma pessoa (com o aviso que aparece para ela) e tira da call
function kick(userId, code, message) {
  for (const ws of sockets.get(userId) ?? []) {
    send(ws, { t: 'error', code, message });
    try { ws.close(); } catch { /* já fechada */ }
  }
  const channel = voiceChannelOf(userId);
  if (channel) roomService.removeParticipant(channel, userId).catch(() => {});
}

export function disconnectUser(userId) {
  if (!db.userById(userId)) throw new Error('Conta não encontrada.');
  const sessions = db.deleteUserSessions(userId);
  kick(userId, 'auth', 'Você foi desconectado pelo administrador. Entre de novo.');
  broadcastPresence();
  return { sessions };
}

export function blockUser(userId, block, reason = '') {
  if (!db.userById(userId)) throw new Error('Conta não encontrada.');
  if (block && userId === ownerId()) throw new Error('A conta do dono não pode ser bloqueada.');
  db.setBlocked(userId, block ? String(reason || 'bloqueada pelo administrador').slice(0, 200) : null);
  if (!block) return { ok: true };
  const sessions = db.deleteUserSessions(userId);
  kick(userId, 'auth', 'Sua conta foi bloqueada. Fale com o dono do servidor.');
  broadcastPresence();
  return { ok: true, sessions };
}

export function blockIp(ip, block, reason = '') {
  const n = normIp(ip);
  if (!/^[0-9a-f:.]{3,45}$/.test(n) || LOOPBACK.has(n)) throw new Error('IP inválido.');
  if (block) db.blockIp(n, String(reason || '').slice(0, 200) || null);
  else db.unblockIp(n);
  blockedIps = new Set(db.blockedIps().map((r) => normIp(r.ip)));
  let closed = 0;
  if (block) {
    for (const [userId, set] of sockets) {
      for (const ws of set) {
        if (normIp(ws.ip) !== n) continue;
        send(ws, { t: 'error', code: 'blocked', message: 'Acesso bloqueado.' });
        try { ws.close(); } catch { /* já fechada */ }
        closed++;
        const channel = voiceChannelOf(userId);
        if (channel) roomService.removeParticipant(channel, userId).catch(() => {});
      }
    }
  }
  return { ok: true, closed };
}

// ---------- Modo manutenção ----------

let maint = (() => { try { return JSON.parse(db.meta('maintenance') ?? 'null') ?? { on: false }; } catch { return { on: false }; } })();
export const maintenance = () => (maint.on ? { on: true, message: maint.message, lock: !!maint.lock, until: maint.until ?? null } : { on: false });
export const lockedOut = (userId) => maint.on && maint.lock && userId !== ownerId();

export function setMaintenance({ on, message, lock, minutes }) {
  maint = on
    ? { on: true, message: String(message || 'O Muvuca vai passar por uma manutenção rápida.').replace(/\s+/g, ' ').trim().slice(0, 200), lock: !!lock, until: Number(minutes) > 0 ? Date.now() + Math.min(Number(minutes), 24 * 60) * 60_000 : null, at: Date.now() }
    : { on: false };
  db.setMeta('maintenance', JSON.stringify(maint));
  const msg = { t: 'maintenance', maintenance: maintenance() };
  let closed = 0;
  for (const [userId, set] of sockets) {
    for (const ws of set) {
      if (lockedOut(userId)) {
        send(ws, { t: 'error', code: 'maintenance', message: maint.message });
        try { ws.close(); } catch { /* já fechada */ }
        closed++;
      } else {
        send(ws, msg);
      }
    }
  }
  if (closed) broadcastPresence();
  return { ...maintenance(), closed };
}
