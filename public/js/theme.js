// Tema: escuro (padrão), claro ou automático (segue o sistema). O index.html já aplica antes de desenhar a página.
import { store } from './util.js';

export const THEMES = [['dark', 'Escuro'], ['light', 'Claro'], ['auto', 'Automático (do sistema)']];
export const currentTheme = () => store.get('theme') || 'dark';
const systemLight = matchMedia('(prefers-color-scheme: light)');

export function applyTheme() {
  const t = currentTheme();
  const light = t === 'light' || (t === 'auto' && systemLight.matches);
  document.documentElement.dataset.theme = light ? 'light' : 'dark';
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', light ? '#e3e5e8' : '#1e1f22');
}

export function setTheme(t) {
  store.set('theme', t === 'dark' ? null : t);
  applyTheme();
}

systemLight.addEventListener('change', applyTheme);
applyTheme();
