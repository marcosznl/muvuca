// Ações de servidor: criar, editar, excluir, sair e convites
import { LIMITS } from '../config.js';
import { db, HOME_SERVER } from '../store.js';
import { sendToUser, pushServer } from '../realtime.js';
import { requireServer, requirePerm } from '../guards.js';
import { voiceFor, syncVoicePermissions, closeVoiceRoom } from '../voice.js';
import { music, leaveMusicOf } from '../music-rooms.js';
import { removeEmojiFile } from '../emojis.js';
import { removeImage } from '../images.js';
import { fail, clean, validColor } from '../util.js';
import { announceJoin, announceLeave } from '../welcome.js';
import { PERMS } from '../../public/js/permissions.js';

// Manda um servidor recém-aberto para a pessoa (e já seleciona ele)
function openServerFor(userId, serverId) {
  sendToUser(userId, { t: 'server', server: db.snapshot(serverId), select: true });
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

  async 'server:delete'(user, m) {
    const ctx = requireServer(user, m.serverId);
    if (ctx.snap.ownerId !== user.id) fail('Só o dono pode excluir o servidor.');
    if (ctx.snap.id === HOME_SERVER) fail('O servidor principal não pode ser excluído.');
    for (const ch of ctx.snap.channels.filter((c) => c.type === 'music')) music.dropChannel(ch.id);
    const emojiIds = db.emojiIds(ctx.snap.id);
    db.deleteServer(ctx.snap.id);
    for (const id of emojiIds) removeEmojiFile(id);
    removeImage(ctx.snap.icon);
    for (const mem of ctx.snap.members) sendToUser(mem.id, { t: 'server:removed', serverId: ctx.snap.id, reason: 'O servidor foi excluído.' });
    for (const ch of ctx.snap.channels.filter((c) => c.type === 'voice')) await closeVoiceRoom(ch.id);
  },

  async 'server:leave'(user, m) {
    const ctx = requireServer(user, m.serverId);
    if (ctx.snap.ownerId === user.id) fail('O dono não pode sair do próprio servidor (exclua-o ou transfira).');
    leaveMusicOf(ctx.snap.id, user.id);
    db.removeMember(ctx.snap.id, user.id);
    sendToUser(user.id, { t: 'server:removed', serverId: ctx.snap.id, reason: null });
    pushServer(ctx.snap.id);
    announceLeave(ctx.snap.id, user);
    await syncVoicePermissions(ctx.snap.id);
  },

  'invite:create'(user, m) {
    const ctx = requireServer(user, m.serverId);
    requirePerm(ctx, PERMS.CREATE_INVITE, 'Você não tem permissão para criar convites.');
    return { t: 'invite', serverId: ctx.snap.id, code: db.createInvite(ctx.snap.id, user) };
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
