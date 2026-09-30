// Ações do painel administrativo sobre quem usa o Muvuca: desconectar ou bloquear uma conta, bloquear um IP
// e o modo manutenção (aviso para todo mundo e, se quiser, acesso travado para todos menos o dono).
import { db, HOME_SERVER } from './store.js';
import { sockets, send, sendToUser, broadcastPresence, sendToServer, pushServer } from './realtime.js';
import { leaveMusicOf } from './music-rooms.js';
import { removeImage } from './images.js';
import { removeEmojiFile } from './emojis.js';
import { removeSoundFile } from './soundboard.js';
import { removeFiles } from './attachments.js';
import { roomService, voiceAll, baseUserId } from './voice.js';
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
  removeFromVoice(userId);
}

// Tira da call a conta em todos os aparelhos (o principal e o 2º)
function removeFromVoice(userId) {
  for (const [channel, people] of Object.entries(voiceAll())) {
    for (const p of people) if (baseUserId(p.id) === userId) roomService.removeParticipant(channel, p.id).catch(() => {});
  }
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
        removeFromVoice(userId);
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

// ---------- Moderação de conteúdo (painel) ----------
// Conversa privada nunca: o painel não mostra nem apaga nada de lá.

const isDm = (serverId) => db.server(serverId)?.kind === 'dm';

export function adminDeleteMessage(id) {
  const row = db.messageRow(Number(id));
  if (!row) throw new Error('Mensagem não encontrada (talvez já tenha sido apagada).');
  if (isDm(row.server_id)) throw new Error('Mensagem de conversa privada não pode ser apagada pelo painel.');
  const files = db.filesOfMessage(row.id);
  db.deleteMessage(row.id);
  removeFiles(files).catch(() => {});
  sendToServer(row.server_id, { t: 'msg:delete', channel: row.channel_id, id: row.id });
  return { ok: true, files: files.length };
}

// Apaga só o anexo; se a mensagem ficar sem texto e sem anexos, apaga a mensagem também
export async function adminDeleteFile(fileId) {
  const f = /^f-[0-9a-f]{16}$/.test(String(fileId)) ? db.file(fileId) : null;
  if (!f) throw new Error('Anexo não encontrado (talvez já tenha sido apagado).');
  const channel = db.channel(f.channel_id);
  if (channel && isDm(channel.server_id)) throw new Error('Anexo de conversa privada não pode ser apagado pelo painel.');
  const row = f.message_id ? db.messageRow(f.message_id) : null;
  if (!row) {
    await removeFiles([f.id]);
    return { ok: true, message: 'removed' };
  }
  const rest = JSON.parse(row.attachments ?? '[]').filter((a) => a.id !== f.id);
  if (!rest.length && !String(row.text ?? '').trim()) {
    adminDeleteMessage(row.id);
    return { ok: true, message: 'deleted' };
  }
  const msg = db.setMessageAttachments(row.id, rest);
  await removeFiles([f.id]);
  sendToServer(row.server_id, { t: 'msg:edit', msg });
  return { ok: true, message: 'edited' };
}

// ---------- Conta (painel): senha temporária e exclusão ----------

// Senha temporária: vale para entrar uma vez; no primeiro login a pessoa escolhe a nova antes de usar o Muvuca.
// Todas as sessões caem na hora.
export async function resetPassword(userId, password) {
  if (!db.userById(userId)) throw new Error('Conta não encontrada.');
  const pw = String(password ?? '');
  if (pw.length < 6 || pw.length > 200) throw new Error('A senha temporária precisa ter pelo menos 6 caracteres.');
  await db.setPassword(userId, pw);
  db.setMustChange(userId, true);
  const sessions = db.deleteUserSessions(userId);
  kick(userId, 'auth', 'Sua senha foi trocada pelo administrador. Entre com a senha temporária que ele te passou.');
  broadcastPresence();
  return { ok: true, sessions };
}

// Exclui a conta e tudo dela (ver db.deleteAccount). O dono do servidor principal não pode ser excluído.
export async function deleteAccount(userId) {
  if (!db.userById(userId)) throw new Error('Conta não encontrada.');
  if (userId === ownerId()) throw new Error('A conta do dono do servidor principal não pode ser excluída.');
  kick(userId, 'auth', 'Sua conta foi excluída.');
  for (const sid of db.serverIdsOf({ id: userId })) leaveMusicOf(sid, userId);
  const r = db.deleteAccount(userId);
  // Arquivos no disco (anexos, foto, banner, e o que era dos servidores que sumiram)
  await removeFiles(r.files).catch(() => {});
  for (const id of [...r.images, ...r.icons]) await removeImage(id).catch(() => {});
  for (const id of r.emojis) await removeEmojiFile(id);
  for (const id of r.sounds) await removeSoundFile(id);
  // Quem ficou vê na hora: membro some, mensagens dela somem, conversas encerradas fecham
  for (const sid of r.affected) {
    pushServer(sid);
    sendToServer(sid, { t: 'user:purged', userId });
  }
  for (const d of r.deletedServers) {
    for (const m of d.members) sendToUser(m, { t: 'server:removed', serverId: d.id, reason: d.kind === 'dm' ? 'A conversa foi encerrada: a outra conta foi excluída.' : 'O servidor foi excluído.' });
  }
  for (const f of r.friends) sendToUser(f, { t: 'friends', friends: db.friendsOf(f) });
  broadcastPresence();
  return { ok: true, username: r.username, messages: r.messages, files: r.files.length, transferred: r.transferred, deletedServers: r.deletedServers.filter((d) => d.kind !== 'dm').length };
}
