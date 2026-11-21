/* Kabar — service worker: cache app shell, notifikasi push, perbaikan langganan otomatis & cek latar belakang */
const VERSION = 'kabar-v7';
const ASSETS = ['./', 'index.html', 'app.css', 'app.js', 'manifest.webmanifest', 'icons/icon.svg', 'icons/icon-192.png', 'icons/badge-96.png'];
const DATA = 'kabar-data';   // token+gist (dari aplikasi) & status notifikasi — tidak ikut dihapus saat ganti versi
const API = 'https://api.github.com';
const CONFIG_FILE = 'kabar-config.json';
const MSG_FILE = 'kabar-pesan.json';
const VAPID_PUBLIC = 'BKi5lzLyw_MxKz2woZO7h9HpjKrtMq6FAZZRV6IrheJ3EknhNaNIK0qbMAcqslQJiC2w3d6QfR3gBSaKOXe-9us';

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(ASSETS.map((u) => new Request(u, { cache: 'reload' })))).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== VERSION && k !== DATA).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin || url.pathname.includes('/__')) return; // API GitHub selalu langsung ke jaringan
  e.respondWith(caches.match(e.request).then((cached) => {
    const net = fetch(e.request).then((res) => {
      if (res.ok) { const copy = res.clone(); caches.open(VERSION).then((c) => c.put(e.request, copy)); }
      return res;
    }).catch(() => cached);
    return cached || net;
  }));
});

/* ---------- penyimpanan kecil (Cache API, bisa dibaca aplikasi & service worker) */
async function getJ(k) { try { const r = await (await caches.open(DATA)).match(k); return r ? await r.json() : null; } catch (e) { return null; } }
async function putJ(k, v) { try { await (await caches.open(DATA)).put(k, new Response(JSON.stringify(v), { headers: { 'Content-Type': 'application/json' } })); } catch (e) { /* */ } }
async function markSeen(t) {
  const st = (await getJ('__state')) || {};
  const ms = Date.parse(t || '') || Date.now();
  if (!st.lastT || ms > Date.parse(st.lastT)) { st.lastT = new Date(ms).toISOString(); await putJ('__state', st); }
}

/* ---------- akses gist dari service worker (token yang sama dengan aplikasi) */
async function gh(auth, path, opt = {}) {
  const res = await fetch(API + path, { ...opt, cache: 'no-store', headers: { Authorization: 'Bearer ' + auth.token, Accept: 'application/vnd.github+json', ...(opt.body ? { 'Content-Type': 'application/json' } : {}) } });
  if (!res.ok) throw new Error('GitHub ' + res.status);
  return res.json();
}
async function readGist(auth) {
  const g = await gh(auth, '/gists/' + auth.gid);
  const load = async (name, def) => {
    const f = g.files[name];
    if (!f) return def;
    let c = f.content;
    if (f.truncated) c = await (await fetch(f.raw_url, { cache: 'no-store' })).text();
    try { return JSON.parse(c || 'null') || def; } catch (e) { return def; }
  };
  return { cfg: await load(CONFIG_FILE, { devices: [], channels: {} }), box: await load(MSG_FILE, { messages: [] }) };
}
function b64ToBytes(b64) {
  const pad = '='.repeat((4 - (b64.length % 4)) % 4);
  const raw = atob((b64 + pad).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from([...raw].map((c) => c.charCodeAt(0)));
}
/** pastikan langganan push perangkat ini ada & tercatat di gist; perbarui bila ditolak layanan push */
async function ensureDevice(auth, cfg, oldEndpoint, newSub) {
  const pm = self.registration.pushManager;
  if (!pm || (self.Notification && Notification.permission !== 'granted')) return;
  const st = (await getJ('__state')) || {};
  if (!st.myEndpoint && !oldEndpoint) return; // perangkat ini belum pernah mengaktifkan notifikasi
  let sub = newSub || await pm.getSubscription();
  let why = newSub ? 'diganti' : sub ? '' : 'hilang';
  const devs = cfg.devices || [];
  const mine = sub && devs.find((d) => d.endpoint === sub.endpoint);
  if (sub && mine && !mine.fail) return;
  if (sub && (cfg.blocked || []).includes(sub.endpoint)) return; // dihapus manual oleh pengguna
  // lepas langganan HANYA bila endpoint ini sudah ditolak layanan push (404/410); yang belum tercatat cukup dicatat ulang
  if (sub && !newSub && mine && mine.fail) { try { await sub.unsubscribe(); } catch (e) { /* */ } sub = null; why = 'ditolak'; }
  if (!sub) sub = await pm.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToBytes(VAPID_PUBLIC) });
  const j = sub.toJSON();
  if (!j.endpoint || !j.keys) return;
  const fresh = (await readGist(auth)).cfg;
  const all = fresh.devices || [];
  const here = all.find((d) => d.endpoint === j.endpoint);
  const stale = [oldEndpoint, st.myEndpoint].filter((x) => x && x !== '-' && x !== j.endpoint);
  if (here && !here.fail && !all.some((d) => stale.includes(d.endpoint))) { st.myEndpoint = j.endpoint; await putJ('__state', st); return; } // sudah tercatat
  const prev = here || all.find((d) => d.endpoint === (oldEndpoint || st.myEndpoint)) || {};
  fresh.devices = all.filter((d) => d.endpoint !== j.endpoint && d.endpoint !== oldEndpoint && d.endpoint !== st.myEndpoint);
  fresh.devices.push({ endpoint: j.endpoint, keys: j.keys, name: prev.name || st.name || 'Perangkat', added: prev.added || new Date().toISOString().slice(0, 10), renewed: new Date().toISOString().slice(0, 10) });
  if (why) fresh.relog = [...(fresh.relog || []), { t: new Date().toISOString(), dev: prev.name || st.name || 'Perangkat', why, by: 'sw' }].slice(-30);
  await gh(auth, '/gists/' + auth.gid, { method: 'PATCH', body: JSON.stringify({ files: { [CONFIG_FILE]: { content: JSON.stringify(fresh, null, 1) } } }) });
  st.myEndpoint = j.endpoint; await putJ('__state', st);
  const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  wins.forEach((w) => w.postMessage({ type: 'device', endpoint: j.endpoint }));
}
function quietNow(q) {
  if (!q || !q.on) return false;
  let h;
  try { h = Number(new Intl.DateTimeFormat('en-GB', { hour: '2-digit', hour12: false, timeZone: q.tz || undefined }).format(new Date())) % 24; } catch (e) { h = new Date().getHours(); }
  const f = Number(q.from ?? 22), t = Number(q.to ?? 6);
  return f <= t ? h >= f && h < t : h >= f || h < t;
}
/** cadangan bila push tidak sampai: cek pesan baru di gist & tampilkan notifikasi untuk yang belum diberitahukan */
async function checkNew() {
  const auth = await getJ('__auth');
  if (!auth || !auth.token || !auth.gid) return;
  const { cfg, box } = await readGist(auth);
  const st = (await getJ('__state')) || {};
  const msgs = (box.messages || []).filter((m) => m && m.t && m.from !== 'me');
  const latest = msgs.reduce((a, m) => Math.max(a, Date.parse(m.t) || 0), 0);
  if (st.lastT && self.Notification && Notification.permission === 'granted') {
    const since = Math.max(Date.parse(st.lastT) || 0, Date.now() - 3 * 864e5);
    const fresh = msgs.filter((m) => (Date.parse(m.t) || 0) > since);
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const visible = wins.some((w) => w.visibilityState === 'visible');
    if (fresh.length && !visible) {
      const by = {};
      fresh.forEach((m) => { (by[m.ch || 'Umum'] = by[m.ch || 'Umum'] || []).push(m); });
      for (const [ch, list] of Object.entries(by)) {
        const urgent = list.some((m) => m.prio === 'tinggi');
        const meta = (cfg.channels || {})[ch] || {};
        if (meta.mute && !urgent) continue;
        const one = list.length === 1 ? list[0] : null;
        const title = one ? `${ch} · ${one.enc ? '🔒 Pesan baru' : (one.title || 'Pesan baru')}` : `${ch} · ${list.length} pesan baru`;
        const body = one ? (one.enc ? 'Pesan terenkripsi — ketuk untuk membuka' : String(one.text || (one.html || '').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim().slice(0, 220))
          : list.map((m) => (m.enc ? '🔒' : m.title || String(m.text || '').slice(0, 40))).join(' · ').slice(0, 220);
        await self.registration.showNotification(title, {
          body, icon: 'icons/icon-192.png', badge: 'icons/badge-96.png', tag: 'kabar-' + ch, renotify: true,
          silent: quietNow(cfg.quiet) && !urgent, data: { url: './#/c/' + encodeURIComponent(ch) },
        });
      }
      try { if (self.navigator.setAppBadge) await self.navigator.setAppBadge(); } catch (e) { /* */ }
    }
  }
  if (latest) await markSeen(new Date(latest).toISOString());
  await ensureDevice(auth, cfg).catch(() => {});
}

self.addEventListener('push', (e) => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch (err) { d = { title: 'Kabar', body: e.data ? e.data.text() : '' }; }
  e.waitUntil((async () => {
    await self.registration.showNotification(d.title || 'Kabar', {
      body: d.body || '', icon: 'icons/icon-192.png', badge: 'icons/badge-96.png', tag: d.tag || 'kabar',
      renotify: true, requireInteraction: d.prio === 'tinggi', data: { url: d.url || './' },
    });
    await markSeen(d.t);
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    wins.forEach((w) => w.postMessage({ type: 'push' }));
    try { if (self.navigator.setAppBadge) await self.navigator.setAppBadge(); } catch (err) { /* */ }
  })());
});
// browser mengganti/mencabut langganan push → daftarkan ulang otomatis tanpa perlu membuka aplikasi
self.addEventListener('pushsubscriptionchange', (e) => {
  e.waitUntil((async () => {
    const auth = await getJ('__auth');
    if (!auth || !auth.token) return;
    const old = e.oldSubscription && e.oldSubscription.endpoint;
    const { cfg } = await readGist(auth);
    await ensureDevice(auth, cfg, old || '-', e.newSubscription || null);
  })().catch(() => {}));
});
// cek berkala di latar belakang (Chrome/Edge untuk aplikasi yang dipasang di layar utama)
self.addEventListener('periodicsync', (e) => {
  if (e.tag === 'kabar-cek') e.waitUntil(checkNew().catch(() => {}));
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
