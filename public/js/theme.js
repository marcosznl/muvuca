// Tema de cada pessoa: temas padrão (claro, escuro, mais escuro, preto), "mesmo do aparelho" e temas
// coloridos (degradê). Fica salvo na conta (vale em todos os aparelhos) e também no aparelho, para o
// index.html aplicar antes de desenhar a página (sem piscar).
//
// Tema colorido: o degradê aparece no fundo das áreas grandes (colunas e conversa); caixas, menus e
// cartões usam cores sólidas puxadas para o tom do tema, para o texto continuar fácil de ler.
import { store } from './util.js';

// Temas padrão: cores das superfícies (as mesmas variáveis do style.css)
export const BASE_THEMES = [
  { id: 'light', name: 'Claro', mode: 'light', swatch: '#ffffff' },
  { id: 'dark', name: 'Escuro', mode: 'dark', swatch: '#313338' },
  { id: 'darker', name: 'Mais escuro', mode: 'dark', swatch: '#1a1a1e',
    vars: { main: '#1a1a1e', side: '#141417', dark: '#0e0e10', hover: '#232328', active: '#2c2c33', tile: '#141417' } },
  { id: 'black', name: 'Preto', mode: 'dark', swatch: '#000000',
    vars: { main: '#000000', side: '#0b0b0c', dark: '#000000', hover: '#17171a', active: '#222226', tile: '#0e0e10' } },
];

// Temas coloridos: base clara ou escura + as cores do degradê (de cima/esquerda para baixo/direita)
export const COLOR_THEMES = [
  { id: 'menta', name: 'Menta', mode: 'light', colors: ['#97d7a5', '#cfe8ad'] },
  { id: 'damasco', name: 'Damasco', mode: 'light', colors: ['#fbd38d', '#f4a7a2'] },
  { id: 'nevoa', name: 'Névoa', mode: 'light', colors: ['#aab3e2', '#9fd3d8'] },
  { id: 'limonada', name: 'Limonada', mode: 'light', colors: ['#e3f1b6', '#f8d5b3'] },
  { id: 'rosa-antigo', name: 'Rosa antigo', mode: 'light', colors: ['#d8a6ba', '#cbc39c'] },
  { id: 'algodao', name: 'Algodão-doce', mode: 'light', colors: ['#f6c4d6', '#c6d2f6'] },
  { id: 'ceu', name: 'Céu de manhã', mode: 'light', colors: ['#b7d6f3', '#d8efc3'] },
  { id: 'baunilha', name: 'Baunilha', mode: 'light', colors: ['#efe5c6', '#e8d6cf'] },
  { id: 'crepusculo', name: 'Crepúsculo', mode: 'dark', colors: ['#3b2a6b', '#a5583a'] },
  { id: 'neon', name: 'Neon', mode: 'dark', colors: ['#2b2fa3', '#a13ab0', '#1f9fb8'] },
  { id: 'floresta', name: 'Floresta', mode: 'dark', colors: ['#1f3a2c', '#6f5b2a'] },
  { id: 'brasa', name: 'Brasa', mode: 'dark', colors: ['#6a0b16', '#120205'] },
  { id: 'meia-noite', name: 'Meia-noite', mode: 'dark', colors: ['#24245e', '#09091a'] },
  { id: 'cafe', name: 'Café', mode: 'dark', colors: ['#6a352d', '#3a1f1b'] },
  { id: 'chumbo', name: 'Chumbo', mode: 'dark', colors: ['#3e3f4e', '#777a90'] },
  { id: 'musgo', name: 'Musgo', mode: 'dark', colors: ['#40604f', '#2b4237'] },
  { id: 'oceano', name: 'Oceano', mode: 'dark', colors: ['#2b4a86', '#257f86'] },
  { id: 'aurora', name: 'Aurora', mode: 'dark', colors: ['#12806b', '#5b2a86'] },
  { id: 'por-do-sol', name: 'Pôr do sol', mode: 'dark', colors: ['#a3125a', '#d99a24'] },
  { id: 'boreal', name: 'Boreal', mode: 'dark', colors: ['#0e5a3a', '#1d4f9e', '#0c2a52'] },
  { id: 'terra', name: 'Terra', mode: 'dark', colors: ['#6b5a3e', '#2e2618'] },
  { id: 'safira', name: 'Safira', mode: 'dark', colors: ['#2236b8', '#0f1a5c'] },
];

// O que fica salvo: 'auto', um tema padrão ('dark'…) ou 'color:<id>'
export const validTheme = (t) => t === 'auto' || BASE_THEMES.some((b) => b.id === t) || COLOR_THEMES.some((c) => `color:${c.id}` === t);
export const currentTheme = () => (validTheme(store.get('theme')) ? store.get('theme') : 'dark');
const systemLight = matchMedia('(prefers-color-scheme: light)');

// ---------- Contas de cor ----------
const rgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
const toHex = (c) => `#${c.map((v) => Math.round(Math.min(255, Math.max(0, v))).toString(16).padStart(2, '0')).join('')}`;
// Mistura: `amount` de a com o resto de b
export const mix = (a, b, amount) => toHex(rgb(a).map((v, i) => v * amount + rgb(b)[i] * (1 - amount)));
const average = (colors) => toHex(colors.map(rgb).reduce((s, c) => s.map((v, i) => v + c[i] / colors.length), [0, 0, 0]));
export const gradientOf = (colors, angle = 135) => `linear-gradient(${angle}deg, ${colors.join(', ')})`;

// Variáveis de cor de um tema (nomes do style.css, sem o "--bg-")
export function themeVars(theme) {
  const [kind, id] = theme.startsWith('color:') ? ['color', theme.slice(6)] : ['base', theme];
  if (kind === 'base') {
    const base = BASE_THEMES.find((b) => b.id === id) ?? BASE_THEMES[1];
    return { mode: base.mode, color: null, vars: base.vars ?? null };
  }
  const t = COLOR_THEMES.find((c) => c.id === id);
  if (!t) return { mode: 'dark', color: null, vars: null };
  const tone = average(t.colors);
  const vars = t.mode === 'light'
    ? { main: mix(tone, '#ffffff', 0.16), side: mix(tone, '#f2f3f5', 0.28), dark: mix(tone, '#e3e5e8', 0.38), hover: mix(tone, '#ececee', 0.3), active: mix(tone, '#dcdde0', 0.42), tile: mix(tone, '#ebedef', 0.3) }
    : { main: mix(tone, '#232428', 0.32), side: mix(tone, '#1b1c1f', 0.28), dark: mix(tone, '#141517', 0.22), hover: mix(tone, '#2e3035', 0.34), active: mix(tone, '#3a3c42', 0.4), tile: mix(tone, '#1e1f22', 0.3) };
  return { mode: t.mode, color: t.id, vars, gradient: gradientOf(t.colors) };
}

// ---------- Aplicar ----------
const VAR_NAMES = { main: '--bg-main', side: '--bg-side', dark: '--bg-dark', hover: '--bg-hover', active: '--bg-active', tile: '--tile' };

export function applyTheme(theme = currentTheme()) {
  const t = theme === 'auto' ? (systemLight.matches ? 'light' : 'dark') : theme;
  const { mode, color, vars, gradient } = themeVars(t);
  const root = document.documentElement;
  root.dataset.theme = mode;
  if (color) root.dataset.color = color; else delete root.dataset.color;
  const props = {};
  for (const [k, name] of Object.entries(VAR_NAMES)) props[name] = vars?.[k] ?? '';
  props['--theme-gradient'] = gradient ?? '';
  for (const [name, value] of Object.entries(props)) {
    if (value) root.style.setProperty(name, value); else root.style.removeProperty(name);
  }
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', vars?.dark ?? (mode === 'light' ? '#e3e5e8' : '#1e1f22'));
  // Para o index.html aplicar já na próxima abertura (antes do site carregar)
  store.set('themeBoot', JSON.stringify({ mode, color, props }));
}

// Escolheu um tema: aplica, guarda no aparelho e na conta (os outros aparelhos recebem na hora)
let saveToAccount = null;
export const onThemeSaved = (fn) => { saveToAccount = fn; };
export function setTheme(t) {
  if (!validTheme(t)) return;
  store.set('theme', t === 'dark' ? null : t);
  applyTheme(t);
  saveToAccount?.(t);
}
// Veio da conta (outro aparelho escolheu, ou ao entrar): aplica sem mandar de volta
export function receiveTheme(t) {
  if (!validTheme(t) || t === currentTheme()) return;
  store.set('theme', t === 'dark' ? null : t);
  applyTheme(t);
}

systemLight.addEventListener('change', () => { if (currentTheme() === 'auto') applyTheme(); });
applyTheme();
