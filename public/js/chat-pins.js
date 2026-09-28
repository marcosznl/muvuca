// Mensagens fixadas: o pininho no topo do chat e a lista que ele abre
import { $, h, makeAvatar, fmtTime, showBanner } from './util.js';
import { icon } from './icons.js';
import { state, findChannel, canIn, PERMS, nameOf } from './state.js';
import { request } from './net.js';
import { GIF_URL } from './richtext.js';
import { appendRich, appendGif, attachmentsView } from './chat-content.js';
import { jumpTo } from './chat.js';

const panel = $('pins-panel');
let pinsChannel = null;

export const toastPin = (pinned) => showBanner(pinned ? 'Mensagem fixada! Veja no pininho lá em cima.' : 'Mensagem desafixada.', { kind: 'info', timeout: 2500 });

function openPins() {
  if (!panel.hidden) return closePins();
  pinsChannel = state.view.channelId;
  panel.hidden = false;
  $('btn-pins').classList.add('on');
  panel.replaceChildren(h('div', 'pins-head', 'Mensagens fixadas'), h('div', 'picker-empty', 'Carregando…'));
  loadPins();
}

function closePins() {
  panel.hidden = true;
  $('btn-pins').classList.remove('on');
  pinsChannel = null;
}

// Algo mudou num canal (fixou, editou, apagou): se a lista dele estiver aberta, atualiza
export function refreshPins(channelId) {
  if (!panel.hidden && pinsChannel === channelId) loadPins();
}

// Troca de canal: o pininho só aparece em canais com chat, e a lista de outro canal fecha
export function pinsFollow(channel) {
  $('btn-pins').hidden = !channel || channel.type === 'voice';
  if (pinsChannel && pinsChannel !== channel?.id) closePins();
}

function pinItem(msg, server) {
  const item = h('div', 'pin-item');
  const who = nameOf(msg.userId) ?? msg.name;
  const head = h('div', 'pin-meta');
  head.append(makeAvatar(who, 'sm', msg.userId), h('strong', '', who), h('time', 'muted small', fmtTime(msg.ts)));
  const text = h('div', 'text');
  if (GIF_URL.test(msg.text)) appendGif(text, msg.text);
  else appendRich(text, msg.text);
  if (msg.attachments?.length) text.append(attachmentsView(msg.attachments));
  const actions = h('div', 'pin-actions');
  const go = h('button', 'link-btn', 'Ir para a mensagem');
  go.type = 'button';
  go.onclick = () => { closePins(); jumpTo(msg.id); };
  actions.append(go);
  if (canIn(server, PERMS.PIN_MESSAGES)) {
    const unpin = h('button', 'icon-btn tiny');
    unpin.type = 'button';
    unpin.title = 'Desafixar';
    unpin.append(icon('close', 14));
    unpin.onclick = () => request({ t: 'msg:pin', id: msg.id, pinned: false }).catch((err) => showBanner(err.message, { timeout: 4000 }));
    actions.append(unpin);
  }
  item.append(head, text, actions);
  return item;
}

async function loadPins() {
  const channelId = pinsChannel;
  let res;
  try { res = await request({ t: 'pins', channel: channelId }); } catch (err) { return showBanner(err.message, { timeout: 4000 }); }
  if (pinsChannel !== channelId) return;
  const { server } = findChannel(channelId);
  const list = h('div', 'pins-list');
  if (!res.messages.length) {
    const empty = h('div', 'pins-empty');
    empty.append(icon('pin', 36), h('p', '', 'Nenhuma mensagem fixada neste canal ainda.'),
      h('p', 'muted small', 'Passe o mouse numa mensagem e clique no pininho para fixá-la aqui.'));
    list.append(empty);
  }
  for (const msg of res.messages) list.append(pinItem(msg, server));
  panel.replaceChildren(h('div', 'pins-head', `Mensagens fixadas${res.messages.length ? ` — ${res.messages.length}` : ''}`), list);
}

$('btn-pins').onclick = (e) => { e.stopPropagation(); openPins(); };
panel.addEventListener('click', (e) => e.stopPropagation());
document.addEventListener('click', () => { if (!panel.hidden) closePins(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !panel.hidden) closePins(); });
