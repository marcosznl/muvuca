// Reações nas mensagens: os botõezinhos embaixo da mensagem e o seletor rápido de emoji
import { h, showBanner } from './util.js';
import { icon } from './icons.js';
import { state, nameOf } from './state.js';
import { request } from './net.js';
import { usableEmojis } from './richtext.js';
import { customEmojiImg } from './chat-content.js';
import { EMOJI_GROUPS } from './chat-picker.js';

const QUICK = ['👍', '❤️', '😂', '😮', '😢', '🔥', '🎉', '👀'];
const CUSTOM = /^<(a?):(\w{2,32}):(e-[0-9a-f]{10})>$/;

const emojiView = (emoji) => {
  const m = emoji.match(CUSTOM);
  return m ? customEmojiImg(m[2], m[3]) : document.createTextNode(emoji);
};
const emojiLabel = (emoji) => emoji.match(CUSTOM)?.[2] ? `:${emoji.match(CUSTOM)[2]}:` : emoji;

function react(msg, emoji, on) {
  request({ t: 'msg:react', id: msg.id, emoji, on }).catch((err) => showBanner(err.message, { timeout: 3500 }));
}
const isMine = (msg, emoji) => !!msg.reactions?.find((r) => r.emoji === emoji)?.users.includes(state.me?.id);

// Os botões de reação (clique liga/desliga a sua)
export function reactionsView(msg, canReact) {
  const box = h('div', 'reactions');
  for (const r of msg.reactions ?? []) {
    const b = h('button', 'reaction');
    b.type = 'button';
    b.dataset.emoji = r.emoji;
    b.classList.toggle('mine', r.users.includes(state.me?.id));
    b.append(emojiView(r.emoji), h('span', 'count', String(r.users.length)));
    const names = r.users.map((id) => (id === state.me?.id ? 'você' : nameOf(id) ?? 'alguém'));
    b.title = `${names.slice(0, 10).join(', ')}${names.length > 10 ? ` e mais ${names.length - 10}` : ''} — ${emojiLabel(r.emoji)}`;
    if (canReact) b.onclick = (e) => { e.stopPropagation(); react(msg, r.emoji, !isMine(msg, r.emoji)); };
    else b.disabled = true;
    box.append(b);
  }
  if (canReact && msg.reactions?.length) {
    const add = h('button', 'reaction add');
    add.type = 'button';
    add.title = 'Adicionar reação';
    add.append(icon('smile', 16));
    add.onclick = (e) => { e.stopPropagation(); openReactionPicker(msg, add); };
    box.append(add);
  }
  return box;
}

// ---------- Seletor de emoji para reagir ----------

let picker = null;

export function closeReactionPicker() {
  picker?.remove();
  picker = null;
  document.removeEventListener('mousedown', outside, true);
}
function outside(e) { if (picker && !picker.contains(e.target)) closeReactionPicker(); }
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeReactionPicker(); });

export function openReactionPicker(msg, anchor) {
  closeReactionPicker();
  const box = h('div', 'react-picker');
  const choice = (emoji) => {
    const b = h('button', CUSTOM.test(emoji) ? 'emoji custom' : 'emoji');
    b.type = 'button';
    b.title = emojiLabel(emoji);
    b.append(emojiView(emoji));
    b.onclick = (e) => {
      e.stopPropagation();
      if (!isMine(msg, emoji)) react(msg, emoji, true);
      if (!e.shiftKey) closeReactionPicker(); // Shift+clique escolhe vários
    };
    return b;
  };
  const quick = h('div', 'react-quick');
  for (const e of QUICK) quick.append(choice(e));
  const scroll = h('div', 'picker-scroll react-scroll');
  const custom = usableEmojis(state.servers, state.view.serverId);
  const groups = custom.length ? [['Emojis dos servidores', custom.map((e) => `<${e.animated ? 'a' : ''}:${e.name}:${e.id}>`)]] : [];
  for (const [title, list] of [...groups, ...EMOJI_GROUPS.map(([t, l]) => [t, l.split(' ')])]) {
    scroll.append(h('div', 'emoji-title', title));
    const grid = h('div', 'emoji-grid');
    for (const e of list) grid.append(choice(e));
    scroll.append(grid);
  }
  box.append(quick, scroll);
  document.getElementById('overlay-layer').append(box);
  // Perto do botão, sempre dentro da tela
  const a = anchor.getBoundingClientRect();
  const r = box.getBoundingClientRect();
  box.style.left = `${Math.max(8, Math.min(a.right - r.width, innerWidth - r.width - 8))}px`;
  box.style.top = `${a.top - r.height - 6 > 8 ? a.top - r.height - 6 : Math.min(a.bottom + 6, innerHeight - r.height - 8)}px`;
  picker = box;
  setTimeout(() => document.addEventListener('mousedown', outside, true), 0);
}
