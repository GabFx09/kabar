/* Kabar — service worker: cache app shell + notifikasi push */
const VERSION = 'kabar-v3';
const ASSETS = ['./', 'index.html', 'app.css', 'app.js', 'manifest.webmanifest', 'icons/icon.svg', 'icons/icon-192.png', 'icons/badge-96.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== VERSION).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return; // API GitHub selalu langsung ke jaringan
  e.respondWith(caches.match(e.request).then((cached) => {
    const net = fetch(e.request).then((res) => {
      if (res.ok) { const copy = res.clone(); caches.open(VERSION).then((c) => c.put(e.request, copy)); }
      return res;
    }).catch(() => cached);
    return cached || net;
  }));
});

self.addEventListener('push', (e) => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch (err) { d = { title: 'Kabar', body: e.data ? e.data.text() : '' }; }
  e.waitUntil((async () => {
    await self.registration.showNotification(d.title || 'Kabar', {
      body: d.body || '', icon: 'icons/icon-192.png', badge: 'icons/badge-96.png', tag: d.tag || 'kabar',
      renotify: true, requireInteraction: d.prio === 'tinggi', data: { url: d.url || './' },
    });
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    wins.forEach((w) => w.postMessage({ type: 'push' }));
    try { if (self.navigator.setAppBadge) await self.navigator.setAppBadge(); } catch (err) { /* */ }
  })());
});
self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const url = new URL((e.notification.data && e.notification.data.url) || './', self.registration.scope).href;
  e.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const w of wins) if (w.url.startsWith(self.registration.scope)) { await w.focus(); return w.navigate(url); }
    return self.clients.openWindow(url);
  })());
});
