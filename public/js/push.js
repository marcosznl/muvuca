// Notificações no celular/computador (menções e respostas) mesmo com o site fechado.
// No iPhone só funciona com o site instalado na Tela de Início (Compartilhar → Adicionar à Tela de Início).
import { h, showBanner, toast } from './util.js';
import { request } from './net.js';
import { openModal } from './dialogs.js';

let registration = null;

export function setupPush() {
  if (!('serviceWorker' in navigator)) return;
  navigator.serviceWorker.register('/sw.js').then((reg) => { registration = reg; }).catch(() => {});
  // Tocou na notificação com o site já aberto: o service worker pede para ir ao canal
  navigator.serviceWorker.addEventListener('message', (e) => {
    if (e.data?.type === 'open' && e.data.url) location.href = e.data.url;
  });
}

const isIOS = () => /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const installed = () => matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
export const pushSupported = () => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
export const pushEnabled = () => pushSupported() && Notification.permission === 'granted';

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
    const { key } = await (await fetch('/api/push-key')).json();
    const sub = await reg.pushManager.getSubscription()
      ?? await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: base64ToBytes(key) });
    await request({ t: 'push:subscribe', sub: sub.toJSON() });
    toast('Notificações ativadas! Você vai ser avisado quando te mencionarem.');
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
  toast('Notificações desativadas neste aparelho.');
}
