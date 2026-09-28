// Conteúdo de uma mensagem na tela: texto com emojis, menções e links; GIF; fotos e vídeos
import { $, h } from './util.js';
import { state, nameOf } from './state.js';
import { openProfileCard } from './profile.js';
import { CUSTOM_EMOJI, isJumbo } from './richtext.js';

export const emojiUrl = (id) => `/emoji/${id}`;

export function customEmojiImg(name, id, big = false) {
  const img = h('img', big ? 'custom-emoji jumbo' : 'custom-emoji');
  img.src = emojiUrl(id);
  img.alt = `:${name}:`;
  img.title = `:${name}:`;
  img.draggable = false;
  img.onerror = () => { // emoji excluído: vira texto (em tamanho normal)
    img.parentElement?.classList.remove('jumbo');
    img.replaceWith(document.createTextNode(`:${name}:`));
  };
  return img;
}

function mentionChip(userId) {
  const chip = h('span', 'mention', `@${nameOf(userId) ?? 'alguém'}`);
  if (userId === state.me?.id) chip.classList.add('me');
  chip.onclick = (e) => { e.stopPropagation(); openProfileCard(userId, e.clientX, e.clientY); };
  return chip;
}

// Links viram <a> sem nunca interpretar HTML vindo de outras pessoas (e as menções viram destaque)
function appendLinkified(el, text) {
  text.split(/(https?:\/\/[^\s<>"]+)/g).forEach((part, i) => {
    if (i % 2 === 0) {
      part.split(/(<@u\d+>)/g).forEach((piece, j) => {
        if (j % 2) el.append(mentionChip(piece.slice(2, -1)));
        else if (piece) el.append(document.createTextNode(piece));
      });
      return;
    }
    const a = h('a', '', part);
    a.href = part;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    el.append(a);
  });
}

// Texto com emojis do servidor, menções e links (só emojis: grandes, como no Discord)
export function appendRich(el, text) {
  const jumbo = isJumbo(text);
  if (jumbo) el.classList.add('jumbo');
  let last = 0;
  for (const m of text.matchAll(CUSTOM_EMOJI)) {
    appendLinkified(el, text.slice(last, m.index));
    el.append(customEmojiImg(m[2], m[3], jumbo));
    last = m.index + m[0].length;
  }
  appendLinkified(el, text.slice(last));
}

// Mensagem que é só um GIF do Giphy
export function appendGif(el, url) {
  const img = h('img', 'msg-gif');
  img.src = url;
  img.alt = 'GIF';
  img.loading = 'lazy';
  // A imagem aumenta a altura da conversa ao carregar: quem estava no fim continua no fim
  img.onload = () => {
    const b = $('messages');
    if (b.contains(img) && b.scrollHeight - b.scrollTop - b.clientHeight - img.offsetHeight < 120) b.scrollTop = b.scrollHeight;
  };
  el.append(img);
}

// Anexos na conversa: fotos em grade (clique amplia) e vídeos com player
export function attachmentsView(list) {
  const box = h('div', list.length > 1 ? 'attachments multi' : 'attachments');
  for (const a of list) {
    if (a.kind === 'video') {
      const v = h('video', 'att-video');
      Object.assign(v, { src: a.url, controls: true, preload: 'metadata', playsInline: true });
      if (a.width && a.height) v.style.aspectRatio = `${a.width} / ${a.height}`;
      box.append(v);
    } else {
      const img = h('img', 'att-image');
      Object.assign(img, { src: a.url, alt: a.name, loading: 'lazy' });
      if (a.width && a.height) img.style.aspectRatio = `${a.width} / ${a.height}`;
      img.onclick = () => openLightbox(a);
      box.append(img);
    }
  }
  return box;
}

// Foto em tela cheia (Esc ou clique fecha)
function openLightbox(a) {
  const layer = h('div', 'lightbox');
  const img = h('img');
  img.src = a.url;
  img.alt = a.name;
  const link = h('a', 'lightbox-link', 'Abrir original');
  Object.assign(link, { href: a.url, target: '_blank', rel: 'noopener' });
  layer.append(img, link);
  const close = () => { layer.remove(); document.removeEventListener('keydown', onKey, true); };
  const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); close(); } };
  layer.onclick = (e) => { if (e.target !== link) close(); };
  document.addEventListener('keydown', onKey, true);
  document.body.append(layer);
}
