// Painel de GIFs e emojis (como o do Discord: abas, busca e blocos de categoria)
import { $, h, store, showBanner } from './util.js';
import { icon } from './icons.js';
import { state, chatChannelId } from './state.js';
import { send, request } from './net.js';
import { usableEmojis } from './richtext.js';
import { customEmojiImg } from './chat-content.js';

export const EMOJI_GROUPS = [
  ['Rostos', '😀 😃 😄 😁 😆 😅 🤣 😂 🙂 🙃 😉 😊 😇 🥰 😍 🤩 😘 😋 😛 😜 🤪 😝 🤑 🤗 🤭 🤫 🤔 🤐 🤨 😐 😑 😶 😏 😒 🙄 😬 😮‍💨 🤥 😌 😔 😪 🤤 😴 😷 🤒 🤕 🤢 🤮 🥵 🥶 🥴 😵 🤯 🤠 🥳 😎 🤓 🧐 😕 😟 🙁 😮 😯 😲 😳 🥺 😦 😧 😨 😰 😥 😢 😭 😱 😖 😣 😞 😓 😩 😫 🥱 😤 😡 😠 🤬 😈 👿 💀 ☠️ 💩 🤡 👹 👻 👽 🤖 😺 😹 😻 🙈 🙉 🙊'],
  ['Gestos', '👋 🤚 ✋ 🖖 👌 🤌 🤏 ✌️ 🤞 🤟 🤘 🤙 👈 👉 👆 👇 ☝️ 👍 👎 ✊ 👊 🤛 🤜 👏 🙌 👐 🤲 🤝 🙏 💪 🦾 🫡 🫶 👀 🧠 👑'],
  ['Corações', '❤️ 🧡 💛 💚 💙 💜 🖤 🤍 🤎 💔 ❣️ 💕 💞 💓 💗 💖 💘 💝 💯 💢 💥 💫 💦 💨 🔥 ✨ ⭐ 🌟'],
  ['Comida', '🍎 🍉 🍇 🍓 🍒 🍍 🥥 🥑 🌽 🌶️ 🍟 🍕 🍔 🌭 🥪 🌮 🌯 🍝 🍜 🍣 🍱 🍗 🥩 🍿 🍩 🍪 🎂 🍰 🍫 🍬 🍭 ☕ 🍺 🍻 🥂 🍷 🥃 🧃 🧋'],
  ['Atividades', '⚽ 🏀 🏈 ⚾ 🎾 🏐 🎱 🏓 🎮 🕹️ 🎲 🧩 ♟️ 🎯 🎳 🏆 🥇 🥈 🥉 🎉 🎊 🎁 🎈 🎤 🎧 🎸 🎹 🥁 🎬 📺 💻 📱 🚀 🚗 ✈️ 🏖️'],
  ['Símbolos', '✅ ❌ ⚠️ ❓ ❗ 💤 🆗 🆒 🆕 🔝 🔴 🟠 🟡 🟢 🔵 🟣 ⚫ ⚪ ➡️ ⬅️ ⬆️ ⬇️ 🔁 ⏰ 📌 📎 🔗 💡 💰 🎵 🎶'],
];
const panel = $('emoji-panel');
let tab = 'gifs';

function recentEmojis() {
  try { return JSON.parse(store.get('recentEmojis') || '[]'); } catch { return []; }
}

function insertEmoji(emoji, { remember = true } = {}) {
  const input = $('chat-input');
  const start = input.selectionStart ?? input.value.length;
  const end = input.selectionEnd ?? input.value.length;
  input.value = input.value.slice(0, start) + emoji + input.value.slice(end);
  const pos = start + emoji.length;
  // No celular não foca o campo: o teclado subiria e cobriria o seletor
  if (matchMedia('(pointer: fine)').matches) {
    input.focus();
    input.setSelectionRange(pos, pos);
  }
  if (remember) store.set('recentEmojis', JSON.stringify([emoji, ...recentEmojis().filter((x) => x !== emoji)].slice(0, 16)));
}

function emojiTab() {
  const scroll = h('div', 'picker-scroll emoji-scroll');
  // Emojis dos servidores (o aberto primeiro)
  const byServer = new Map();
  for (const e of usableEmojis(state.servers, state.view.serverId)) {
    if (!byServer.has(e.server)) byServer.set(e.server, []);
    byServer.get(e.server).push(e);
  }
  for (const [srv, list] of byServer) {
    scroll.append(h('div', 'emoji-title', srv.name));
    const grid = h('div', 'emoji-grid');
    for (const e of list) {
      const b = h('button', 'emoji custom');
      b.type = 'button';
      b.title = `:${e.name}:`;
      b.append(customEmojiImg(e.name, e.id));
      b.onclick = (ev) => {
        insertEmoji(`:${e.name}:`, { remember: false });
        if (!ev.shiftKey) closeEmojiPanel();
      };
      grid.append(b);
    }
    scroll.append(grid);
  }
  const recent = recentEmojis();
  const groups = recent.length ? [['Usados recentemente', recent.join(' ')], ...EMOJI_GROUPS] : EMOJI_GROUPS;
  for (const [title, list] of groups) {
    scroll.append(h('div', 'emoji-title', title));
    const grid = h('div', 'emoji-grid');
    for (const emoji of list.split(' ')) {
      const b = h('button', 'emoji', emoji);
      b.type = 'button';
      b.onclick = (e) => {
        insertEmoji(emoji);
        if (!e.shiftKey) closeEmojiPanel(); // Shift+clique escolhe vários, como no Discord
      };
      grid.append(b);
    }
    scroll.append(grid);
  }
  return scroll;
}

// ----- GIFs -----

const gif = { q: '', title: '', items: [], nextOffset: 0, hasMore: false, loading: false, token: 0, home: null, view: 'home' };

function favorites() {
  try { return JSON.parse(store.get('gifFavorites') || '[]'); } catch { return []; }
}
const isFavorite = (url) => favorites().some((f) => f.url === url);
function toggleFavorite(item) {
  const list = favorites().filter((f) => f.url !== item.url);
  if (list.length === favorites().length) list.unshift(item);
  store.set('gifFavorites', JSON.stringify(list.slice(0, 100)));
}

function sendGif(item) {
  send({ t: 'msg', channel: chatChannelId(), text: item.url });
  closeEmojiPanel();
}

let gifScroll = null;
let gifInput = null;

function gifTab() {
  const wrap = h('div', 'gif-tab');
  const search = h('label', 'picker-search');
  gifInput = h('input');
  gifInput.placeholder = 'Buscar no GIPHY';
  gifInput.value = gif.view === 'search' ? gif.q : '';
  search.append(icon('search', 18), gifInput);
  gifScroll = h('div', 'picker-scroll gif-scroll');
  wrap.append(search, gifScroll, h('div', 'giphy-credit', 'Powered by GIPHY'));

  let timer = null;
  gifInput.oninput = () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      const q = gifInput.value.trim();
      if (q) openGifList({ q, title: q, view: 'search' });
      else { gif.view = 'home'; renderGifBody(); }
    }, 400);
  };
  gifInput.onkeydown = (e) => { if (e.key === 'Enter') e.preventDefault(); }; // não envia o formulário do chat
  gifScroll.onscroll = () => {
    if (gif.view === 'home' || gif.view === 'favorites' || !gif.hasMore || gif.loading) return;
    if (gifScroll.scrollTop + gifScroll.clientHeight > gifScroll.scrollHeight - 300) loadGifs();
  };
  renderGifBody();
  if (matchMedia('(pointer: fine)').matches) setTimeout(() => gifInput.focus(), 0);
  return wrap;
}

function tile(label, preview, onClick, iconName) {
  const b = h('button', 'gif-tile');
  b.type = 'button';
  if (preview) b.style.backgroundImage = `url("${preview}")`;
  const text = h('span', 'gif-tile-label');
  if (iconName) text.append(icon(iconName, 18));
  text.append(label);
  b.append(text);
  b.onclick = onClick;
  return b;
}

async function renderGifBody() {
  if (!gifScroll) return;
  gifScroll.replaceChildren();
  gifScroll.scrollTop = 0;

  if (gif.view === 'home') {
    if (!gif.home) {
      gifScroll.append(h('div', 'picker-empty', 'Carregando…'));
      try { gif.home = await request({ t: 'gif:home' }); } catch (err) {
        gifScroll.replaceChildren(h('div', 'picker-empty', err.message));
        return;
      }
      if (gif.view !== 'home') return;
      gifScroll.replaceChildren();
    }
    const tiles = h('div', 'gif-tiles');
    const favs = favorites();
    if (favs.length) {
      tiles.append(tile('Favoritos', favs[0].preview, () => { gif.view = 'favorites'; gif.title = 'Favoritos'; renderGifBody(); }, 'star'));
    }
    tiles.append(tile('GIFs em alta', gif.home.trending, () => openGifList({ q: '', title: 'GIFs em alta', view: 'trending' }), 'trending-up'));
    for (const c of gif.home.categories) {
      tiles.append(tile(c.label, c.preview, () => {
        gifInput.value = c.q;
        openGifList({ q: c.q, title: c.label, view: 'search' });
      }));
    }
    gifScroll.append(tiles);
    return;
  }

  // Lista (busca, em alta ou favoritos)
  const head = h('div', 'gif-list-head');
  const back = h('button', 'icon-btn tiny');
  back.type = 'button';
  back.title = 'Voltar';
  back.append(icon('arrow-left', 16));
  back.onclick = () => { gif.view = 'home'; gifInput.value = ''; renderGifBody(); gifInput.focus(); };
  head.append(back, h('span', '', gif.title));
  const cols = h('div', 'gif-cols');
  cols.append(h('div', 'gif-col'), h('div', 'gif-col'));
  gifScroll.append(head, cols);

  if (gif.view === 'favorites') {
    const favs = favorites();
    if (!favs.length) gifScroll.append(h('div', 'picker-empty', 'Clique na estrela de um GIF para guardar aqui.'));
    appendGifItems(favs);
  } else {
    appendGifItems(gif.items);
    if (gif.loading) gifScroll.append(h('div', 'picker-empty', 'Carregando…'));
    else if (!gif.items.length) gifScroll.append(h('div', 'picker-empty', 'Nenhum GIF encontrado.'));
  }
}

// Distribui os GIFs em 2 colunas (sempre na mais baixa), como um mural
function appendGifItems(items) {
  const [a, b] = gifScroll.querySelectorAll('.gif-col');
  if (!a) return;
  for (const item of items) {
    const col = (a._h ?? 0) <= (b._h ?? 0) ? a : b;
    col._h = (col._h ?? 0) + item.height / item.width;
    const cell = h('div', 'gif-item');
    cell.style.aspectRatio = `${item.width} / ${item.height}`;
    const img = h('img');
    img.src = item.preview;
    img.alt = item.title || 'GIF';
    img.loading = 'lazy';
    img.onclick = () => sendGif(item);
    const star = h('button', 'gif-star');
    star.type = 'button';
    star.title = 'Favoritar';
    star.append(icon('star', 18));
    star.classList.toggle('on', isFavorite(item.url));
    star.onclick = (e) => {
      e.stopPropagation();
      toggleFavorite(item);
      star.classList.toggle('on', isFavorite(item.url));
    };
    cell.append(img, star);
    col.append(cell);
  }
}

function openGifList({ q, title, view }) {
  Object.assign(gif, { q, title, view, items: [], nextOffset: 0, hasMore: false });
  loadGifs();
}

async function loadGifs() {
  const token = ++gif.token;
  gif.loading = true;
  const first = gif.items.length === 0;
  if (first) renderGifBody();
  try {
    const res = await request({ t: 'gif:search', q: gif.q, offset: gif.nextOffset });
    if (token !== gif.token) return; // chegou a resposta de uma busca antiga
    gif.loading = false;
    gif.items.push(...res.items);
    gif.nextOffset = res.nextOffset;
    gif.hasMore = res.hasMore;
    if (first) renderGifBody();
    else appendGifItems(res.items);
  } catch (err) {
    if (token !== gif.token) return;
    gif.loading = false;
    gif.hasMore = false;
    showBanner(err.message, { timeout: 4000 });
    if (first) renderGifBody();
  }
}

// ----- Abrir/fechar -----

function renderPicker() {
  panel.replaceChildren();
  const tabs = h('div', 'picker-tabs');
  for (const [id, label] of [['gifs', 'GIFs'], ['emoji', 'Emoji']]) {
    const b = h('button', 'picker-tab', label);
    b.type = 'button';
    b.classList.toggle('active', tab === id);
    b.onclick = () => openPicker(id);
    tabs.append(b);
  }
  panel.append(tabs, tab === 'gifs' ? gifTab() : emojiTab());
}

function openPicker(which) {
  tab = which;
  gif.view = 'home'; // sempre abre na tela inicial (blocos de categoria)
  gif.token++;       // ignora respostas de buscas anteriores
  if (which !== 'gifs') gifScroll = gifInput = null;
  renderPicker();
  panel.hidden = false;
  $('btn-gif').classList.toggle('on', which === 'gifs');
  $('btn-emoji').classList.toggle('on', which === 'emoji');
}

export function closeEmojiPanel() {
  panel.hidden = true;
  $('btn-emoji').classList.remove('on');
  $('btn-gif').classList.remove('on');
}

$('btn-emoji').onclick = (e) => {
  e.stopPropagation();
  if (!panel.hidden && tab === 'emoji') return closeEmojiPanel();
  openPicker('emoji');
};
$('btn-gif').onclick = (e) => {
  e.stopPropagation();
  if (!panel.hidden && tab === 'gifs') return closeEmojiPanel();
  openPicker('gifs');
};
panel.addEventListener('click', (e) => e.stopPropagation());
document.addEventListener('click', () => { if (!panel.hidden) closeEmojiPanel(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !panel.hidden) closeEmojiPanel(); });
