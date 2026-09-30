// Ações de voz, música (cabine de DJ, fila, busca no YouTube) e GIFs
import { GIPHY_API_KEY } from '../config.js';
import { db } from '../store.js';
import { scheduleVoicePoll, voiceChannelOf, grantMove } from '../voice.js';
import { sendToUser } from '../realtime.js';
import { music, requireMusicChannel } from '../music-rooms.js';
import { createGifs } from '../../gifs.js';
import { requirePerm, requireServer } from '../guards.js';
import { fail, underLimit } from '../util.js';
import { PERMS, can } from '../../public/js/permissions.js';

const gifs = createGifs(GIPHY_API_KEY);
const musicSearchTimes = new Map(); // userId -> últimas buscas de música
const gifSearchTimes = new Map();   // userId -> últimas buscas de GIF

export default {
  // O site avisa que mudou algo na voz: consulta o LiveKit já, sem esperar a próxima rodada
  'voice:poke'() {
    scheduleVoicePoll(100);
  },

  // Mover alguém que está numa call para outro canal de voz do mesmo servidor (só aquela pessoa).
  // O aparelho dela troca de canal sozinho; o 2º aparelho da conta (se tiver) fica onde está.
  'voice:move'(user, m) {
    const to = db.channel(m.channelId);
    if (!to || to.type !== 'voice') fail('Canal de voz não encontrado.');
    const ctx = requireServer(user, to.server_id);
    if (ctx.snap.kind === 'dm') fail('Não dá para mover pessoas numa ligação de mensagem direta.');
    requirePerm(ctx, PERMS.MOVE_MEMBERS, 'Você não tem permissão para mover pessoas entre canais de voz.');
    const target = String(m.userId ?? '');
    const from = voiceChannelOf(target);
    if (!from || db.channel(from)?.server_id !== to.server_id) fail('Essa pessoa não está numa call deste servidor.');
    if (from === to.id) fail('Essa pessoa já está nesse canal.');
    grantMove(target, to.id);
    sendToUser(target, { t: 'voice:move', channelId: to.id, by: user.name });
  },

  // Relógio do servidor: o site mede a diferença para sincronizar a música
  time() {
    return { t: 'time', now: Date.now() };
  },

  'music:join'(user, m) {
    const { channel } = requireMusicChannel(user, m.channelId);
    music.join(channel.id, user.id);
    return { t: 'music:joined', channelId: channel.id, state: music.snapshot(channel.id), queue: music.queueOf(channel.id, user.id), recent: db.recentPlays(channel.id) };
  },

  'music:leave'(user, m) {
    const channel = db.channel(m.channelId);
    if (channel) music.leave(channel.id, user.id);
  },

  'music:booth'(user, m) {
    const { channel, perms } = requireMusicChannel(user, m.channelId);
    if (m.join) {
      if (!can(perms, PERMS.MUSIC_DJ)) fail('Você não tem permissão para tocar como DJ.');
      music.joinBooth(channel.id, user.id);
    } else music.leaveBooth(channel.id, user.id);
  },

  async 'music:add'(user, m) {
    const { channel } = requireMusicChannel(user, m.channelId);
    await music.add(channel.id, user.id, { videoId: m.videoId, url: m.url, title: m.title });
  },

  'music:remove'(user, m) {
    const { channel } = requireMusicChannel(user, m.channelId);
    music.removeFromQueue(channel.id, user.id, Number(m.index));
  },

  'music:move'(user, m) {
    const { channel } = requireMusicChannel(user, m.channelId);
    music.moveInQueue(channel.id, user.id, Number(m.from), Number(m.to));
  },

  'music:skip'(user, m) {
    const { channel, perms } = requireMusicChannel(user, m.channelId);
    music.skip(channel.id, user.id, can(perms, PERMS.MUSIC_MANAGE));
  },

  'music:kick'(user, m) {
    const ctx = requireMusicChannel(user, m.channelId);
    requirePerm(ctx, PERMS.MUSIC_MANAGE, 'Você não tem permissão para tirar pessoas da cabine.');
    music.kickFromBooth(ctx.channel.id, String(m.userId));
  },

  'music:ended'(user, m) {
    const { channel } = requireMusicChannel(user, m.channelId);
    music.ended(channel.id, user.id, String(m.videoId));
  },

  'music:error'(user, m) {
    const { channel } = requireMusicChannel(user, m.channelId);
    music.playerError(channel.id, user.id, String(m.videoId), Number(m.code));
  },

  'music:duration'(user, m) {
    const { channel } = requireMusicChannel(user, m.channelId);
    music.reportDuration(channel.id, user.id, String(m.videoId), Number(m.duration));
  },

  'music:react'(user, m) {
    const { channel } = requireMusicChannel(user, m.channelId);
    music.react(channel.id, user.id, String(m.kind));
  },

  async 'music:search'(user, m) {
    const q = String(m.q ?? '').trim().slice(0, 100);
    if (!q) return { t: 'music:results', results: [] };
    if (!underLimit(musicSearchTimes, user.id, 1, 1500)) fail('Espere um instante entre as buscas.');
    try {
      return { t: 'music:results', results: await music.youtube.search(q) };
    } catch (err) {
      fail(err.message);
    }
  },

  // GIFs (o site nunca vê a chave do Giphy)
  async 'gif:search'(user, m) {
    if (!underLimit(gifSearchTimes, user.id, 12, 10_000)) fail('Calma! Muitas buscas de GIF seguidas.');
    try {
      return { t: 'gif:results', ...(await gifs.search({ q: String(m.q ?? '').trim().slice(0, 50), offset: m.offset })) };
    } catch (err) {
      fail(err.message);
    }
  },

  async 'gif:home'() {
    try {
      return { t: 'gif:home', ...(await gifs.home()) };
    } catch (err) {
      fail(err.message);
    }
  },
};
