// Janelas (modal) e menus de contexto
import { h } from './util.js';
import { icon } from './icons.js';

const layer = () => document.getElementById('overlay-layer');

// Janela genérica: devolve { close, root }. `content` é um elemento; `actions` são botões.
export function openModal({ title, subtitle, content, actions = [], wide = false, onClose }) {
  const backdrop = h('div', 'modal-backdrop');
  const box = h('div', wide ? 'modal wide' : 'modal');
  const header = h('div', 'modal-header');
  header.append(h('h2', '', title));
  if (subtitle) header.append(h('p', 'muted', subtitle));
  const closeBtn = h('button', 'icon-btn modal-close');
  closeBtn.title = 'Fechar';
  closeBtn.append(icon('close', 20));
  header.append(closeBtn);
  box.append(header);
  if (content) {
    const body = h('div', 'modal-body');
    body.append(content);
    box.append(body);
  }
  if (actions.length) {
    const footer = h('div', 'modal-footer');
    for (const a of actions) footer.append(a);
    box.append(footer);
  }
  backdrop.append(box);
  layer().append(backdrop);

  const close = () => {
    backdrop.remove();
    document.removeEventListener('keydown', onKey);
    onClose?.();
  };
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  document.addEventListener('keydown', onKey);
  closeBtn.onclick = close;
  backdrop.addEventListener('mousedown', (e) => { if (e.target === backdrop) close(); });
  return { close, root: box };
}

export function button(label, { kind = 'primary', onClick } = {}) {
  const b = h('button', `btn ${kind}`, label);
  b.type = 'button';
  if (onClick) b.onclick = onClick;
  return b;
}

// Pergunta um texto (ex.: nome do canal). Resolve com o texto ou null se cancelar.
export function promptText({ title, subtitle, label, value = '', placeholder = '', confirm = 'Salvar', maxLength = 40, prefix, allowEmpty = false }) {
  return new Promise((resolve) => {
    const form = h('form', 'form');
    const field = h('label', 'field');
    field.append(h('span', 'field-label', label));
    const wrap = h('div', prefix ? 'input-prefix' : '');
    const input = h('input');
    Object.assign(input, { value, placeholder, maxLength });
    if (prefix) wrap.append(prefix);
    wrap.append(input);
    field.append(prefix ? wrap : input);
    form.append(field);
    let done = false;
    const ok = button(confirm);
    const cancel = button('Cancelar', { kind: 'link' });
    const modal = openModal({ title, subtitle, content: form, actions: [cancel, ok], onClose: () => { if (!done) resolve(null); } });
    const submit = (e) => {
      e?.preventDefault();
      if (!input.value.trim() && !allowEmpty) return input.focus();
      done = true;
      modal.close();
      resolve(input.value.trim());
    };
    form.onsubmit = submit;
    ok.onclick = submit;
    cancel.onclick = () => modal.close();
    setTimeout(() => { input.focus(); input.select(); }, 0);
  });
}

// Confirmação (ex.: excluir). Resolve true/false.
export function confirmDialog({ title, message, confirm = 'Confirmar', danger = true }) {
  return new Promise((resolve) => {
    let done = false;
    const ok = button(confirm, { kind: danger ? 'danger' : 'primary' });
    const cancel = button('Cancelar', { kind: 'link' });
    const modal = openModal({ title, content: h('p', 'confirm-text', message), actions: [cancel, ok], onClose: () => { if (!done) resolve(false); } });
    ok.onclick = () => { done = true; modal.close(); resolve(true); };
    cancel.onclick = () => modal.close();
    setTimeout(() => ok.focus(), 0);
  });
}

// Menu flutuante (clique direito ou botão "▾"). items: [{ label, icon, danger, onClick }] ou 'sep'
let openMenu = null;
export function contextMenu(x, y, items) {
  closeMenu();
  const menu = h('div', 'context-menu');
  for (const item of items.filter(Boolean)) {
    if (item === 'sep') { menu.append(h('div', 'menu-sep')); continue; }
    const b = h('button', item.danger ? 'menu-item danger' : 'menu-item');
    b.append(h('span', '', item.label));
    if (item.icon) b.append(icon(item.icon, 16));
    b.onclick = () => { closeMenu(); item.onClick(); };
    menu.append(b);
  }
  layer().append(menu);
  // Mantém o menu dentro da tela
  const r = menu.getBoundingClientRect();
  menu.style.left = `${Math.min(x, innerWidth - r.width - 8)}px`;
  menu.style.top = `${Math.min(y, innerHeight - r.height - 8)}px`;
  openMenu = menu;
  setTimeout(() => document.addEventListener('mousedown', outside), 0);
}

function outside(e) { if (openMenu && !openMenu.contains(e.target)) closeMenu(); }
export function closeMenu() {
  openMenu?.remove();
  openMenu = null;
  document.removeEventListener('mousedown', outside);
}
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeMenu(); });
