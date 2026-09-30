// Eventos agendados do servidor: faixa do próximo evento no topo dos canais, janela com a lista
// ("Vou", apagar, marcar novo) e o lembrete 15 min antes (o servidor avisa)
import { h, makeAvatar, showBanner, toast } from './util.js';
import { icon } from './icons.js';
import { state, serverById, canIn, PERMS, nameOf } from './state.js';
import { request } from './net.js';
import { openModal, button, confirmDialog } from './dialogs.js';

const fmtWhen = (ts) => {
  const d = new Date(ts);
  const today = new Date();
  const days = Math.round((new Date(d.getFullYear(), d.getMonth(), d.getDate()) - new Date(today.getFullYear(), today.getMonth(), today.getDate())) / 86_400_000);
  const hour = d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
  if (days === 0) return `hoje às ${hour}`;
  if (days === 1) return `amanhã às ${hour}`;
  if (days > 1 && days < 7) return `${d.toLocaleDateString('pt-BR', { weekday: 'long' })} às ${hour}`;
  return `${d.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' })} às ${hour}`;
};
const started = (ev) => ev.startsAt <= Date.now();
const upcoming = (s) => (s?.events ?? []).filter((e) => e.startsAt > Date.now() - 3 * 3_600_000).sort((a, b) => a.startsAt - b.startsAt);

// Faixa no topo da lista de canais: o próximo evento (até 7 dias) ou só "Eventos" para quem pode marcar
export function eventsStrip(s) {
  const next = upcoming(s).find((e) => e.startsAt < Date.now() + 7 * 86_400_000);
  const canCreate = canIn(s, PERMS.MANAGE_EVENTS);
  if (!next && !canCreate && !upcoming(s).length) return null;
  const b = h('button', next ? 'events-strip has-next' : 'events-strip');
  b.type = 'button';
  b.append(icon('calendar', 16));
  if (next) {
    const txt = h('span', 'events-strip-text');
    txt.append(h('b', '', next.title), h('span', 'muted', ` · ${started(next) ? 'acontecendo agora' : fmtWhen(next.startsAt)}`));
    b.append(txt);
    if (next.going.includes(state.me?.id)) b.append(h('span', 'events-going', 'vou'));
    else b.append(h('span', 'count', String(next.going.length)));
  } else {
    b.append(h('span', 'events-strip-text', upcoming(s).length ? `Eventos (${upcoming(s).length})` : 'Eventos'));
  }
  b.title = 'Eventos do servidor';
  b.onclick = () => openEvents(s.id);
  return b;
}

let openModalRef = null;
export function openEvents(serverId) {
  const s = serverById(serverId);
  if (!s) return;
  const content = h('div', 'events-list');
  const paint = () => {
    const sv = serverById(serverId);
    content.replaceChildren();
    const list = upcoming(sv);
    if (!list.length) content.append(h('p', 'muted', canIn(sv, PERMS.MANAGE_EVENTS) ? 'Nenhum evento marcado. Que tal marcar uma jogatina?' : 'Nenhum evento marcado por enquanto.'));
    for (const ev of list) content.append(eventCard(sv, ev));
  };
  paint();
  const actions = [];
  if (canIn(s, PERMS.MANAGE_EVENTS)) {
    const create = button('Marcar evento');
    create.onclick = () => { openModalRef?.close(); createEvent(serverId); };
    actions.push(create);
  }
  openModalRef = openModal({ title: `Eventos de ${s.name}`, content, actions, onClose: () => { openModalRef = null; } });
  openModalRef.repaint = paint;
}
// Chegou o servidor atualizado (alguém marcou "Vou"): a janela aberta se atualiza
export function eventsUpdated() { openModalRef?.repaint?.(); }

function eventCard(s, ev) {
  const card = h('div', started(ev) ? 'event-card live' : 'event-card');
  const head = h('div', 'event-when');
  head.append(icon('calendar', 14), started(ev) ? 'Acontecendo agora' : fmtWhen(ev.startsAt));
  const channel = ev.channelId ? s.channels.find((c) => c.id === ev.channelId) : null;
  if (channel) head.append(h('span', 'muted', ` · ${channel.type === 'voice' ? '🔊 ' : '#'}${channel.name}`));
  card.append(head, h('div', 'event-title', ev.title));
  if (ev.description) card.append(h('div', 'event-desc', ev.description));
  const foot = h('div', 'event-foot');
  const who = h('div', 'event-going');
  for (const id of ev.going.slice(0, 6)) { const a = makeAvatar(nameOf(id, s) ?? '?', 'xs', id); a.title = nameOf(id, s) ?? ''; who.append(a); }
  who.append(h('span', 'muted small', ev.going.length ? `${ev.going.length} ${ev.going.length === 1 ? 'vai' : 'vão'}` : 'ninguém confirmou ainda'));
  foot.append(who);
  const going = ev.going.includes(state.me?.id);
  const rsvp = button(going ? 'Vou ✓' : 'Vou', { kind: going ? 'secondary' : 'primary' });
  rsvp.title = going ? 'Clique para desmarcar' : 'Confirmar presença (você recebe um lembrete 15 min antes)';
  rsvp.onclick = () => request({ t: 'event:rsvp', eventId: ev.id, going: !going })
    .then(() => toast(going ? 'Presença desmarcada.' : 'Presença confirmada! Você recebe um lembrete 15 min antes.'))
    .catch((err) => showBanner(err.message, { timeout: 4000 }));
  foot.append(rsvp);
  if (ev.by === state.me?.id || canIn(s, PERMS.MANAGE_EVENTS)) {
    const del = h('button', 'icon-btn danger-hover');
    del.type = 'button';
    del.title = 'Apagar evento';
    del.append(icon('trash', 16));
    del.onclick = async () => {
      if (!(await confirmDialog({ title: 'Apagar evento', message: `Apagar "${ev.title}"?`, confirm: 'Apagar' }))) return;
      request({ t: 'event:delete', eventId: ev.id }).catch((err) => showBanner(err.message, { timeout: 4000 }));
    };
    foot.append(del);
  }
  card.append(foot);
  return card;
}

// Hora local no formato do <input type="datetime-local">
const localInput = (ts) => { const d = new Date(ts - new Date().getTimezoneOffset() * 60_000); return d.toISOString().slice(0, 16); };

function createEvent(serverId) {
  const s = serverById(serverId);
  const form = h('form', 'form');
  const field = (label, el, hint) => { const f = h('label', 'field'); f.append(h('span', 'field-label', label), el); if (hint) f.append(h('span', 'muted small', hint)); form.append(f); return el; };
  const title = field('Nome', Object.assign(h('input'), { maxLength: 80, placeholder: 'Jogatina de sexta', required: true }));
  // Sugestão: próxima hora cheia, daqui a pelo menos 1 h
  const start = new Date(Date.now() + 3_600_000);
  start.setMinutes(0, 0, 0);
  const when = field('Quando', Object.assign(h('input'), { type: 'datetime-local', value: localInput(start), min: localInput(Date.now() + 60_000), required: true }));
  const where = h('select');
  where.append(Object.assign(h('option', '', 'Nenhum (só o aviso)'), { value: '' }));
  for (const c of s.channels.filter((x) => x.type === 'voice')) where.append(Object.assign(h('option', '', `🔊 ${c.name}`), { value: c.id }));
  field('Onde', where, 'O lembrete leva direto para esse canal de voz.');
  const desc = field('Descrição (opcional)', Object.assign(h('textarea'), { maxLength: 500, rows: 3, placeholder: 'O que vai rolar?' }));
  const error = h('p', 'error small');
  form.append(error);
  const save = button('Marcar');
  const modal = openModal({ title: 'Marcar evento', subtitle: 'Todo mundo do servidor vê. Quem confirmar recebe um lembrete 15 min antes.', content: form, actions: [save] });
  const submit = async (e) => {
    e?.preventDefault();
    error.textContent = '';
    const startsAt = new Date(when.value).getTime();
    if (!title.value.trim()) { error.textContent = 'Dê um nome ao evento.'; return title.focus(); }
    if (!Number.isFinite(startsAt) || startsAt < Date.now() + 60_000) { error.textContent = 'Escolha um horário no futuro.'; return when.focus(); }
    save.disabled = true;
    try {
      await request({ t: 'event:create', serverId, title: title.value, description: desc.value, startsAt, channelId: where.value || null });
      modal.close();
      toast('Evento marcado!');
    } catch (err) { error.textContent = err.message; } finally { save.disabled = false; }
  };
  form.onsubmit = submit;
  save.onclick = submit;
  setTimeout(() => title.focus(), 0);
}

// Lembrete (15 min antes): aviso no topo; clicar leva ao canal do evento
export function onEventReminder(m) {
  showBanner(`📅 ${m.title}: ${m.body}`, {
    kind: 'info', timeout: 20000,
    onClick: () => { if (m.channelId) import('./app.js').then(({ selectChannel }) => selectChannel(m.channelId)); else openEvents(m.serverId); },
  });
}
