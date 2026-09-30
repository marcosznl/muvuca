// Service worker do Muvuca: recebe as notificações (mesmo com o site fechado), abre o canal ao tocar
// e guarda os arquivos do site no aparelho para abrir rápido.
//
// Cache: ao abrir o Muvuca, pergunta só a versão (/build.json). Mesma versão: tudo sai do aparelho.
// Versão nova (publicaram atualização): apaga o que tinha e busca de novo — nunca mistura versão velha com nova.
// Sem internet: abre com o que está guardado. Conversas, fotos e arquivos enviados não ficam guardados aqui.

const CACHE = 'muvuca-site';
const VERSION_KEY = '/__versao__';
// Só os arquivos do site em si (scripts, estilo, ícones, fontes, bibliotecas de voz)
const STATIC = /^\/(?:style\.css$|manifest\.webmanifest$|livekit-client\.js$|js\/|icons\/|fonts\/|vendor\/)/;

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

async function cachedVersion(cache) {
  const r = await cache.match(VERSION_KEY);
  return r ? r.text() : null;
}

// Versão atual no servidor (prazo curto: internet ruim não pode travar a abertura)
async function serverVersion() {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 2500);
    const r = await fetch('/build.json', { cache: 'no-store', signal: ctrl.signal });
    clearTimeout(t);
    return r.ok ? (await r.json()).v : null;
  } catch { return null; }
}

// Abrindo o Muvuca: confere a versão; se mudou, esvazia o cache antes de carregar
async function onNavigate(request) {
  const cache = await caches.open(CACHE);
  const [have, now] = await Promise.all([cachedVersion(cache), serverVersion()]);
  if (now && now !== have) {
    for (const k of await cache.keys()) await cache.delete(k);
    await cache.put(VERSION_KEY, new Response(now));
  }
  if (now && now === have) {
    const hit = await cache.match('/');
    if (hit) return hit;
  }
  try {
    const res = await fetch(request);
    if (res.ok && now) cache.put('/', res.clone());
    return res;
  } catch {
    return (await cache.match('/')) ?? Response.error(); // sem internet: a última versão guardada
  }
}

// Arquivos do site: do aparelho quando já tem (a versão foi conferida ao abrir); senão busca e guarda
async function onStatic(request) {
  const cache = await caches.open(CACHE);
  const hit = await cache.match(request);
  if (hit) return hit;
  const res = await fetch(request);
  if (res.ok && res.type === 'basic' && await cachedVersion(cache)) cache.put(request, res.clone());
  return res;
}

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (req.mode === 'navigate' && (url.pathname === '/' || url.pathname === '/index.html')) { e.respondWith(onNavigate(req)); return; }
  if (STATIC.test(url.pathname)) e.respondWith(onStatic(req));
});

self.addEventListener('push', (e) => {
  let data = {};
  try { data = e.data.json(); } catch { data = { title: 'Muvuca', body: e.data?.text() ?? '' }; }
  e.waitUntil(self.registration.showNotification(data.title || 'Muvuca', {
    body: data.body || '',
    icon: '/icons/icon-192.png',
    badge: '/icons/icon-192.png',
    tag: data.tag,
    renotify: !!data.tag,
    data: { url: data.url || '/' },
  }));
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const url = e.notification.data?.url || '/';
  e.waitUntil((async () => {
    const tabs = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const tab = tabs.find((c) => new URL(c.url).origin === self.location.origin);
    if (tab) {
      await tab.focus();
      tab.postMessage({ type: 'open', url });
      return;
    }
    await self.clients.openWindow(url);
  })());
});
