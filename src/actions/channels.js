// Ações de canais e categorias: criar, renomear, configurar, organizar e excluir
import { LIMITS } from '../config.js';
import { db } from '../store.js';
import { VOICE_BITRATE } from '../../db.js';
import { pushServer } from '../realtime.js';
import { requireServer, requirePerm, requireCategory } from '../guards.js';
import { closeVoiceRoom } from '../voice.js';
import { music } from '../music-rooms.js';
import { fail, clean, textChannelName } from '../util.js';
import { PERMS } from '../../public/js/permissions.js';

const channelName = (type, raw) => (type === 'text' ? textChannelName(raw) : clean(raw, LIMITS.channelName));

// Canal de um servidor da pessoa, com "Gerenciar canais"
function manageChannel(user, channelId, message) {
  const channel = db.channel(channelId);
  if (!channel) fail('Canal não encontrado.');
  const ctx = requireServer(user, channel.server_id);
  requirePerm(ctx, PERMS.MANAGE_CHANNELS, message);
  return { channel, ctx };
}

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

  // Configurações do canal de voz: nome e qualidade do áudio
  'channel:settings'(user, m) {
    const { channel, ctx } = manageChannel(user, m.channelId, 'Você não tem permissão para editar canais.');
    if (channel.type !== 'voice') fail('Canal não encontrado.');
    const name = clean(m.name, LIMITS.channelName);
    if (!name) fail('Dê um nome ao canal.');
    const kbps = Math.round(Number(m.bitrate) / 8) * 8;
    if (!(kbps >= VOICE_BITRATE.min && kbps <= VOICE_BITRATE.max)) fail(`A qualidade vai de ${VOICE_BITRATE.min} a ${VOICE_BITRATE.max} kbps.`);
    db.renameChannel(channel.id, name);
    db.setChannelBitrate(channel.id, kbps);
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
