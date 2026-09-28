// Ligação direta nas mensagens diretas: botão 📞 no topo da conversa, tela de "chamada recebida"
// (Aceitar / Recusar, tocando por até 35 s) e a faixa de chamada em andamento acima do chat.
import { $, h, makeAvatar, showBanner } from './util.js';
import { icon } from './icons.js';
import { state, serverById, findChannel } from './state.js';
import { request } from './net.js';
import { sounds } from './sounds.js';
import { joinVoice, leaveVoice, voiceChannelId } from './voice.js';
import { selectChannel } from './app.js';
import { dmTitle } from './dms.js';

let incoming = null; // { serverId, channelId, from, el, timer }
let outgoing = null; // { serverId, channelId, timer }

const callChannelOf = (server) => server?.channels.find((c) => c.type === 'voice') ?? null;
const peopleIn = (channelId) => state.voice[channelId] ?? [];

function loop(fn, every) {
  fn();
  return setInterval(fn, every);
}

// ---------- Ligar ----------

export async function startCall(serverId) {
  const server = serverById(serverId);
  const channel = callChannelOf(server);
  if (!channel) return;
  if (voiceChannelId() === channel.id) return selectChannel(channel.id); // já está nela: mostra a chamada
  await joinVoice(channel.id);
  if (voiceChannelId() !== channel.id) return; // não conseguiu entrar (microfone, permissão…)
  try {
    const r = await request({ t: 'call:start', serverId });
    if (!r.ongoing) {
      stopOutgoing();
      outgoing = { serverId, channelId: channel.id, timer: loop(sounds.dialing, 2500) };
    }
  } catch (err) { showBanner(err.message, { timeout: 4000 }); }
  renderCallBar();
}

function stopOutgoing() {
  if (!outgoing) return;
  clearInterval(outgoing.timer);
  outgoing = null;
}

// ---------- Receber ----------

function showIncoming(m) {
  closeIncoming();
  const server = serverById(m.serverId);
  const layer = h('div', 'call-incoming');
  const card = h('div', 'call-card');
  const avatar = makeAvatar(m.from.name, 'xl', m.from.id);
  avatar.classList.add('call-avatar');
  const title = m.group && server ? dmTitle(server) : m.from.name;
  card.append(avatar, h('div', 'call-name', title), h('div', 'call-sub', m.group ? `${m.from.name} está chamando o grupo…` : 'Está te ligando…'));
  const btns = h('div', 'call-btns');
  const decline = h('button', 'call-round decline');
  decline.title = 'Recusar';
  decline.append(icon('phone-off', 26));
  const accept = h('button', 'call-round accept');
  accept.title = 'Aceitar';
  accept.append(icon('phone', 26));
  btns.append(decline, accept);
  card.append(btns);
  layer.append(card);
  document.body.append(layer);
  decline.onclick = () => { closeIncoming(); request({ t: 'call:decline', serverId: m.serverId }).catch(() => {}); };
  accept.onclick = async () => {
    closeIncoming();
    request({ t: 'call:accept', serverId: m.serverId }).catch(() => {});
    await joinVoice(m.channelId);
    if (voiceChannelId() === m.channelId) selectChannel(m.channelId);
  };
  incoming = { ...m, el: layer, timer: loop(sounds.ring, 2200) };
}

function closeIncoming() {
  if (!incoming) return;
  clearInterval(incoming.timer);
  incoming.el.remove();
  incoming = null;
}

// Avisos do servidor
export function onCallEvent(m) {
  if (m.t === 'call:ring') {
    if (voiceChannelId() === m.channelId) return; // já está na chamada (outro aparelho atendeu)
    showIncoming(m);
    return;
  }
  if (m.t === 'call:stop') {
    if (incoming?.serverId === m.serverId) closeIncoming();
    if (outgoing?.serverId === m.serverId) {
      stopOutgoing();
      if (m.reason === 'declined') showBanner('A chamada foi recusada.', { kind: 'info', timeout: 4000 });
      if (m.reason === 'missed') {
        showBanner('Ninguém atendeu.', { kind: 'info', timeout: 4000 });
        // Ficou sozinho na chamada: sai
        const alone = peopleIn(voiceChannelId()).every((p) => p.id === state.me.id);
        if (alone && voiceChannelId() === callChannelOf(serverById(m.serverId))?.id) leaveVoice({ keepView: true });
      }
    }
    renderCallBar();
  }
}

// Mudou quem está nas chamadas: alguém atendeu (para o "tuuu") ou todo mundo saiu (fecha o "tocando")
export function onVoiceChanged() {
  if (outgoing && peopleIn(outgoing.channelId).some((p) => p.id !== state.me.id)) stopOutgoing();
  if (outgoing && voiceChannelId() !== outgoing.channelId) {
    request({ t: 'call:cancel', serverId: outgoing.serverId }).catch(() => {}); // desligou antes de atenderem
    stopOutgoing();
  }
  if (incoming && !peopleIn(incoming.channelId).length) closeIncoming();
  renderCallBar();
}

// ---------- Botão do topo e faixa da chamada ----------

export function renderCallBar() {
  const { server, channel } = findChannel(state.view.channelId);
  const dm = server?.kind === 'dm';
  const call = dm ? callChannelOf(server) : null;
  const btn = $('btn-call');
  btn.hidden = !call || channel?.type === 'voice';
  const bar = $('call-bar');
  const people = call ? peopleIn(call.id) : [];
  const mine = call && voiceChannelId() === call.id;
  bar.hidden = !call || (!people.length && !mine) || channel?.type !== 'text';
  if (bar.hidden) return;
  bar.replaceChildren();
  const faces = h('div', 'call-faces');
  for (const p of people.slice(0, 6)) {
    const a = makeAvatar(p.name, 'sm', p.id);
    a.title = p.name;
    faces.append(a);
  }
  const ringingOut = outgoing?.channelId === call.id;
  const text = h('div', 'call-bar-text', ringingOut ? 'Chamando…' : mine ? 'Você está na chamada' : 'Chamada em andamento');
  const acts = h('div', 'call-bar-acts');
  if (mine) {
    const view = h('button', 'btn secondary small', 'Ver chamada');
    view.onclick = () => selectChannel(call.id);
    const hang = h('button', 'btn danger small', 'Desligar');
    hang.onclick = () => leaveVoice({ keepView: true });
    acts.append(view, hang);
  } else {
    const join = h('button', 'btn small call-join', 'Entrar na chamada');
    join.onclick = () => startCall(server.id);
    acts.append(join);
  }
  const ico = icon('phone', 18);
  bar.append(ico, text, faces, acts);
}

$('btn-call').onclick = () => {
  const { server } = findChannel(state.view.channelId);
  if (server?.kind === 'dm') startCall(server.id);
};
