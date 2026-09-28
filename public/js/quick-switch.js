// Troca rápida (Ctrl+K ou ⌘K): digite o nome de um canal, conversa ou pessoa e pule direto para lá
import { h } from './util.js';
import { icon } from './icons.js';
import { state } from './state.js';
import { selectChannel, selectServer } from './app.js';
import { dmTitle, startDm } from './dms.js';

const fold = (t) => String(t ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
let open = null;

function candidates() {
  const out = [];
  const dmWith = new Set();
  for (const s of state.servers) {
    if (s.kind === 'dm') {
      const others = s.members.filter((m) => m.id !== state.me?.id);
      if (others.length === 1) dmWith.add(others[0].id);
      out.push({ label: dmTitle(s), where: 'Conversa', icon: 'chat', unread: state.unread[s.channels[0]?.id] || 0, go: () => selectServer(s.id) });
      continue;
    }
    for (const c of s.channels) {
      out.push({
        label: c.name, where: s.name, icon: { voice: 'speaker', music: 'headphones' }[c.type] ?? 'hash',
        unread: state.mentions[c.id] || 0, go: () => selectChannel(c.id),
      });
    }
  }
  // Pessoas dos seus servidores: abre (ou cria) a conversa com elas
  const seen = new Set();
  for (const s of state.servers.filter((x) => x.kind !== 'dm')) {
    for (const m of s.members) {
      if (m.id === state.me?.id || seen.has(m.id) || dmWith.has(m.id)) continue;
      seen.add(m.id);
      out.push({ label: m.name, where: `@${m.username} · mensagem direta`, icon: 'users', unread: 0, go: () => startDm([m.id]) });
    }
  }
  return out;
}

function rank(list, q) {
  if (!q) return [...list].sort((a, b) => b.unread - a.unread).slice(0, 12);
  const f = fold(q);
  return list.map((c) => {
    const l = fold(c.label);
    const score = l.startsWith(f) ? 3 : l.split(/[\s\-_,]+/).some((w) => w.startsWith(f)) ? 2 : l.includes(f) ? 1 : fold(c.where).includes(f) ? 0.5 : 0;
    return { c, score: score + (score && c.unread ? 0.2 : 0) };
  }).filter((x) => x.score > 0).sort((a, b) => b.score - a.score).slice(0, 12).map((x) => x.c);
}

export function closeQuickSwitch() {
  open?.remove();
  open = null;
}

export function openQuickSwitch() {
  if (open) return closeQuickSwitch();
  const all = candidates();
  const layer = h('div', 'quick-switch');
  const box = h('div', 'qs-box');
  const input = h('input', 'qs-input');
  input.placeholder = 'Para onde você quer ir?';
  const list = h('div', 'qs-list');
  const hint = h('div', 'qs-hint', '↑ ↓ escolhem · Enter abre · Esc fecha');
  box.append(input, list, hint);
  layer.append(box);
  let items = [];
  let sel = 0;
  const paint = () => {
    items = rank(all, input.value.trim());
    sel = Math.min(sel, Math.max(0, items.length - 1));
    list.replaceChildren();
    items.forEach((c, i) => {
      const b = h('button', i === sel ? 'qs-item on' : 'qs-item');
      b.type = 'button';
      b.append(icon(c.icon, 18), h('span', 'qs-label', c.label), h('span', 'qs-where', c.where));
      if (c.unread) b.append(h('span', 'badge', String(c.unread)));
      b.onmousemove = () => { if (sel !== i) { sel = i; paint(); } };
      b.onclick = () => go(c);
      list.append(b);
    });
    if (!items.length) list.append(h('div', 'qs-where', 'Nada com esse nome.'));
  };
  const go = (c) => { closeQuickSwitch(); c.go(); };
  input.oninput = () => { sel = 0; paint(); };
  input.onkeydown = (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); sel = Math.min(items.length - 1, sel + 1); paint(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); sel = Math.max(0, sel - 1); paint(); }
    else if (e.key === 'Enter') { e.preventDefault(); if (items[sel]) go(items[sel]); }
    else if (e.key === 'Escape') { e.preventDefault(); closeQuickSwitch(); }
  };
  layer.onmousedown = (e) => { if (e.target === layer) closeQuickSwitch(); };
  document.body.append(layer);
  open = layer;
  paint();
  input.focus();
}

document.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k' && state.me) {
    e.preventDefault();
    openQuickSwitch();
  }
});
