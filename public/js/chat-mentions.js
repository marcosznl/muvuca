// Lista de membros ao digitar @ no campo de mensagem (setas escolhem, Enter/Tab confirmam, Esc fecha)
import { $, h, makeAvatar } from './util.js';
import { state } from './state.js';
import { mentionSuggestions } from './richtext.js';

const list = $('mention-list');
let current = null; // { start, items, index }

// Pessoas que dá para mencionar: as do servidor aberto
export const mentionables = () => [...(state.servers.find((s) => s.id === state.view.serverId)?.members ?? [])];

function update() {
  const input = $('chat-input');
  const before = input.value.slice(0, input.selectionStart ?? input.value.length);
  const m = before.match(/(^|\s)@([^\s@]{0,32})$/);
  if (!m) return close();
  const items = mentionSuggestions(mentionables(), m[2]);
  if (!items.length) return close();
  current = { start: before.length - m[2].length - 1, items, index: Math.min(current?.index ?? 0, items.length - 1) };
  render();
}

function render() {
  list.replaceChildren(h('div', 'mention-title', 'Membros'));
  current.items.forEach((p, i) => {
    const row = h('button', i === current.index ? 'mention-item active' : 'mention-item');
    row.type = 'button';
    row.append(makeAvatar(p.name, 'sm', p.id), h('span', 'mention-name', p.name), h('span', 'muted small', `@${p.username}`));
    row.onmousedown = (e) => { e.preventDefault(); pick(i); }; // mousedown: não tira o foco do campo
    list.append(row);
  });
  list.hidden = false;
}

function pick(i) {
  const p = current.items[i];
  const input = $('chat-input');
  const caret = input.selectionStart ?? input.value.length;
  const insert = `@${p.name} `;
  input.value = input.value.slice(0, current.start) + insert + input.value.slice(caret);
  const pos = current.start + insert.length;
  input.setSelectionRange(pos, pos);
  close();
  input.focus();
}

function close() {
  current = null;
  list.hidden = true;
}

const input = $('chat-input');
input.addEventListener('input', update);
input.addEventListener('click', update);
input.addEventListener('blur', () => setTimeout(close, 100));
// Na captura: roda antes dos outros atalhos do campo (↑ para editar, Enter para enviar)
input.addEventListener('keydown', (e) => {
  if (!current) return;
  const n = current.items.length;
  const stop = () => { e.preventDefault(); e.stopImmediatePropagation(); };
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    stop();
    current.index = (current.index + (e.key === 'ArrowDown' ? 1 : n - 1)) % n;
    render();
  } else if (e.key === 'Enter' || e.key === 'Tab') {
    stop();
    pick(current.index);
  } else if (e.key === 'Escape') {
    stop();
    close();
  }
}, true);
