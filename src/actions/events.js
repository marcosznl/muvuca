// Eventos agendados do servidor ("Jogatina sexta 21h"): marcar, apagar, "Vou" e o lembrete 15 min antes
import { db } from '../store.js';
import { SYSTEM } from '../../db.js';
import { pushServer, sendToServer, sendToUser } from '../realtime.js';
import { requireServer, requirePerm, requireChannelView } from '../guards.js';
import { notify } from '../push.js';
import { fail, clean } from '../util.js';
import { PERMS, canSeeChannel } from '../../public/js/permissions.js';

export const REMIND_BEFORE_MS = 15 * 60_000;
const MAX_AHEAD_MS = 180 * 24 * 3_600_000; // até 6 meses para a frente

const when = (ts) => new Date(ts).toLocaleString('pt-BR', { weekday: 'short', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', timeZone: 'America/Sao_Paulo' });

// Primeiro canal de texto que todo mundo vê (o aviso do evento vai para lá)
function announceChannel(snap) {
  return snap.channels.find((c) => c.type === 'text' && !c.private) ?? null;
}

function requireEvent(user, eventId) {
  const ev = db.event(eventId);
  if (!ev) fail('Evento não encontrado.');
  const ctx = requireServer(user, ev.server_id);
  return { ev, ctx };
}

export default {
  'event:create'(user, m) {
    const ctx = requireServer(user, m.serverId);
    if (ctx.snap.kind === 'dm') fail('Eventos são só para servidores.');
    requirePerm(ctx, PERMS.MANAGE_EVENTS, 'Você não tem permissão para marcar eventos.');
    const title = clean(m.title, 80);
    if (!title) fail('Dê um nome ao evento.');
    const description = String(m.description ?? '').replace(/\r/g, '').trim().slice(0, 500);
    const startsAt = Number(m.startsAt);
    if (!Number.isFinite(startsAt) || startsAt < Date.now() + 60_000) fail('Escolha um horário no futuro.');
    if (startsAt > Date.now() + MAX_AHEAD_MS) fail('O evento pode ser marcado até 6 meses para a frente.');
    const channelId = m.channelId ? requireChannelView(ctx, user.id, String(m.channelId)).id : null;
    if ((ctx.snap.events ?? []).length >= 20) fail('Este servidor já tem 20 eventos marcados. Apague algum antes.');
    const id = db.addEvent({ serverId: ctx.snap.id, title, description, startsAt, channelId, userId: user.id });
    pushServer(ctx.snap.id);
    const text = announceChannel(ctx.snap);
    if (text) sendToServer(ctx.snap.id, { t: 'msg', msg: db.addSystemMessage(text.id, `📅 ${user.name} marcou **${title}** para ${when(startsAt)}.`, SYSTEM.event, { eventId: id }) });
    return { t: 'event:created', id };
  },

  // Apagar: quem marcou ou quem gerencia eventos
  'event:delete'(user, m) {
    const { ev, ctx } = requireEvent(user, m.eventId);
    if (String(ev.created_by) !== user.id.slice(1)) requirePerm(ctx, PERMS.MANAGE_EVENTS, 'Só quem marcou (ou quem gerencia eventos) pode apagar.');
    db.deleteEvent(ev.id);
    pushServer(ctx.snap.id);
  },

  // "Vou" / "Não vou mais"
  'event:rsvp'(user, m) {
    const { ev, ctx } = requireEvent(user, m.eventId);
    if (ev.starts_at < Date.now() - 3 * 3_600_000) fail('Esse evento já passou.');
    db.rsvp(ev.id, user.id, m.going !== false);
    pushServer(ctx.snap.id);
  },
};

// Lembrete: 15 min antes, avisa quem vai (no site e no celular) e quem marcou o canal de voz dele
export function remindEvents() {
  for (const ev of db.eventsToRemind(REMIND_BEFORE_MS)) {
    db.markReminded(ev.id);
    const snap = db.snapshot(ev.server_id);
    if (!snap) continue;
    const channel = ev.channel_id ? snap.channels.find((c) => c.id === ev.channel_id) : null;
    const mins = Math.max(1, Math.round((ev.starts_at - Date.now()) / 60_000));
    for (const userId of db.eventGoing(ev.id)) {
      if (!snap.members.some((x) => x.id === userId)) continue;
      const where = channel && canSeeChannel(snap, userId, channel) ? channel : null;
      const body = `Começa em ${mins} min${where ? ` · ${where.type === 'voice' ? '🔊' : '#'}${where.name}` : ''} (${snap.name})`;
      sendToUser(userId, { t: 'event:reminder', serverId: snap.id, eventId: ev.id, title: ev.title, body, channelId: where?.id ?? null });
      notify(userId, { title: `📅 ${ev.title}`, body, url: where ? `/?canal=${where.id}` : '/', tag: `evento-${ev.id}` });
    }
  }
}
setInterval(() => { try { remindEvents(); } catch (err) { console.error('eventos:', err.message); } }, 30_000).unref();

