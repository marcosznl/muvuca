// Utilidades de interface usadas por todo o site

export const $ = (id) => document.getElementById(id);

export function h(tag, className, text) {
  const el = document.createElement(tag);
  if (className) el.className = className;
  if (text !== undefined) el.textContent = text;
  return el;
}

// localStorage pode falhar (aba anônima etc.), então tudo passa por aqui
export const store = {
  get(key) { try { return localStorage.getItem(`calldireta:${key}`); } catch { return null; } },
  set(key, value) {
    try {
      if (value === null || value === undefined) localStorage.removeItem(`calldireta:${key}`);
      else localStorage.setItem(`calldireta:${key}`, value);
    } catch {}
  },
};

export function hue(str) {
  let n = 0;
  for (const ch of str) n = (n * 31 + ch.codePointAt(0)) % 360;
  return n;
}

export const imageUrl = (id) => `/img/${id}`;

// Quem sabe a foto de cada pessoa (o state.js registra; evita importar o estado aqui)
let avatarLookup = () => null;
export const setAvatarLookup = (fn) => { avatarLookup = fn; };

// Foto da pessoa; sem foto, a inicial na cor dela
export function makeAvatar(name, size = '', userId = null) {
  const el = document.createElement('div');
  el.className = `avatar ${size}`;
  const avatar = userId ? avatarLookup(userId) : null;
  if (avatar) {
    el.classList.add('photo');
    el.style.backgroundImage = `url("${imageUrl(avatar)}")`;
  } else {
    el.style.background = `hsl(${hue(name)} 50% 45%)`;
    el.textContent = ([...name][0] || '?').toUpperCase();
  }
  return el;
}

// Ícone do servidor: a imagem, ou as iniciais na cor do servidor
export function paintServerIcon(el, server) {
  el.classList.toggle('photo', !!server.icon);
  el.style.setProperty('--server-color', server.color);
  el.style.backgroundImage = server.icon ? `url("${imageUrl(server.icon)}")` : '';
  el.textContent = server.icon ? '' : serverInitials(server.name);
}

// Ícone de servidor: iniciais das palavras ("Minha Faculdade" -> "MF")
export function serverInitials(name) {
  const words = name.trim().split(/\s+/).filter(Boolean);
  return (words.length > 1 ? words.slice(0, 3).map((w) => [...w][0]).join('') : [...name].slice(0, 2).join('')).toUpperCase();
}

const pad = (n) => String(n).padStart(2, '0');
export const hhmm = (d) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;
export const sameDay = (a, b) => new Date(a).toDateString() === new Date(b).toDateString();

export function fmtTime(ts) {
  const d = new Date(ts);
  const yesterday = new Date(Date.now() - 86_400_000);
  if (d.toDateString() === new Date().toDateString()) return `hoje às ${hhmm(d)}`;
  if (d.toDateString() === yesterday.toDateString()) return `ontem às ${hhmm(d)}`;
  return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()} ${hhmm(d)}`;
}

export const fmtDay = (ts) => new Date(ts).toLocaleDateString('pt-BR', { day: 'numeric', month: 'long', year: 'numeric' });

let bannerTimer = null;
export function showBanner(text, { kind = 'error', timeout = 0, onClick = null } = {}) {
  const b = $('banner');
  b.textContent = text;
  b.className = `banner ${kind}`;
  b.hidden = false;
  b.onclick = onClick ? () => { onClick(); hideBanner(); } : null;
  clearTimeout(bannerTimer);
  if (timeout) bannerTimer = setTimeout(hideBanner, timeout);
}
export function hideBanner() { $('banner').hidden = true; }

export const toast = (text) => showBanner(text, { kind: 'info', timeout: 3500 });
