// Ações de servidor: criar, editar, excluir, sair e convites
import { LIMITS } from '../config.js';
import { db, HOME_SERVER } from '../store.js';
import { sendToUser, sendToServer, pushServer } from '../realtime.js';
import { requireServer, requirePerm } from '../guards.js';
import { voiceFor, syncVoicePermissions, closeVoiceRoom } from '../voice.js';
import { music, leaveMusicOf } from '../music-rooms.js';
import { removeEmojiFile } from '../emojis.js';
import { removeImage } from '../images.js';
import { fail, clean, validColor } from '../util.js';
import { announceJoin, announceLeave } from '../welcome.js';
import { serverViewFor, PERMS, can } from '../../public/js/permissions.js';
import { SYSTEM } from '../../db.js';

const HOUR = 3_600_000;
export const INVITE_EXPIRY = [HOUR / 2, HOUR, 24 * HOUR, 7 * 24 * HOUR, null]; // null = nunca vence

// Manda um servidor recém-aberto para a pessoa (e já seleciona ele)
function openServerFor(userId, serverId) {
  sendToUser(userId, { t: 'server', server: serverViewFor(db.snapshot(serverId), userId), select: true });
  sendToUser(userId, { t: 'voice', voice: voiceFor(userId) });
}

// Excluir um servidor (pelo dono no site ou pelo painel administrativo)
export async function deleteServerNow(snap) {
  if (snap.id === HOME_SERVER) fail('O servidor principal não pode ser excluído.');
  for (const ch of snap.channels.filter((c) => c.type === 'music')) music.dropChannel(ch.id);
  const emojiIds = db.emojiIds(snap.id);
  db.deleteServer(snap.id);
  for (const id of emojiIds) removeEmojiFile(id);
  removeImage(snap.icon);
  for (const mem of snap.members) sendToUser(mem.id, { t: 'server:removed', serverId: snap.id, reason: 'O servidor foi excluído.' });
  for (const ch of snap.channels.filter((c) => c.type === 'voice')) await closeVoiceRoom(ch.id);
}

// Passar a posse para outro membro. fromId: quem passou (null = pelo painel administrativo, sem limite
// de servidores por dono: é o jeito de resolver servidor sem dono ou dono que sumiu)
export async function transferServer(snap, targetId, { fromId = null } = {}) {
  if (snap.kind === 'dm') fail('Conversa privada não tem dono.');
  const target = snap.members.find((x) => x.id === targetId);
  if (!target || target.id === snap.ownerId) fail('Escolha um membro do servidor que não seja o dono atual.');
  const next = db.userById(target.id);
  if (fromId && db.ownedCount(next) >= LIMITS.serversOwned) fail(`${target.name} já é dono do máximo de ${LIMITS.serversOwned} servidores.`);
  db.setOwner(snap.id, next);
  pushServer(snap.id);
  await syncVoicePermissions(snap.id); // o novo dono ganha tudo na voz na hora
  const text = snap.channels.find((c) => c.id === snap.welcome?.channelId && c.type === 'text') ?? snap.channels.find((c) => c.type === 'text');
  const say = fromId ? `<@${fromId}> passou a posse do servidor para <@${target.id}>.` : `A administração passou a posse do servidor para <@${target.id}>.`;
  if (text) sendToServer(snap.id, { t: 'msg', msg: db.addSystemMessage(text.id, say, SYSTEM.owner) });
}

// Renomear (pelo painel administrativo; no site é o server:update)
export function renameServer(snap, name) {
  if (snap.kind === 'dm') fail('Conversa privada não tem nome de servidor.');
  const clean_ = clean(name, LIMITS.serverName);
  if (!clean_) fail('Dê um nome ao servidor.');
  db.updateServer(snap.id, { name: clean_, color: snap.color });
  pushServer(snap.id);
  return clean_;
}

export default {
  'server:create'(user, m) {
    const name = clean(m.name, LIMITS.serverName);
    if (!name) fail('Dê um nome ao servidor.');
    if (db.ownedCount(user) >= LIMITS.serversOwned) fail(`Você já criou o máximo de ${LIMITS.serversOwned} servidores.`);
    openServerFor(user.id, db.createServer({ name, owner: user }));
  },

  'server:update'(user, m) {
    const ctx = requireServer(user, m.serverId);
    requirePerm(ctx, PERMS.MANAGE_SERVER);
    const name = clean(m.name, LIMITS.serverName) || ctx.snap.name;
    const color = validColor(m.color) ?? ctx.snap.color;
    db.updateServer(ctx.snap.id, { name, color });
    pushServer(ctx.snap.id);
  },

  // Ordem dos servidores na coluna da esquerda (só para a própria pessoa; vale em todos os aparelhos dela)
  'servers:order'(user, m) {
    const mine = new Set(db.serverIdsOf(user));
    const ids = [...new Set((Array.isArray(m.ids) ? m.ids : []).map(String))].filter((id) => mine.has(id)).slice(0, 200);
    db.setServerOrder(user.id, ids);
    sendToUser(user.id, { t: 'servers:order', ids }); // as outras abas e aparelhos também reorganizam
  },

  async 'server:delete'(user, m) {
    const ctx = requireServer(user, m.serverId);
    if (ctx.snap.ownerId !== user.id) fail('Só o dono pode excluir o servidor.');
    await deleteServerNow(ctx.snap);
  },

  // Passar a posse do servidor para outro membro (só o dono; o servidor principal fica de fora).
  // Quem era dono continua no servidor, com os cargos que já tinha.
  async 'server:transfer'(user, m) {
    const ctx = requireServer(user, m.serverId);
    if (ctx.snap.kind === 'dm') fail('Conversa privada não tem dono.');
    if (ctx.snap.id === HOME_SERVER) fail('O dono do servidor principal só muda pelo painel.');
    if (ctx.snap.ownerId !== user.id) fail('Só o dono pode passar a posse do servidor.');
    if (!ctx.snap.members.some((x) => x.id === m.userId) || m.userId === user.id) fail('Membro não encontrado.');
    await transferServer(ctx.snap, m.userId, { fromId: user.id });
  },

  async 'server:leave'(user, m) {
    const ctx = requireServer(user, m.serverId);
    if (ctx.snap.ownerId === user.id) fail('O dono não pode sair do próprio servidor (exclua-o ou transfira).');
    if (ctx.snap.kind === 'dj') fail('As salas de DJ são de todo mundo: é só não entrar.');
    if (ctx.snap.kind === 'dm' && ctx.snap.members.length <= 2) fail('Conversa com uma pessoa não dá para sair; dá para esconder.');
    leaveMusicOf(ctx.snap.id, user.id);
    db.removeMember(ctx.snap.id, user.id);
    sendToUser(user.id, { t: 'server:removed', serverId: ctx.snap.id, reason: null });
    pushServer(ctx.snap.id);
    if (ctx.snap.kind !== 'dm') announceLeave(ctx.snap.id, user);
    await syncVoicePermissions(ctx.snap.id);
  },

  // Silenciar um canal ou servidor (só para você): sem destaque, sem som e sem notificação
  'mute:set'(user, m) {
    const target = String(m.target ?? '');
    const channel = db.channel(target);
    const serverId = channel ? channel.server_id : target;
    requireServer(user, serverId);
    db.setMute(user.id, target, !!m.muted);
    sendToUser(user.id, { t: 'mutes', mutes: db.mutes(user.id) });
  },

  // Validade (30 min a 7 dias, ou nunca) e limite de usos (1 a 100, ou sem limite)
  'invite:create'(user, m) {
    const ctx = requireServer(user, m.serverId);
    requirePerm(ctx, PERMS.CREATE_INVITE, 'Você não tem permissão para criar convites.');
    const expiresIn = INVITE_EXPIRY.includes(m.expiresIn) ? m.expiresIn : INVITE_EXPIRY[3];
    const maxUses = Number.isInteger(m.maxUses) && m.maxUses >= 1 && m.maxUses <= 100 ? m.maxUses : null;
    const code = db.createInvite(ctx.snap.id, user, { expiresIn, maxUses });
    return { t: 'invite', serverId: ctx.snap.id, code, expiresIn, maxUses };
  },

  // Convites ativos do servidor (quem gerencia vê todos; quem só convida vê os seus)
  'invites:list'(user, m) {
    const ctx = requireServer(user, m.serverId);
    requirePerm(ctx, PERMS.CREATE_INVITE, 'Você não tem permissão para ver convites.');
    const all = db.invitesOf(ctx.snap.id);
    const manage = can(ctx.perms, PERMS.MANAGE_SERVER);
    return { t: 'invites', serverId: ctx.snap.id, invites: manage ? all : all.filter((i) => i.by === user.id) };
  },

  'invite:revoke'(user, m) {
    const row = db.inviteRow(m.code);
    if (!row) fail('Convite não encontrado.');
    const ctx = requireServer(user, row.server_id);
    if (`u${row.created_by}` !== user.id) requirePerm(ctx, PERMS.MANAGE_SERVER, 'Só quem criou (ou gerencia o servidor) cancela o convite.');
    db.deleteInvite(row.code);
  },

  'invite:accept'(user, m) {
    const info = db.invite(m.code);
    if (!info) fail('Convite inválido ou expirado.');
    if (!db.isMember(info.serverId, user.id)) {
      db.addMember(info.serverId, user);
      db.useInvite(info.code);
      pushServer(info.serverId);
      openServerFor(user.id, info.serverId);
      announceJoin(info.serverId, user);
      return;
    }
    openServerFor(user.id, info.serverId);
  },

  // Mensagem direta: com uma pessoa (reaproveita a conversa que já existe) ou em grupo (até 10 pessoas).
  // Só com quem está em algum servidor em comum com você.
  'dm:open'(user, m) {
    const ids = [...new Set((Array.isArray(m.userIds) ? m.userIds : []).map(String))].filter((id) => id !== user.id).slice(0, 9);
    if (!ids.length) fail('Escolha com quem conversar.');
    const people = ids.map((id) => db.userById(id));
    if (people.some((p) => !p) || !ids.every((id) => db.shareServer(user.id, id) || db.friendship(user.id, id) === 'friend')) {
      fail('Você só pode conversar com amigos ou com quem está num servidor com você.');
    }
    let serverId = ids.length === 1 ? db.findDm(user.id, ids[0]) : null;
    if (!serverId) {
      const name = ids.length === 1 ? null : clean([user, ...people].map((p) => p.name).join(', '), LIMITS.serverName);
      serverId = db.createDm([user, ...people], { name });
      pushServer(serverId); // os outros já veem a conversa na lista
    }
    openServerFor(user.id, serverId);
  },

  // Grupo (conversa com 3 ou mais): qualquer pessoa do grupo dá o nome que quiser; vazio volta aos nomes das pessoas
  'dm:rename'(user, m) {
    const ctx = requireServer(user, m.serverId);
    if (ctx.snap.kind !== 'dm' || ctx.snap.members.length < 3) fail('Só grupos podem ter nome.');
    const name = clean(m.name, 40);
    if ((ctx.snap.dmName ?? '') === name) return;
    db.setDmName(ctx.snap.id, name);
    pushServer(ctx.snap.id);
    const text = ctx.snap.channels.find((c) => c.type === 'text');
    if (text) {
      const say = name ? `<@${user.id}> mudou o nome do grupo para “${name}”.` : `<@${user.id}> tirou o nome do grupo.`;
      sendToServer(ctx.snap.id, { t: 'msg', msg: db.addSystemMessage(text.id, say, SYSTEM.rename) });
    }
  },

  // Avisos automáticos: entrada/saída (texto com {user} e {server}) e salas de jogo abertas
  'server:welcome'(user, m) {
    const ctx = requireServer(user, m.serverId);
    requirePerm(ctx, PERMS.MANAGE_SERVER);
    const channel = ctx.snap.channels.find((c) => c.id === m.channelId && c.type === 'text');
    const text = (raw, fallback) => String(raw ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 200) || fallback;
    db.setWelcome(ctx.snap.id, {
      on: !!m.on,
      channelId: channel?.id ?? null,
      joinText: text(m.joinText, ctx.snap.welcome.joinText),
      leaveText: text(m.leaveText, ctx.snap.welcome.leaveText),
      gameAnnounce: !!m.gameAnnounce,
    });
    pushServer(ctx.snap.id);
  },
};
