// Ações de canais e categorias: criar, renomear, configurar, organizar e excluir
import { LIMITS } from '../config.js';
import { db } from '../store.js';
import { VOICE_BITRATE, VOICE_LIMIT_MAX } from '../../db.js';
import { pushServer } from '../realtime.js';
import { requireServer, requirePerm, requireCategory, requireChannelView } from '../guards.js';
import { closeVoiceRoom, voicePeople, roomService } from '../voice.js';
import { music } from '../music-rooms.js';
import { fail, clean, textChannelName } from '../util.js';
import { PERMS, canSeeChannel } from '../../public/js/permissions.js';

const channelName = (type, raw) => (type === 'text' ? textChannelName(raw) : clean(raw, LIMITS.channelName));

// Canal de um servidor da pessoa, com "Gerenciar canais"
function manageChannel(user, channelId, message) {
  const channel = db.channel(channelId);
  if (!channel) fail('Canal não encontrado.');
  const ctx = requireServer(user, channel.server_id);
  requireChannelView(ctx, user.id, channel.id);
  requirePerm(ctx, PERMS.MANAGE_CHANNELS, message);
  return { channel, ctx };
}

export const SLOWMODE_CHOICES = [0, 5, 10, 30, 60, 120, 300, 600, 900, 3600];

function manageCategory(user, categoryId, message) {
  const cat = db.category(categoryId);
  if (!cat) fail('Categoria não encontrada.');
  const ctx = requireServer(user, cat.server_id);
  requirePerm(ctx, PERMS.MANAGE_CHANNELS, message);
  return { cat, ctx };
}

export default {
  'channel:create'(user, m) {
    const ctx = requireServer(user, m.serverId);
    requirePerm(ctx, PERMS.MANAGE_CHANNELS, 'Você não tem permissão para criar canais.');
    const type = ['voice', 'music'].includes(m.type) ? m.type : 'text';
    const name = channelName(type, m.name);
    if (!name) fail('Dê um nome ao canal.');
    if (db.countChannels(ctx.snap.id, type) >= LIMITS.channelsPerType) fail(`Limite de ${LIMITS.channelsPerType} canais desse tipo.`);
    const categoryId = m.categoryId ? requireCategory(ctx, m.categoryId).id : null;
    const id = db.createChannel({ serverId: ctx.snap.id, type, name, categoryId });
    pushServer(ctx.snap.id);
    return { t: 'channel:created', serverId: ctx.snap.id, channelId: id, type };
  },

  // Tópico: uma frase no topo do canal dizendo para que ele serve
  'channel:topic'(user, m) {
    const { channel, ctx } = manageChannel(user, m.channelId, 'Você não tem permissão para editar canais.');
    db.setTopic(channel.id, clean(m.topic, 160));
    pushServer(ctx.snap.id);
  },

  'channel:rename'(user, m) {
    const { channel, ctx } = manageChannel(user, m.channelId, 'Você não tem permissão para editar canais.');
    const name = channelName(channel.type, m.name);
    if (!name) fail('Dê um nome ao canal.');
    db.renameChannel(channel.id, name);
    pushServer(ctx.snap.id);
  },

  async 'channel:delete'(user, m) {
    const { channel, ctx } = manageChannel(user, m.channelId, 'Você não tem permissão para excluir canais.');
    db.deleteChannel(channel.id);
    pushServer(ctx.snap.id);
    if (channel.type === 'voice') await closeVoiceRoom(channel.id);
    if (channel.type === 'music') music.dropChannel(channel.id);
  },

  // Configurações do canal de voz: nome, qualidade do áudio e limite de pessoas
  'channel:settings'(user, m) {
    const { channel, ctx } = manageChannel(user, m.channelId, 'Você não tem permissão para editar canais.');
    if (channel.type !== 'voice') fail('Canal não encontrado.');
    const name = clean(m.name, LIMITS.channelName);
    if (!name) fail('Dê um nome ao canal.');
    const kbps = Math.round(Number(m.bitrate) / 8) * 8;
    if (!(kbps >= VOICE_BITRATE.min && kbps <= VOICE_BITRATE.max)) fail(`A qualidade vai de ${VOICE_BITRATE.min} a ${VOICE_BITRATE.max} kbps.`);
    const limit = m.userLimit === undefined ? null : Number(m.userLimit);
    if (limit !== null && !(Number.isInteger(limit) && limit >= 0 && limit <= VOICE_LIMIT_MAX)) fail(`O limite vai de 0 (sem limite) a ${VOICE_LIMIT_MAX} pessoas.`);
    db.renameChannel(channel.id, name);
    db.setChannelBitrate(channel.id, kbps);
    if (limit !== null) db.setChannelLimit(channel.id, limit);
    pushServer(ctx.snap.id);
  },

  // Canal privado: só os cargos escolhidos enxergam e entram (dono e administradores sempre).
  // Quem perdeu o acesso sai na hora da voz e da música daquele canal.
  async 'channel:privacy'(user, m) {
    const { channel, ctx } = manageChannel(user, m.channelId, 'Você não tem permissão para editar canais.');
    if (ctx.snap.kind === 'dm') fail('Conversa privada já é privada.');
    const isPrivate = m.private === true;
    const roleIds = isPrivate ? [...new Set((Array.isArray(m.roleIds) ? m.roleIds : []).map(String))].filter((id) => ctx.snap.roles.some((r) => r.id === id && !r.isDefault)) : [];
    db.setChannelPrivacy(channel.id, isPrivate, roleIds);
    pushServer(ctx.snap.id);
    if (!isPrivate) return;
    const snap = db.snapshot(ctx.snap.id);
    const ch = snap.channels.find((c) => c.id === channel.id);
    if (channel.type === 'voice') {
      for (const p of voicePeople(channel.id)) if (!canSeeChannel(snap, p.id, ch)) await roomService.removeParticipant(channel.id, p.id).catch(() => {});
    }
    if (channel.type === 'music') for (const id of music.listenersOf(channel.id)) if (!canSeeChannel(snap, id, ch)) music.leave(channel.id, id);
  },

  // Modo lento: cada pessoa manda 1 mensagem a cada N segundos (0 desliga). Quem gerencia mensagens não espera.
  'channel:slowmode'(user, m) {
    const { channel, ctx } = manageChannel(user, m.channelId, 'Você não tem permissão para editar canais.');
    if (channel.type === 'voice') fail('Modo lento é só para canais com chat.');
    const seconds = Number(m.seconds);
    if (!SLOWMODE_CHOICES.includes(seconds)) fail('Tempo inválido.');
    db.setChannelSlowmode(channel.id, seconds);
    pushServer(ctx.snap.id);
  },

  // Arrastar um canal: muda de categoria (ou sai de todas, com categoryId null) e/ou de posição
  'channel:move'(user, m) {
    const { channel, ctx } = manageChannel(user, m.channelId, 'Você não tem permissão para organizar canais.');
    const categoryId = m.categoryId ? requireCategory(ctx, m.categoryId).id : null;
    db.moveChannel(channel, categoryId, Number(m.index) || 0);
    pushServer(ctx.snap.id);
  },

  'category:create'(user, m) {
    const ctx = requireServer(user, m.serverId);
    requirePerm(ctx, PERMS.MANAGE_CHANNELS, 'Você não tem permissão para criar categorias.');
    const name = clean(m.name, LIMITS.channelName);
    if (!name) fail('Dê um nome à categoria.');
    if (db.countCategories(ctx.snap.id) >= LIMITS.categories) fail(`Limite de ${LIMITS.categories} categorias.`);
    const id = db.createCategory(ctx.snap.id, name);
    pushServer(ctx.snap.id);
    return { t: 'category:created', serverId: ctx.snap.id, categoryId: id };
  },

  'category:rename'(user, m) {
    const { cat, ctx } = manageCategory(user, m.categoryId, 'Você não tem permissão para editar categorias.');
    const name = clean(m.name, LIMITS.channelName);
    if (!name) fail('Dê um nome à categoria.');
    db.renameCategory(cat.id, name);
    pushServer(ctx.snap.id);
  },

  'category:delete'(user, m) {
    const { cat, ctx } = manageCategory(user, m.categoryId, 'Você não tem permissão para excluir categorias.');
    db.deleteCategory(cat);
    pushServer(ctx.snap.id);
  },

  'category:move'(user, m) {
    const { cat, ctx } = manageCategory(user, m.categoryId, 'Você não tem permissão para organizar categorias.');
    db.moveCategory(cat, Number(m.index) || 0);
    pushServer(ctx.snap.id);
  },
};
