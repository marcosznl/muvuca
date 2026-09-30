// Service worker do painel: só recebe os alertas (não guarda cópia do painel)
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

self.addEventListener('push', (e) => {
  let data = {};
  try { data = e.data.json(); } catch { data = { title: 'Painel do Muvuca', body: e.data?.text() ?? '' }; }
  e.waitUntil(self.registration.showNotification(data.title || 'Painel do Muvuca', {
    body: data.body || '', icon: '/icon-192.png', badge: '/icon-192.png', tag: data.tag, renotify: !!data.tag, data: { url: data.url || '/' },
  }));
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const url = e.notification.data?.url || '/';
  e.waitUntil((async () => {
    const tabs = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const tab = tabs.find((c) => new URL(c.url).origin === self.location.origin);
    if (tab) { await tab.focus(); tab.navigate?.(url).catch(() => {}); return; }
    await self.clients.openWindow(url);
  })());
});
