// Modo manutenção (ligado pelo painel administrativo): faixa de aviso no topo para todo mundo e, com o
// acesso travado, uma tela de "Em manutenção" que continua tentando conectar e some sozinha quando acaba.
import { $ } from './util.js';

let timer = null;

function minutesLeft(until) {
  const min = Math.ceil((until - Date.now()) / 60_000);
  return min <= 0 ? 'a qualquer momento' : min === 1 ? 'em 1 minuto' : `em ${min} minutos`;
}

export function renderMaintBar(state) {
  const bar = $('maint-bar');
  clearInterval(timer);
  if (!state?.on) { bar.hidden = true; return; }
  const paint = () => { bar.textContent = `🛠️ ${state.message}${state.until ? ` (${minutesLeft(state.until)})` : ''}`; };
  paint();
  bar.hidden = false;
  if (state.until) timer = setInterval(paint, 20_000);
}

export function showLock(text, { retrying = true } = {}) {
  const box = $('maint-lock');
  box.querySelector('.maint-lock-text').textContent = text;
  box.querySelector('.maint-lock-sub').textContent = retrying ? 'O Muvuca volta sozinho assim que terminar — pode deixar esta aba aberta.' : '';
  box.hidden = false;
}

export function hideLock() { $('maint-lock').hidden = true; }
