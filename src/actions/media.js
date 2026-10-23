// Ações de voz e GIFs
import { GIPHY_API_KEY } from '../config.js';
import { db } from '../store.js';
import { scheduleVoicePoll, voiceChannelOf, grantMove } from '../voice.js';
import { sendToUser } from '../realtime.js';
import { createGifs } from '../../gifs.js';
import { requirePerm, requireServer, requireChannelView } from '../guards.js';
import { fail, underLimit } from '../util.js';
import { PERMS, canSeeChannel } from '../../public/js/permissions.js';

const gifs = createGifs(GIPHY_API_KEY);
const gifSearchTimes = new Map();   // userId -> últimas buscas de GIF

export default {
  // O site avisa que mudou algo na voz: consulta o LiveKit já, sem esperar a próxima rodada
  'voice:poke'() {
    scheduleVoicePoll(100);
  },

  // Mover alguém que está numa call para outro canal de voz do mesmo servidor (só aquela pessoa).
  // O aparelho dela troca de canal sozinho.
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
    requireChannelView(ctx, user.id, to.id, 'Canal de voz não encontrado.');
    if (!canSeeChannel(ctx.snap, target, ctx.snap.channels.find((c) => c.id === to.id))) fail('Essa pessoa não tem acesso a esse canal privado.');
    grantMove(target, to.id);
    sendToUser(target, { t: 'voice:move', channelId: to.id, by: user.name });
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
