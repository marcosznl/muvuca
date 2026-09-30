// Conteúdo de uma mensagem na tela: texto com emojis, menções e links; GIF; fotos e vídeos
import { $, h } from './util.js';
import { state, nameOf, serverById } from './state.js';
import { openProfileCard } from './profile.js';
import { CUSTOM_EMOJI, GIF_URL, isJumbo, parseMarkdown } from './richtext.js';
import { request } from './net.js';
import { voiceNote } from './chat-voice.js';
import { icon } from './icons.js';

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
  // @todos e @cargo: destaque (cor do cargo); em você também quando te inclui
  if (userId === 'todos' || userId.startsWith('&')) {
    const server = serverById(state.view.serverId);
    const role = userId.startsWith('&') ? server?.roles.find((r) => r.id === userId.slice(1)) : null;
    const chip = h('span', 'mention group', `@${nameOf(userId) ?? 'cargo'}`);
    if (role?.color) chip.style.setProperty('--role-color', role.color);
    const mine = server?.members.find((m) => m.id === state.me?.id);
    if (userId === 'todos' || (role && mine?.roles.includes(role.id))) chip.classList.add('me');
    return chip;
  }
  const chip = h('span', 'mention', `@${nameOf(userId) ?? 'alguém'}`);
  if (userId === state.me?.id) chip.classList.add('me');
  chip.onclick = (e) => { e.stopPropagation(); openProfileCard(userId, e.clientX, e.clientY); };
  return chip;
}

// Links viram <a> sem nunca interpretar HTML vindo de outras pessoas (e as menções viram destaque)
function appendLinkified(el, text) {
  text.split(/(https?:\/\/[^\s<>"]+)/g).forEach((part, i) => {
    if (i % 2 === 0) {
      part.split(/(<@(?:u\d+|todos|&r-[0-9a-f]+)>)/g).forEach((piece, j) => {
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

// Pedaço de texto simples: emojis do servidor, menções e links
function appendLeaf(el, text, jumbo) {
  let last = 0;
  for (const m of text.matchAll(CUSTOM_EMOJI)) {
    appendLinkified(el, text.slice(last, m.index));
    el.append(customEmojiImg(m[2], m[3], jumbo));
    last = m.index + m[0].length;
  }
  appendLinkified(el, text.slice(last));
}

// Árvore da formatação -> elementos (nunca interpreta HTML de ninguém)
const TAGS = { bold: 'strong', italic: 'em', strike: 's', spoiler: 'span', quote: 'div' };
function appendNodes(el, nodes, jumbo) {
  for (const n of nodes) {
    if (n.type === 'text') appendLeaf(el, n.text, jumbo);
    else if (n.type === 'code') el.append(h('code', 'md-code', n.text));
    else if (n.type === 'codeblock') {
      const pre = h('pre', 'md-codeblock');
      pre.append(h('code', '', n.text));
      el.append(pre);
    } else {
      const tag = h(TAGS[n.type], n.type === 'spoiler' ? 'md-spoiler' : n.type === 'quote' ? 'md-quote' : '');
      if (n.type === 'spoiler') {
        tag.title = 'Spoiler: clique para ver';
        tag.onclick = (e) => { if (!tag.classList.contains('shown')) { e.stopPropagation(); tag.classList.add('shown'); } };
      }
      appendNodes(tag, n.children, jumbo);
      el.append(tag);
    }
  }
}

// Texto com formatação, emojis do servidor, menções e links (só emojis: grandes, como no Discord)
export function appendRich(el, text) {
  const jumbo = isJumbo(text);
  if (jumbo) el.classList.add('jumbo');
  appendNodes(el, parseMarkdown(text), jumbo);
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
    if (a.kind === 'audio') {
      box.append(voiceNote(a));
    } else if (a.kind === 'file') {
      box.append(documentCard(a));
    } else if (a.kind === 'video') {
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

// Documento: ícone, nome, tamanho e botão de baixar (o arquivo nunca abre dentro do site)
function documentCard(a) {
  const card = h('a', 'att-doc');
  Object.assign(card, { href: a.url, download: a.name, title: `Baixar ${a.name}` });
  const ext = (/\.([a-z0-9]{1,5})$/i.exec(a.name)?.[1] ?? '').toUpperCase();
  const ic = h('span', 'att-doc-icon');
  ic.append(icon('file', 34), h('span', 'att-doc-ext', ext));
  const info = h('span', 'att-doc-info');
  const size = a.size > 1024 * 1024 ? `${(a.size / 1024 / 1024).toFixed(1).replace('.', ',')} MB` : `${Math.ceil(a.size / 1024)} KB`;
  info.append(h('span', 'att-doc-name', a.name), h('span', 'att-doc-size', size));
  const dl = h('span', 'att-doc-dl');
  dl.append(icon('download', 20));
  card.append(ic, info, dl);
  return card;
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

// ---------- Prévia de links ----------

const previews = new Map(); // link -> Promise(prévia ou null)
function loadPreview(url) {
  if (!previews.has(url)) previews.set(url, request({ t: 'link:preview', url }).then((r) => r.preview).catch(() => null));
  return previews.get(url);
}

// Primeiro link "de verdade" da mensagem (fora de código e de spoiler)
function firstLink(text) {
  const walk = (nodes) => {
    for (const n of nodes) {
      if (n.type === 'text') { const m = n.text.match(/https?:\/\/[^\s<>"]+/); if (m) return m[0]; }
      if (n.children && n.type !== 'spoiler') { const r = walk(n.children); if (r) return r; }
    }
    return null;
  };
  return walk(parseMarkdown(text));
}

function linkCard(url, p) {
  const card = h('div', p.youtube ? 'link-card youtube' : 'link-card');
  const body = h('div', 'link-body');
  body.append(h('div', 'link-site', p.site));
  const title = h('a', 'link-title', p.title);
  Object.assign(title, { href: url, target: '_blank', rel: 'noopener noreferrer' });
  body.append(title);
  if (p.description) body.append(h('div', 'link-desc', p.description));
  card.append(body);
  if (p.image) {
    const img = h('img', 'link-image');
    Object.assign(img, { src: p.image, alt: '', loading: 'lazy', referrerPolicy: 'no-referrer' });
    img.onerror = () => img.remove();
    if (p.youtube) {
      // YouTube: clique toca o vídeo aqui mesmo (versão sem cookies)
      const player = h('div', 'yt-player');
      const play = h('button', 'yt-play', '▶');
      play.type = 'button';
      play.title = 'Assistir aqui';
      player.append(img, play);
      player.onclick = (e) => {
        e.stopPropagation();
        const frame = h('iframe', 'yt-frame');
        Object.assign(frame, { src: `https://www.youtube-nocookie.com/embed/${p.youtube}?autoplay=1`, allow: 'autoplay; encrypted-media; picture-in-picture', allowFullscreen: true });
        player.replaceWith(frame);
      };
      card.append(player);
    } else card.append(img);
  }
  return card;
}

// Lugar da prévia embaixo da mensagem (se ela tiver link); a prévia chega depois, sem pular a conversa
export function previewSlot(text) {
  if (!text || GIF_URL.test(text)) return null;
  const url = firstLink(text);
  if (!url) return null;
  const slot = h('div', 'link-slot');
  loadPreview(url).then((p) => {
    if (!p || !slot.isConnected) return;
    const b = $('messages');
    const atBottom = b.scrollHeight - b.scrollTop - b.clientHeight < 60;
    slot.append(linkCard(url, p));
    if (atBottom) b.scrollTop = b.scrollHeight;
  });
  return slot;
}
