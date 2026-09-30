// Ações de servidor: criar, editar, excluir, sair e convites
import { LIMITS } from '../config.js';
import { db, HOME_SERVER } from '../store.js';
import { sendToUser, sendToServer, pushServer } from '../realtime.js';
import { requireServer, requirePerm } from '../guards.js';
import { voiceFor, syncVoicePermissions, closeVoiceRoom } from '../voice.js';
import { music, leaveMusicOf } from '../music-rooms.js';
import { removeEmojiFile } from '../emojis.js';
import { removeImage } from '../images.js';
import { removeSoundFile } from '../soundboard.js';
import { fail, clean, validColor } from '../util.js';
import { announceJoin, announceLeave } from '../welcome.js';
import { serverViewFor, PERMS, can } from '../../public/js/permissions.js';
import { SYSTEM } from '../../db.js';
import { cleanFilter } from '../word-filter.js';

const HOUR = 3_600_000;
export const INVITE_EXPIRY = [HOUR / 2, HOUR, 24 * HOUR, 7 * 24 * HOUR, null]; // null = nunca vence

// Manda um servidor recém-aberto para a pessoa (e já seleciona ele)
function openServerFor(userId, serverId) {
  sendToUser(userId, { t: 'server', server: serverViewFor(db.snapshot(serverId), userId), select: true });
  sendToUser(userId, { t: 'voice', voice: voiceFor(userId) });
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

  // Filtro de palavras: lista (uma por linha) e o que fazer (bloquear a mensagem ou trocar por ***)
  'server:filter'(user, m) {
    const ctx = requireServer(user, m.serverId);
    if (ctx.snap.kind === 'dm') fail('Conversa privada não tem filtro.');
    requirePerm(ctx, PERMS.MANAGE_SERVER, 'Você não tem permissão para mudar o filtro de palavras.');
    db.setWordFilter(ctx.snap.id, cleanFilter(m.words, m.mode));
    pushServer(ctx.snap.id);
  },

  async 'server:delete'(user, m) {
    const ctx = requireServer(user, m.serverId);
    if (ctx.snap.ownerId !== user.id) fail('Só o dono pode excluir o servidor.');
    if (ctx.snap.id === HOME_SERVER) fail('O servidor principal não pode ser excluído.');
    for (const ch of ctx.snap.channels.filter((c) => c.type === 'music')) music.dropChannel(ch.id);
    const emojiIds = db.emojiIds(ctx.snap.id);
    const soundIds = db.soundIds(ctx.snap.id);
    db.deleteServer(ctx.snap.id);
    for (const id of emojiIds) removeEmojiFile(id);
    for (const id of soundIds) removeSoundFile(id);
    removeImage(ctx.snap.icon);
    for (const mem of ctx.snap.members) sendToUser(mem.id, { t: 'server:removed', serverId: ctx.snap.id, reason: 'O servidor foi excluído.' });
    for (const ch of ctx.snap.channels.filter((c) => c.type === 'voice')) await closeVoiceRoom(ch.id);
  },

  async 'server:leave'(user, m) {
    const ctx = requireServer(user, m.serverId);
    if (ctx.snap.ownerId === user.id) fail('O dono não pode sair do próprio servidor (exclua-o ou transfira).');
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
