// Conta ao servidor em que o site está rodando (app do computador e versão, app instalado no celular ou
// navegador) e manda os erros que acontecem aqui, para o painel mostrar antes de alguém reclamar.
// Só erros do próprio Muvuca: extensões, falta de internet e permissões negadas ficam de fora.
import { send, connected } from './net.js';

const desktop = window.muvucaDesktop;
let info = null;
export async function clientInfo() {
  if (info) return info;
  const standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
  const ua = navigator.userAgent;
  const platform = desktop?.platform === 'darwin' ? 'Mac' : desktop?.platform === 'win32' ? 'Windows'
    : /iPhone|iPad/.test(ua) ? 'iPhone' : /Android/.test(ua) ? 'Android' : /Mac/.test(ua) ? 'Mac' : /Windows/.test(ua) ? 'Windows' : /Linux/.test(ua) ? 'Linux' : '';
  const version = desktop ? (await desktop.info?.().catch(() => null))?.version ?? null : null;
  info = { app: desktop ? 'desktop' : standalone ? 'pwa' : 'web', version, platform };
  return info;
}

// Chamado quando o site conecta (welcome)
export async function reportClientInfo() {
  send({ t: 'client:info', ...(await clientInfo()) });
  flush();
}

// ---------- Erros ----------
const IGNORE = /ResizeObserver loop|^Script error\.?$|Failed to fetch|NetworkError|Load failed|NotAllowedError|AbortError|Permission denied|The play\(\) request was interrupted/i;
const seen = new Set();
const queue = [];
let sentAt = [];
function report(message, stack, source) {
  message = String(message ?? '').slice(0, 300);
  if (!message || IGNORE.test(message) || seen.has(message)) return;
  // Arquivo de fora (extensão do navegador, script de terceiros): não é do Muvuca
  if (source && !source.startsWith(location.origin)) return;
  seen.add(message);
  queue.push({ t: 'client:error', message, stack: String(stack ?? '').slice(0, 2000), source: source ?? '', page: location.pathname });
  if (queue.length > 10) queue.shift();
  flush();
}
function flush() {
  const now = Date.now();
  sentAt = sentAt.filter((t) => now - t < 10 * 60_000);
  while (queue.length && connected() && sentAt.length < 10) { send(queue.shift()); sentAt.push(now); }
}
window.addEventListener('error', (e) => {
  if (!e.message) return; // erro ao carregar uma imagem ou arquivo: não é falha do código
  report(e.message, e.error?.stack, e.filename);
});
window.addEventListener('unhandledrejection', (e) => {
  const r = e.reason;
  report(r?.message ?? String(r), r?.stack, (/\((https?:[^)]+?):\d+:\d+\)/.exec(r?.stack ?? '') ?? [])[1] ?? '');
});
