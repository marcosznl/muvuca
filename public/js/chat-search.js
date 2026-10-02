// Busca de mensagens no servidor (lupa no topo): texto, e opcionalmente de quem e em qual canal
import { $, h, makeAvatar, fmtTime, showBanner } from './util.js';
import { icon } from './icons.js';
import { state, currentServer, findChannel, nameOf, chatChannelId } from './state.js';
import { request } from './net.js';
import { GIF_URL } from './richtext.js';
import { appendRich, appendGif } from './chat-content.js';
import { jumpToMessage } from './chat.js';
import { selectChannel } from './app.js';

const panel = $('search-panel');
let timer = null;
let seq = 0;

// A lupa aparece dentro de um servidor (a busca é no servidor todo)
export function searchFollow() {
  $('btn-search').hidden = !currentServer() || !!state.view.games;
  if (panel.dataset.server && panel.dataset.server !== state.view.serverId) closeSearch();
}

function closeSearch() {
  panel.hidden = true;
  panel.dataset.server = '';
  $('btn-search').classList.remove('on');
}

function openSearch() {
  const s = currentServer();
  if (!s) return;
  if (!panel.hidden) return closeSearch();
  panel.hidden = false;
  panel.dataset.server = s.id;
  $('btn-search').classList.add('on');

  const input = h('input', 'search-input');
  input.placeholder = `Buscar em ${s.name}`;
  input.maxLength = 100;
  const from = h('select', 'search-filter');
  from.append(new Option('De qualquer pessoa', ''));
  for (const m of [...s.members].sort((a, b) => a.name.localeCompare(b.name, 'pt-BR'))) from.append(new Option(`De ${m.name}`, m.id));
  const where = h('select', 'search-filter');
  where.append(new Option('Em todos os canais', ''));
  for (const c of s.channels.filter((x) => x.type !== 'voice')) where.append(new Option(`Em #${c.name}`, c.id));
  const filters = h('div', 'search-filters');
  filters.append(from, where);
  const results = h('div', 'pins-list search-results');
  results.append(h('div', 'picker-empty', 'Digite para buscar nas mensagens.'));
  const head = h('label', 'picker-search');
  head.append(icon('search', 18), input);
  panel.replaceChildren(h('div', 'pins-head', 'Buscar mensagens'), head, filters, results);

  const run = async () => {
    const text = input.value.trim();
    if (text.length < 2 && !from.value) {
      results.replaceChildren(h('div', 'picker-empty', 'Digite pelo menos 2 letras.'));
      return;
    }
    const mine = ++seq;
    results.replaceChildren(h('div', 'picker-empty', 'Buscando…'));
    let res;
    try { res = await request({ t: 'search', serverId: s.id, text, from: from.value || null, channel: where.value || null }); } catch (err) {
      return results.replaceChildren(h('div', 'picker-empty', err.message));
    }
    if (mine !== seq) return;
    results.replaceChildren();
    if (!res.results.length) results.append(h('div', 'picker-empty', 'Nada encontrado.'));
    for (const msg of res.results) results.append(resultItem(msg));
    if (res.results.length === 25) results.append(h('div', 'picker-empty small', 'Mostrando as 25 mais recentes. Refine a busca para achar outras.'));
  };
  const later = () => { clearTimeout(timer); timer = setTimeout(run, 350); };
  input.oninput = later;
  from.onchange = run;
  where.onchange = run;
  input.onkeydown = (e) => { if (e.key === 'Enter') { clearTimeout(timer); run(); } };
  setTimeout(() => input.focus(), 0);
}

function resultItem(msg) {
  const item = h('div', 'pin-item search-item');
  const who = nameOf(msg.userId) ?? msg.name;
  const channel = findChannel(msg.channel).channel;
  const head = h('div', 'pin-meta');
  head.append(makeAvatar(who, 'sm', msg.userId), h('strong', '', who), h('span', 'muted small', `#${channel?.name ?? '?'}`),
    h('time', 'muted small', fmtTime(msg.ts)));
  const text = h('div', 'text');
  if (GIF_URL.test(msg.text)) appendGif(text, msg.text);
  else appendRich(text, msg.text || '📎 Anexo');
  text.classList.remove('jumbo');
  item.append(head, text);
  item.title = 'Ir para a mensagem';
  item.onclick = () => {
    closeSearch();
    if (chatChannelId() !== msg.channel) selectChannel(msg.channel);
    jumpToMessage(msg.channel, msg.id).catch((err) => showBanner(err.message, { timeout: 4000 }));
  };
  return item;
}

$('btn-search').onclick = (e) => { e.stopPropagation(); openSearch(); };
panel.addEventListener('click', (e) => e.stopPropagation());
panel.addEventListener('mousedown', (e) => e.stopPropagation());
document.addEventListener('click', () => { if (!panel.hidden) closeSearch(); });
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !panel.hidden) closeSearch();
  // Ctrl/Cmd+F abre a busca do Muvuca (em vez da do navegador) quando há um servidor aberto
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f' && currentServer() && !state.view.games) {
    e.preventDefault();
    if (panel.hidden) openSearch();
  }
});
