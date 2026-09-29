// Ligação direta (conversas privadas): quem liga entra no canal de chamada da conversa e o telefone
// dos outros "toca" (Aceitar / Recusar) por até 35 s. Ninguém atendeu: fica o aviso de chamada perdida.
import { db } from '../store.js';
import { SYSTEM } from '../../db.js';
import { sendToUser, sendToServer } from '../realtime.js';
import { voicePeople } from '../voice.js';
import { notify } from '../push.js';
import { requireServer } from '../guards.js';
import { fail } from '../util.js';

export const RING_MS = 35_000;
const ringing = new Map(); // conversa -> { callerId, channelId, timer }
const lastCall = new Map(); // "quem liga|conversa" -> quando tocou (sem insistir: uma vez a cada 20 s)

function requireDmCall(user, serverId) {
  const ctx = requireServer(user, serverId);
  if (ctx.snap.kind !== 'dm') fail('Ligação só nas mensagens diretas.');
  const channel = db.dmCallChannel(ctx.snap.id);
  if (!channel) fail('Essa conversa não tem ligação.');
  return { ctx, channel };
}

const others = (ctx, userId) => ctx.snap.members.filter((m) => m.id !== userId);

function post(serverId, text, meta = null) {
  const textChannel = db.snapshot(serverId)?.channels.find((c) => c.type === 'text');
  if (textChannel) sendToServer(serverId, { t: 'msg', msg: db.addSystemMessage(textChannel.id, text, SYSTEM.call, meta) });
}

// Para de tocar para todo mundo da conversa (reason: answered, declined, cancelled, missed)
function stopRinging(serverId, reason, by = null) {
  const r = ringing.get(serverId);
  if (!r) return null;
  clearTimeout(r.timer);
  ringing.delete(serverId);
  sendToServer(serverId, { t: 'call:stop', serverId, reason, by });
  if (reason === 'missed' || reason === 'cancelled') post(serverId, `Chamada perdida de <@${r.callerId}>.`);
  return r;
}

export const isRinging = (serverId) => ringing.has(serverId);

export default {
  // Começar a ligar (quem liga já entra no canal pelo site). Chamada já em andamento: só entra, sem tocar de novo.
  'call:start'(user, m) {
    const { ctx, channel } = requireDmCall(user, m.serverId);
    const inCall = voicePeople(channel.id).filter((p) => p.id !== user.id);
    if (inCall.length || ringing.has(ctx.snap.id)) return { t: 'ok', channelId: channel.id, ongoing: true };
    const key = `${user.id}|${ctx.snap.id}`;
    if (Date.now() - (lastCall.get(key) ?? 0) < 20_000) fail('Espere um pouquinho antes de ligar de novo.');
    lastCall.set(key, Date.now());
    if (lastCall.size > 1000) lastCall.clear();
    const from = db.userById(user.id);
    const timer = setTimeout(() => stopRinging(ctx.snap.id, 'missed'), RING_MS);
    timer.unref?.();
    ringing.set(ctx.snap.id, { callerId: user.id, channelId: channel.id, timer });
    post(ctx.snap.id, `<@${user.id}> começou uma chamada.`, { channelId: channel.id });
    for (const p of others(ctx, user.id)) {
      if (db.isMuted(p.id, channel.id, ctx.snap.id)) continue;
      sendToUser(p.id, { t: 'call:ring', serverId: ctx.snap.id, channelId: channel.id, from, group: ctx.snap.members.length > 2 });
      notify(p.id, { title: `📞 ${from.name} está te ligando`, body: 'Toque para atender.', url: `/?canal=${channel.id}`, tag: `call-${ctx.snap.id}` });
    }
    return { t: 'ok', channelId: channel.id, ongoing: false };
  },

  // Atendeu (em qualquer aparelho): para de tocar em todos
  'call:accept'(user, m) {
    const { ctx, channel } = requireDmCall(user, m.serverId);
    stopRinging(ctx.snap.id, 'answered', user.id);
    return { t: 'ok', channelId: channel.id };
  },

  // Recusou: numa conversa a dois encerra a chamada; em grupo só para de tocar para quem recusou
  'call:decline'(user, m) {
    const { ctx } = requireDmCall(user, m.serverId);
    if (!ringing.has(ctx.snap.id)) return;
    if (ctx.snap.members.length <= 2) stopRinging(ctx.snap.id, 'declined', user.id);
    else sendToUser(user.id, { t: 'call:stop', serverId: ctx.snap.id, reason: 'declined', by: user.id });
  },

  // Quem ligou desistiu antes de alguém atender
  'call:cancel'(user, m) {
    const { ctx } = requireDmCall(user, m.serverId);
    if (ringing.get(ctx.snap.id)?.callerId === user.id) stopRinging(ctx.snap.id, 'cancelled', user.id);
  },
};
