// Notificações no celular/computador (menções e respostas) mesmo com o site fechado.
// No iPhone só funciona com o site instalado na Tela de Início (Compartilhar → Adicionar à Tela de Início).
import { h, showBanner, toast, store } from './util.js';
import { request } from './net.js';
import { openModal } from './dialogs.js';

let registration = null;

// Android/Chrome: o convite de "instalar o app" fica guardado para o botão Instalar
let installEvent = null;
window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); installEvent = e; });

export function setupPush() {
  if (!('serviceWorker' in navigator)) return;
  navigator.serviceWorker.register('/sw.js').then((reg) => { registration = reg; }).catch(() => {});
  // Tocou na notificação com o site já aberto: o service worker pede para ir ao canal
  navigator.serviceWorker.addEventListener('message', (e) => {
    if (e.data?.type === 'open' && e.data.url) location.href = e.data.url;
  });
}

// Já tinha permitido, mas o aparelho perdeu a inscrição (ex.: reinstalou na Tela de Início): refaz sozinho, sem perguntar
async function resubscribe(reg) {
  try {
    if (!pushEnabled()) return;
    const sub = await reg.pushManager.getSubscription() ?? await subscribe(reg);
    await request({ t: 'push:subscribe', sub: sub.toJSON() });
  } catch { /* tenta de novo na próxima vez que abrir */ }
}
async function subscribe(reg) {
  const { key } = await (await fetch('/api/push-key')).json();
  return reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: base64ToBytes(key) });
}

const isIOS = () => /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const installed = () => matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
export const pushSupported = () => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
export const pushEnabled = () => pushSupported() && Notification.permission === 'granted' && store.get('pushOff') !== '1'; // desligou aqui: fica desligado

function base64ToBytes(b64) {
  const s = atob((b64 + '='.repeat((4 - (b64.length % 4)) % 4)).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(s, (c) => c.charCodeAt(0));
}

function installHelp() {
  const content = h('div', 'form');
  content.append(
    h('p', '', 'No iPhone, as notificações só funcionam com o Muvuca instalado como app:'),
    h('ol', 'install-steps'),
  );
  const steps = content.querySelector('.install-steps');
  for (const step of ['Toque em Compartilhar (o quadrado com a seta) no Safari.', 'Escolha "Adicionar à Tela de Início".',
    'Abra o Muvuca pelo ícone novo e ative as notificações de novo.']) steps.append(h('li', '', step));
  openModal({ title: 'Instale na Tela de Início', content });
}

// Pede permissão e registra este aparelho no servidor
export async function enablePush() {
  if (isIOS() && !installed()) return installHelp();
  if (!pushSupported()) return showBanner('Este navegador não aceita notificações.', { timeout: 4000 });
  if (location.protocol !== 'https:' && location.hostname !== 'localhost') {
    return showBanner('Notificações só funcionam pelo endereço com https.', { timeout: 5000 });
  }
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') return showBanner('Notificações bloqueadas. Libere nas configurações do navegador.', { timeout: 5000 });
  try {
    const reg = registration ?? await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.getSubscription() ?? await subscribe(reg);
    await request({ t: 'push:subscribe', sub: sub.toJSON() });
    toast('Notificações ativadas! Você vai ser avisado de menções, respostas e mensagens diretas.');
    store.set('pushAsked', null);
    store.set('pushOff', null);
  } catch (err) {
    showBanner(`Não deu para ativar: ${err.message}`, { timeout: 5000 });
  }
}

export async function disablePush() {
  const reg = registration ?? await navigator.serviceWorker?.ready;
  const sub = await reg?.pushManager.getSubscription();
  if (sub) {
    await request({ t: 'push:unsubscribe', endpoint: sub.endpoint }).catch(() => {});
    await sub.unsubscribe().catch(() => {});
  }
  store.set('pushOff', '1');
  toast('Notificações desativadas neste aparelho.');
}

// Entrou (conexão pronta): confere a inscrição deste aparelho e, no celular, convida a ativar
let checked = false;
export async function pushAfterLogin() {
  if (checked || !('serviceWorker' in navigator)) return;
  checked = true;
  maybeInvitePush();
  const reg = registration ?? await navigator.serviceWorker.ready.catch(() => null);
  if (reg) resubscribe(reg);
}

// ---------- Convite no celular (uma vez por aparelho; se disser "agora não", volta a perguntar em 30 dias) ----------
const isPhone = () => /iPhone|iPad|iPod|Android/.test(navigator.userAgent) || (isIOS() && navigator.maxTouchPoints > 1);
export function maybeInvitePush() {
  if (window.muvucaDesktop || !isPhone() || pushEnabled() || store.get('pushOff') === '1') return; // desligou de propósito: não insiste
  if (!isIOS() && !pushSupported()) return;
  if (window.Notification?.permission === 'denied') return; // bloqueado no navegador: ele nem pergunta de novo
  const asked = Number(store.get('pushAsked') || 0);
  if (asked && Date.now() - asked < 30 * 86_400_000) return;
  setTimeout(() => {
    const content = h('div', 'push-invite');
    const needsInstall = isIOS() && !installed();
    content.append(h('p', '', needsInstall
      ? 'Para receber avisos no iPhone quando te mencionarem, responderem ou mandarem mensagem direta, instale o Muvuca na Tela de Início:'
      : 'Quer receber avisos neste celular quando te mencionarem, responderem ou mandarem mensagem direta?'));
    if (needsInstall) {
      const steps = h('ol', 'install-steps');
      for (const step of ['Toque em Compartilhar (o quadrado com a seta) aqui no Safari.', 'Escolha "Adicionar à Tela de Início".', 'Abra o Muvuca pelo ícone novo: este aviso aparece de novo para você ativar.']) steps.append(h('li', '', step));
      content.append(steps);
    }
    const later = h('button', 'btn link', needsInstall ? 'Entendi' : 'Agora não');
    const actions = [later];
    if (!needsInstall) {
      const yes = h('button', 'btn primary', 'Ativar avisos');
      yes.onclick = () => { modal.close(); enablePush(); };
      actions.push(yes);
    }
    if (installEvent && !installed()) {
      const install = h('button', 'btn secondary', 'Instalar o app');
      install.onclick = async () => { installEvent.prompt(); installEvent = null; };
      actions.unshift(install);
    }
    const modal = openModal({ title: 'Avisos no celular', content, actions, onClose: () => store.set('pushAsked', String(Date.now())) });
    later.onclick = () => modal.close();
  }, 4000); // depois de abrir, sem atrapalhar a primeira olhada
}
