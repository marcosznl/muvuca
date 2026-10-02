// Chat ao lado da call: a tela do canal de voz se divide entre a call (esquerda) e um canal de texto do
// servidor (direita), com uma divisória para arrastar. O botão de chat nos controles da call liga e desliga;
// a lista no topo troca o canal. Tudo fica salvo no aparelho (ligado, largura e canal de cada servidor).
import { $, h, store } from './util.js';
import { state, findChannel, callSplitOn, callChatChannel } from './state.js';
import { showChannelView } from './app.js';

const MIN_CHAT = 280;  // largura mínima do chat
const MIN_CALL = 320;  // a call nunca fica mais estreita que isso
const savedWidth = () => Number(store.get('callChatW')) || 400;

export function renderCallChat() {
  const { server, channel } = findChannel(state.view.channelId);
  const on = channel?.type === 'voice' && callSplitOn() && !!callChatChannel(server);
  $('call-chat').hidden = !on;
  $('call-split').hidden = !on;
  $('voice-view').classList.toggle('split', on);
  const btn = $('btn-call-chat');
  btn.classList.toggle('on', callSplitOn());
  btn.title = callSplitOn() ? 'Esconder o chat' : 'Chat ao lado';
  btn.setAttribute('aria-pressed', String(callSplitOn()));
  if (!on) return;
  const current = callChatChannel(server);
  const sel = $('call-chat-select');
  sel.replaceChildren(...server.channels.filter((c) => c.type === 'text').map((c) => h('option', '', c.name)));
  [...sel.options].forEach((o, i) => { o.value = server.channels.filter((c) => c.type === 'text')[i].id; });
  sel.value = current.id;
  applyWidth();
}

// Largura do chat: a salva, sem deixar a call nem o chat pequenos demais
function applyWidth(w = savedWidth()) {
  const total = $('voice-view').clientWidth;
  const max = Math.max(MIN_CHAT, total - MIN_CALL);
  const width = Math.round(Math.min(Math.max(w, MIN_CHAT), max));
  $('call-chat').style.setProperty('--call-chat-w', `${width}px`);
  return width;
}
new ResizeObserver(() => { if (!$('call-chat').hidden) applyWidth(); }).observe($('voice-view'));

export function toggleCallChat(on = !callSplitOn()) {
  store.set('callSplit', on ? '1' : null);
  showChannelView();
}

$('btn-call-chat').onclick = () => toggleCallChat();
$('call-chat-close').onclick = () => toggleCallChat(false);
$('call-chat-select').onchange = (e) => {
  const { server } = findChannel(state.view.channelId);
  if (server) store.set(`callChat:${server.id}`, e.target.value);
  showChannelView();
};

// Divisória: arrastar com o mouse ou o dedo; setas do teclado também mudam a largura
const split = $('call-split');
split.addEventListener('pointerdown', (e) => {
  e.preventDefault();
  split.setPointerCapture(e.pointerId);
  $('voice-view').classList.add('resizing');
  const right = $('voice-view').getBoundingClientRect().right;
  let width = savedWidth();
  const move = (ev) => { width = applyWidth(right - ev.clientX); };
  const up = () => {
    split.removeEventListener('pointermove', move);
    split.removeEventListener('pointerup', up);
    split.removeEventListener('pointercancel', up);
    $('voice-view').classList.remove('resizing');
    store.set('callChatW', String(width));
  };
  split.addEventListener('pointermove', move);
  split.addEventListener('pointerup', up);
  split.addEventListener('pointercancel', up);
});
split.addEventListener('keydown', (e) => {
  const step = e.shiftKey ? 80 : 20;
  if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
  e.preventDefault();
  store.set('callChatW', String(applyWidth(savedWidth() + (e.key === 'ArrowLeft' ? step : -step))));
});
