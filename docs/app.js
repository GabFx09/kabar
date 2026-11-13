/* =====================================================================
   Kabar — kotak pesan & notifikasi pribadi (PWA, tanpa server sendiri)
   Penyimpanan: gist rahasia milik pengguna (kabar-config.json + kabar-pesan.json)
   Pengirim: kabar.py / GitHub Action (lihat README) — termasuk notifikasi Web Push
   ===================================================================== */
'use strict';

const VAPID_PUBLIC = 'BKi5lzLyw_MxKz2woZO7h9HpjKrtMq6FAZZRV6IrheJ3EknhNaNIK0qbMAcqslQJiC2w3d6QfR3gBSaKOXe-9us';
const CONFIG_FILE = 'kabar-config.json';
const MSG_FILE = 'kabar-pesan.json';
const NOTES = 'Catatan Saya';
const REPO_URL = 'https://github.com/GabFx09/kabar';

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const store = {
  get(k, d) { try { const v = localStorage.getItem('kabar.' + k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
  set(k, v) { try { localStorage.setItem('kabar.' + k, JSON.stringify(v)); } catch (e) { /* */ } },
  del(k) { try { localStorage.removeItem('kabar.' + k); } catch (e) { /* */ } },
};

const S = {
  token: store.get('token', ''),
  gid: store.get('gid', ''),
  login: store.get('login', ''),
  cfg: store.get('cfg', { devices: [], channels: {} }),
  msgs: store.get('msgs', []),
  read: store.get('read', {}),          // { saluran: timestamp terakhir dibaca }
  myEndpoint: store.get('myEndpoint', ''),
  synced: 0, syncing: false, q: '',
};

/* ------------------------------------------------------------ util */
function toast(t) { const el = $('#toast'); el.textContent = t; el.classList.add('show'); clearTimeout(toast._t); toast._t = setTimeout(() => el.classList.remove('show'), 2200); }
function color(name) {
  const pal = ['#e17076', '#7bc862', '#65aadd', '#a695e7', '#ee7aae', '#6ec9cb', '#faa774', '#5a8fbb'];
  let h = 0; for (const c of name) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return (S.cfg.channels[name] && S.cfg.channels[name].color) || pal[h % pal.length];
}
function initials(n) { const w = n.trim().split(/\s+/); return ((w[0] || '?')[0] + (w[1] ? w[1][0] : '')).toUpperCase(); }
function avatar(n, sm) { return `<div class="av ${sm ? 'sm' : ''}" style="background:${color(n)}">${n === NOTES ? '🔖' : esc(initials(n))}</div>`; }
function hhmm(t) { return new Date(t).toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' }).replace('.', ':'); }
function shortTime(t) {
  const d = new Date(t), now = new Date();
  if (d.toDateString() === now.toDateString()) return hhmm(t);
  const diff = (now - d) / 864e5;
  if (diff < 6) return d.toLocaleDateString('id-ID', { weekday: 'short' });
  return d.toLocaleDateString('id-ID', { day: 'numeric', month: 'short' });
}
function dayLabel(t) {
  const d = new Date(t), now = new Date();
  const diff = Math.round((new Date(now.toDateString()) - new Date(d.toDateString())) / 864e5);
  return diff === 0 ? 'Hari ini' : diff === 1 ? 'Kemarin' : d.toLocaleDateString('id-ID', { weekday: 'long', day: 'numeric', month: 'long', year: d.getFullYear() !== now.getFullYear() ? 'numeric' : undefined });
}
function fmtText(t) {
  let h = esc(t);
  h = h.replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
    .replace(/(^|\s)_([^_]+)_(?=\s|$)/g, '$1<i>$2</i>')
    .replace(/(https?:\/\/[^\s<]+[^\s<.,;:!?)])/g, '<a href="$1" target="_blank" rel="noopener">$1</a>');
  return h.replace(/\n/g, '<br>');
}
function cleanHtml(htm) {
  const doc = new DOMParser().parseFromString(`<div>${String(htm || '').replace(/\n/g, '<br>')}</div>`, 'text/html');
  const ok = new Set(['B', 'I', 'A', 'BR', 'STRONG', 'EM', 'CODE', 'U']);
  const walk = (node) => [...node.childNodes].forEach((ch) => {
    if (ch.nodeType !== 1) return;
    if (!ok.has(ch.tagName)) { ch.replaceWith(...ch.childNodes); return; }
    [...ch.attributes].forEach((a) => { if (!(ch.tagName === 'A' && a.name === 'href')) ch.removeAttribute(a.name); });
    if (ch.tagName === 'A') {
      const href = ch.getAttribute('href') || '';
      if (!/^https?:/i.test(href)) ch.removeAttribute('href'); else { ch.setAttribute('target', '_blank'); ch.setAttribute('rel', 'noopener'); }
    }
    walk(ch);
  });
  walk(doc.body.firstChild);
  return doc.body.firstChild.innerHTML;
}

/* ------------------------------------------------------------ GitHub Gist */
async function gh(path, opt = {}) {
  const res = await fetch('https://api.github.com' + path, Object.assign({}, opt, {
    headers: Object.assign({ Authorization: 'Bearer ' + S.token, Accept: 'application/vnd.github+json' }, opt.body ? { 'Content-Type': 'application/json' } : {}),
    cache: 'no-store',
  }));
  if (!res.ok) throw new Error(res.status === 401 ? 'token tidak valid / kedaluwarsa' : res.status === 403 ? 'akses ditolak (scope gist?) atau batas API' : 'HTTP ' + res.status);
  return res.json();
}
async function readFiles(g) {
  const load = async (name, def) => {
    const f = g.files[name];
    if (!f) return def;
    let c = f.content;
    if (f.truncated) c = await (await fetch(f.raw_url, { cache: 'no-store' })).text();
    try { return JSON.parse(c || 'null') || def; } catch (e) { return def; }
  };
  return { cfg: await load(CONFIG_FILE, { devices: [], channels: {} }), box: await load(MSG_FILE, { messages: [] }) };
}
async function connect(token) {
  S.token = token.trim();
  const user = await gh('/user');
  let gid = null;
  for (let p = 1; p <= 5 && !gid; p++) {
    const list = await gh(`/gists?per_page=100&page=${p}`);
    const hit = list.find((g) => g.files && g.files[CONFIG_FILE]);
    if (hit) gid = hit.id;
    if (list.length < 100) break;
  }
  if (!gid) {
    const g = await gh('/gists', { method: 'POST', body: JSON.stringify({
      description: 'Kabar — kotak pesan pribadi (dibuat otomatis)', public: false,
      files: {
        [CONFIG_FILE]: { content: JSON.stringify({ v: 1, devices: [], channels: {}, created: new Date().toISOString() }, null, 1) },
        [MSG_FILE]: { content: JSON.stringify({ messages: [{ id: 'w' + Date.now(), t: new Date().toISOString(), ch: 'Kabar', from: 'bot', title: 'Selamat datang di Kabar 👋', text: 'Pesan dari skrip, server, dan aplikasi Anda akan muncul di sini — dikelompokkan per saluran seperti chat.\n\nKetuk **⋮ → Setelan** untuk mengaktifkan notifikasi dan melihat cara mengirim pesan.' }] }) },
      } }) });
    gid = g.id;
  }
  Object.assign(S, { gid, login: user.login });
  store.set('token', S.token); store.set('gid', gid); store.set('login', user.login);
  await sync(true);
}
async function sync(force) {
  if (!S.gid || S.syncing) return false;
  if (!force && Date.now() - S.synced < 8000) return false;
  S.syncing = true;
  try {
    const g = await gh('/gists/' + S.gid);
    const { cfg, box } = await readFiles(g);
    const msgs = (box.messages || []).filter((m) => m && m.id && m.t);
    const changed = msgs.length !== S.msgs.length || (msgs.at(-1) || {}).id !== (S.msgs.at(-1) || {}).id || JSON.stringify(cfg) !== JSON.stringify(S.cfg);
    S.msgs = msgs; S.cfg = Object.assign({ devices: [], channels: {} }, cfg);
    store.set('msgs', msgs.slice(-1500)); store.set('cfg', S.cfg);
    S.synced = Date.now();
    return changed;
  } finally { S.syncing = false; }
}
async function writeFiles(mutate) {
  // baca versi terbaru dulu agar tidak menimpa pesan yang baru masuk
  const g = await gh('/gists/' + S.gid);
  const cur = await readFiles(g);
  const res = mutate(cur) || {};
  const files = {};
  if (res.cfg) files[CONFIG_FILE] = { content: JSON.stringify(res.cfg, null, 1) };
  if (res.box) files[MSG_FILE] = { content: JSON.stringify(res.box) };
  if (!Object.keys(files).length) return;
  await gh('/gists/' + S.gid, { method: 'PATCH', body: JSON.stringify({ files }) });
  if (res.cfg) { S.cfg = res.cfg; store.set('cfg', S.cfg); }
  if (res.box) { S.msgs = res.box.messages; store.set('msgs', S.msgs); }
}

/* ------------------------------------------------------------ data turunan */
function channels() {
  const map = new Map();
  S.msgs.forEach((m) => { const c = m.ch || 'Umum'; const x = map.get(c) || { name: c, last: null, n: 0 }; x.last = m; x.n++; map.set(c, x); });
  Object.keys(S.cfg.channels || {}).forEach((c) => { if (!map.has(c) && !S.cfg.channels[c].hidden) map.set(c, { name: c, last: null, n: 0 }); });
  if (!map.has(NOTES)) map.set(NOTES, { name: NOTES, last: null, n: 0 });
  const arr = [...map.values()].filter((c) => !(S.cfg.channels[c.name] || {}).hidden);
  arr.forEach((c) => { c.unread = S.msgs.filter((m) => (m.ch || 'Umum') === c.name && m.from !== 'me' && Date.parse(m.t) > (S.read[c.name] || 0)).length; });
  const pin = (c) => ((S.cfg.channels[c.name] || {}).pin ? 1 : 0);
  return arr.sort((a, b) => pin(b) - pin(a) || (b.last ? Date.parse(b.last.t) : 0) - (a.last ? Date.parse(a.last.t) : 0));
}
function totalUnread() {
  return channels().reduce((a, c) => a + ((S.cfg.channels[c.name] || {}).mute ? 0 : c.unread), 0);
}
function setBadge() {
  const n = totalUnread();
  document.title = n ? `(${n}) Kabar` : 'Kabar';
  try { if (navigator.setAppBadge) n ? navigator.setAppBadge(n) : navigator.clearAppBadge(); } catch (e) { /* */ }
}
function preview(m) {
  if (!m) return '<i>Belum ada pesan</i>';
  const body = m.title ? m.title : m.html ? cleanHtml(m.html).replace(/<[^>]+>/g, ' ') : (m.text || '');
  return (m.from === 'me' ? '<span style="color:var(--accent)">Anda: </span>' : '') + esc(body.replace(/\s+/g, ' ').slice(0, 90));
}

/* ------------------------------------------------------------ router & render */
function route() {
  const h = decodeURIComponent(location.hash.replace(/^#\/?/, ''));
  if (h.startsWith('c/')) return { view: 'chat', ch: h.slice(2) };
  if (h === 'setelan') return { view: 'set' };
  return { view: 'list' };
}
const ICON = {
  menu: '<svg viewBox="0 0 24 24"><circle cx="12" cy="5" r="1.4"/><circle cx="12" cy="12" r="1.4"/><circle cx="12" cy="19" r="1.4"/></svg>',
  back: '<svg viewBox="0 0 24 24"><path d="M15 18l-6-6 6-6"/></svg>',
  search: '<svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/></svg>',
  pen: '<svg viewBox="0 0 24 24"><path d="M4 20h4L19 9l-4-4L4 16z"/></svg>',
  mute: '<svg class="ico-mute" viewBox="0 0 24 24"><path d="M11 5L6 9H3v6h3l5 4zM22 9l-6 6M16 9l6 6"/></svg>',
  pin: '📌',
  gear: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 00.3 1.8l.1.1a2 2 0 11-2.8 2.8l-.1-.1a1.7 1.7 0 00-1.8-.3 1.7 1.7 0 00-1 1.5V21a2 2 0 11-4 0v-.1a1.7 1.7 0 00-1.1-1.5 1.7 1.7 0 00-1.8.3l-.1.1a2 2 0 11-2.8-2.8l.1-.1a1.7 1.7 0 00.3-1.8 1.7 1.7 0 00-1.5-1H3a2 2 0 110-4h.1a1.7 1.7 0 001.5-1.1 1.7 1.7 0 00-.3-1.8l-.1-.1a2 2 0 112.8-2.8l.1.1a1.7 1.7 0 001.8.3H9a1.7 1.7 0 001-1.5V3a2 2 0 114 0v.1a1.7 1.7 0 001 1.5 1.7 1.7 0 001.8-.3l.1-.1a2 2 0 112.8 2.8l-.1.1a1.7 1.7 0 00-.3 1.8V9a1.7 1.7 0 001.5 1H21a2 2 0 110 4h-.1a1.7 1.7 0 00-1.5 1z"/></svg>',
};

function render() {
  const app = $('#app');
  if (!S.token || !S.gid) return renderWelcome(app);
  const r = route();
  app.dataset.view = r.view;
  app.innerHTML = `<section class="pane-list">${listHtml(r)}</section>
    <section class="pane-chat ${r.view === 'list' ? 'empty-pane' : ''}">${r.view === 'chat' ? chatHtml(r.ch) : r.view === 'set' ? settingsHtml() : '<div class="empty"><b>Pilih chat</b>Pesan dari skrip &amp; aplikasi Anda tampil per saluran.</div>'}</section>`;
  bindList();
  if (r.view === 'chat') bindChat(r.ch);
  if (r.view === 'set') bindSettings();
  setBadge();
}

function listHtml(r) {
  const q = S.q.trim().toLowerCase();
  let list = channels();
  if (q) list = list.filter((c) => c.name.toLowerCase().includes(q) || S.msgs.some((m) => (m.ch || 'Umum') === c.name && ((m.title || '') + ' ' + (m.text || '') + ' ' + (m.html || '')).toLowerCase().includes(q)));
  return `<div class="bar"><h1>Kabar</h1>
      <button class="ib" id="btnSet" title="Setelan">${ICON.gear}</button></div>
    <label class="search">${ICON.search}<input id="q" placeholder="Cari chat atau pesan" value="${esc(S.q)}"></label>
    <div class="chats">${list.map((c) => {
      const meta = S.cfg.channels[c.name] || {};
      return `<div class="crow ${r.view === 'chat' && r.ch === c.name ? 'on' : ''}" data-ch="${esc(c.name)}">${avatar(c.name)}
        <div style="min-width:0"><div class="nm">${esc(c.name)} ${meta.mute ? ICON.mute : ''}</div><div class="prev">${preview(c.last)}</div></div>
        <div class="side"><div class="tm">${c.last ? shortTime(c.last.t) : ''}</div>${c.unread ? `<div class="cnt ${meta.mute ? 'muted' : ''}">${c.unread > 99 ? '99+' : c.unread}</div>` : meta.pin ? `<div class="tm">${ICON.pin}</div>` : ''}</div></div>`;
    }).join('') || '<div class="empty">Tidak ditemukan.</div>'}</div>
    <button class="fab" id="btnNew" title="Chat baru">${ICON.pen}</button>`;
}
function bindList() {
  $$('.crow').forEach((el) => { el.onclick = () => { location.hash = '#/c/' + encodeURIComponent(el.dataset.ch); }; });
  $('#btnSet').onclick = () => { location.hash = '#/setelan'; };
  $('#btnNew').onclick = () => {
    const n = (prompt('Nama chat / saluran baru (mis. "Belanja", "Server", "Ide")') || '').trim().slice(0, 60);
    if (n) location.hash = '#/c/' + encodeURIComponent(n);
  };
  const q = $('#q');
  q.oninput = () => { S.q = q.value; const pos = q.selectionStart; render(); const nq = $('#q'); nq.focus(); nq.setSelectionRange(pos, pos); };
}

function chatHtml(ch) {
  const meta = S.cfg.channels[ch] || {};
  const list = S.msgs.filter((m) => (m.ch || 'Umum') === ch);
  const lastRead = S.read[ch] || 0;
  let out = '', day = '', sep = false;
  list.forEach((m) => {
    const dl = dayLabel(m.t);
    if (dl !== day) { out += `<div class="day"><span>${esc(dl)}</span></div>`; day = dl; }
    if (!sep && lastRead && m.from !== 'me' && Date.parse(m.t) > lastRead) { out += '<div class="newsep">Pesan belum dibaca</div>'; sep = true; }
    const body = m.html ? cleanHtml(m.html) : fmtText(m.text || '');
    out += `<div class="bub ${m.from === 'me' ? 'me' : 'bot'} ${m.prio === 'tinggi' ? 'hi' : ''}" data-id="${esc(m.id)}"><div>
      ${m.title ? `<div class="t">${m.prio === 'tinggi' ? '❗ ' : ''}${esc(m.title)}</div>` : ''}
      <span class="x">${body}</span><span class="m">${hhmm(m.t)}${m.from === 'me' ? ' ✓✓' : ''}</span>
      ${m.url && /^https?:/i.test(m.url) ? `<a class="lnk" href="${esc(m.url)}" target="_blank" rel="noopener">Buka tautan ↗</a>` : ''}</div></div>`;
  });
  const n = list.length;
  return `<div class="bar"><button class="ib" id="btnBack" title="Kembali">${ICON.back}</button>${avatar(ch, true)}
      <div class="ttl" id="chTitle"><b>${esc(ch)}</b><small>${n} pesan${meta.mute ? ' · dibisukan' : ''}</small></div>
      <button class="ib" id="btnMenu" title="Menu">${ICON.menu}</button></div>
    <div class="msgs" id="msgs">${out || `<div class="empty"><b>${esc(ch)}</b>${ch === NOTES ? 'Tulis catatan untuk diri sendiri — tersinkron ke semua perangkat.' : 'Belum ada pesan. Kirim dari skrip dengan <code>--saluran "' + esc(ch) + '"</code>, atau tulis di bawah.'}</div>`}</div>
    <form class="composer" id="composer"><textarea id="txt" rows="1" placeholder="Tulis pesan…" enterkeyhint="send"></textarea>
      <button class="send" title="Kirim"><svg viewBox="0 0 24 24"><path d="M3 20l18-8L3 4v6l12 2-12 2z"/></svg></button></form>`;
}
function bindChat(ch) {
  const box = $('#msgs');
  box.scrollTop = box.scrollHeight;
  S.read[ch] = Date.now(); store.set('read', S.read); setBadge();
  $('#btnBack').onclick = () => { location.hash = '#/'; };
  const txt = $('#txt');
  txt.oninput = () => { txt.style.height = 'auto'; txt.style.height = Math.min(140, txt.scrollHeight) + 'px'; };
  txt.onkeydown = (e) => { if (e.key === 'Enter' && !e.shiftKey && matchMedia('(min-width: 860px)').matches) { e.preventDefault(); $('#composer').requestSubmit(); } };
  $('#composer').onsubmit = async (e) => {
    e.preventDefault();
    const v = txt.value.trim();
    if (!v) return;
    const m = { id: 'u' + Date.now(), t: new Date().toISOString(), ch, from: 'me', text: v.slice(0, 6000) };
    S.msgs.push(m); txt.value = ''; render();
    try { await writeFiles(({ box }) => ({ box: { messages: [...(box.messages || []).filter((x) => x.id !== m.id), m].slice(-1500), updated: m.t } })); }
    catch (err) { toast('Gagal menyimpan: ' + err.message); }
  };
  $('#btnMenu').onclick = () => chatMenu(ch);
  $('#chTitle').onclick = () => chatMenu(ch);
}
function chatMenu(ch) {
  const meta = S.cfg.channels[ch] || {};
  openSheet(`<h3>${esc(ch)}</h3>
    <button class="menu-item" data-a="mute">${meta.mute ? '🔔 Bunyikan notifikasi' : '🔕 Bisukan notifikasi'}</button>
    <button class="menu-item" data-a="pin">${meta.pin ? '📌 Lepas sematan' : '📌 Sematkan di atas'}</button>
    <button class="menu-item" data-a="read">✓ Tandai semua dibaca</button>
    <button class="menu-item" data-a="clear" style="color:var(--bad)">🗑 Hapus semua pesan di chat ini</button>
    <p style="font-size:12.5px;color:var(--text-3)">Chat yang dibisukan tetap menerima pesan, tanpa notifikasi — kecuali pesan berprioritas tinggi.</p>`);
  $$('.sheet [data-a]').forEach((b) => { b.onclick = async () => {
    const a = b.dataset.a;
    closeSheet();
    try {
      if (a === 'read') { S.read[ch] = Date.now(); store.set('read', S.read); render(); return; }
      if (a === 'clear') {
        if (!confirm(`Hapus semua pesan di "${ch}"? Tidak bisa dibatalkan.`)) return;
        await writeFiles(({ box }) => ({ box: { messages: (box.messages || []).filter((m) => (m.ch || 'Umum') !== ch), updated: new Date().toISOString() } }));
        toast('Chat dikosongkan'); render(); return;
      }
      await writeFiles(({ cfg }) => {
        cfg.channels = cfg.channels || {};
        const c = cfg.channels[ch] = cfg.channels[ch] || {};
        if (a === 'mute') c.mute = !c.mute;
        if (a === 'pin') c.pin = !c.pin;
        return { cfg };
      });
      toast(a === 'mute' ? (S.cfg.channels[ch].mute ? 'Dibisukan' : 'Notifikasi aktif') : 'Disimpan');
      render();
    } catch (e) { toast('Gagal: ' + e.message); }
  }; });
}

/* ------------------------------------------------------------ notifikasi push */
function pushSupported() { return 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window; }
function b64ToBytes(b64) {
  const pad = '='.repeat((4 - (b64.length % 4)) % 4);
  const raw = atob((b64 + pad).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from([...raw].map((c) => c.charCodeAt(0)));
}
function deviceName() {
  const ua = navigator.userAgent;
  const os = /android/i.test(ua) ? 'Android' : /iphone|ipad/i.test(ua) ? 'iPhone/iPad' : /windows/i.test(ua) ? 'Windows' : /mac/i.test(ua) ? 'Mac' : /linux/i.test(ua) ? 'Linux' : 'Perangkat';
  const br = /edg\//i.test(ua) ? 'Edge' : /firefox/i.test(ua) ? 'Firefox' : /chrome/i.test(ua) ? 'Chrome' : /safari/i.test(ua) ? 'Safari' : 'Browser';
  return `${os} · ${br}`;
}
async function enablePush() {
  if (!pushSupported()) {
    const ios = /iphone|ipad|ipod/i.test(navigator.userAgent);
    alert(ios ? 'Di iPhone/iPad, notifikasi hanya tersedia bila Kabar dipasang ke Layar Utama (iOS 16.4+): Safari → Bagikan → Tambahkan ke Layar Utama, lalu buka dari ikonnya.' : 'Browser ini belum mendukung notifikasi push.');
    return;
  }
  const perm = await Notification.requestPermission();
  if (perm !== 'granted') { toast('Izin notifikasi ditolak'); return; }
  const reg = await navigator.serviceWorker.ready;
  let sub = await reg.pushManager.getSubscription();
  if (sub && sub.options && sub.options.applicationServerKey) {
    const cur = btoa(String.fromCharCode(...new Uint8Array(sub.options.applicationServerKey))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    if (cur !== VAPID_PUBLIC) { await sub.unsubscribe(); sub = null; }
  }
  if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToBytes(VAPID_PUBLIC) });
  const j = sub.toJSON();
  await writeFiles(({ cfg }) => {
    cfg.devices = (cfg.devices || []).filter((d) => d.endpoint !== j.endpoint);
    cfg.devices.push({ endpoint: j.endpoint, keys: j.keys, name: deviceName(), added: new Date().toISOString().slice(0, 10) });
    return { cfg };
  });
  S.myEndpoint = j.endpoint; store.set('myEndpoint', j.endpoint);
  await reg.showNotification('Kabar · notifikasi aktif ✓', { body: 'Pesan baru akan muncul di sini, juga saat Kabar ditutup.', icon: 'icons/icon-192.png', badge: 'icons/badge-96.png', tag: 'kabar-test' });
  toast('Notifikasi aktif di perangkat ini');
  render();
}
async function removeDevice(endpoint) {
  await writeFiles(({ cfg }) => { cfg.devices = (cfg.devices || []).filter((d) => d.endpoint !== endpoint); return { cfg }; });
  if (endpoint === S.myEndpoint) {
    try { const reg = await navigator.serviceWorker.ready; const sub = await reg.pushManager.getSubscription(); if (sub) await sub.unsubscribe(); } catch (e) { /* */ }
    S.myEndpoint = ''; store.set('myEndpoint', '');
  }
  render();
}

/* ------------------------------------------------------------ setelan */
function settingsHtml() {
  const devs = S.cfg.devices || [];
  const mine = devs.some((d) => d.endpoint === S.myEndpoint);
  const appUrl = location.origin + location.pathname;
  return `<div class="bar"><button class="ib" id="btnBack" title="Kembali">${ICON.back}</button><div class="ttl"><b>Setelan</b><small>@${esc(S.login)}</small></div></div>
  <div class="page">
    <div class="card"><h3>Notifikasi</h3>
      <p>${mine ? '<span class="status-dot"></span>Aktif di perangkat ini.' : 'Belum aktif di perangkat ini. Aktifkan agar pesan baru muncul di layar kunci — juga saat Kabar ditutup.'}</p>
      ${devs.length ? devs.map((d) => `<div class="dev"><span>📱 ${esc(d.name || 'Perangkat')}${d.endpoint === S.myEndpoint ? ' <b>(ini)</b>' : ''}<br><small style="color:var(--text-3)">sejak ${esc(d.added || '')}</small></span><button class="btn bad" data-rm="${esc(d.endpoint)}">Hapus</button></div>`).join('') : ''}
      <div class="row-btns"><button class="btn pri" id="btnPush">${mine ? 'Perbarui notifikasi' : '🔔 Aktifkan notifikasi'}</button></div></div>
    <div class="card"><h3>Kirim pesan dari skrip / server / aplikasi lain</h3>
      <p>Siapkan dua nilai rahasia di tempat pengirim berjalan (komputer, server, atau <i>secrets</i> GitHub Actions):</p>
      <pre>KABAR_TOKEN = token GitHub (scope gist) — sama dengan yang Anda pakai di sini
KABAR_VAPID = kunci privat notifikasi (lihat README repo)</pre>
      <p><b>Python / terminal</b> — unduh <a href="${REPO_URL}/blob/main/kabar.py" target="_blank" rel="noopener">kabar.py</a>, lalu:</p>
      <pre>pip install requests pywebpush
python kabar.py "Backup selesai" "1,2 GB dalam 3 menit" --saluran Server
python kabar.py "Disk penuh!" "sisa 2%" -s Server --prioritas tinggi</pre>
      <pre>import kabar
kabar.kirim("Harga emas", "Naik 2% hari ini", saluran="Investasi", url="https://…")</pre>
      <p><b>GitHub Actions</b> (repo mana pun):</p>
      <pre>- uses: GabFx09/kabar@main
  with:
    saluran: Deploy
    judul: Situs berhasil diperbarui
    isi: Commit \${{ github.sha }}
    token: \${{ secrets.KABAR_TOKEN }}
    vapid: \${{ secrets.KABAR_VAPID }}</pre>
      <p>Format isi: <code>**tebal**</code>, <code>_miring_</code>, <code>\`kode\`</code>, tautan otomatis. Saluran baru otomatis muncul sebagai chat.</p></div>
    <div class="card"><h3>Akun & data</h3>
      <p>Pesan tersimpan di <a href="https://gist.github.com/${esc(S.login)}/${esc(S.gid)}" target="_blank" rel="noopener">gist rahasia Anda ↗</a> (maks. 1.500 pesan terbaru). Alamat aplikasi: <code>${esc(appUrl)}</code></p>
      <div class="row-btns"><button class="btn" id="btnTheme">🌓 Ganti tema</button><button class="btn" id="btnSync">⟳ Sinkronkan</button><button class="btn bad" id="btnOut">Keluar dari perangkat ini</button></div></div>
  </div>`;
}
function bindSettings() {
  $('#btnBack').onclick = () => { location.hash = '#/'; };
  $('#btnPush').onclick = () => enablePush().catch((e) => toast('Gagal: ' + e.message));
  $$('[data-rm]').forEach((b) => { b.onclick = () => removeDevice(b.dataset.rm).catch((e) => toast('Gagal: ' + e.message)); });
  $('#btnTheme').onclick = () => {
    const cur = document.documentElement.getAttribute('data-theme') || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
    const next = cur === 'dark' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', next);
    try { localStorage.setItem('kabar.theme', next); } catch (e) { /* */ }
  };
  $('#btnSync').onclick = () => sync(true).then(() => { toast('Tersinkron'); render(); }).catch((e) => toast('Gagal: ' + e.message));
  $('#btnOut').onclick = () => {
    if (!confirm('Keluar dari Kabar di perangkat ini? Pesan tetap tersimpan di gist Anda.')) return;
    ['token', 'gid', 'login', 'cfg', 'msgs', 'read', 'myEndpoint'].forEach((k) => store.del(k));
    location.hash = '#/'; location.reload();
  };
}

/* ------------------------------------------------------------ layar awal */
function renderWelcome(app) {
  app.dataset.view = 'welcome';
  app.innerHTML = `<div class="welcome" style="grid-column:1/-1"><div class="card" style="text-align:center">
    <img class="logo" src="icons/icon.svg" alt="">
    <h2 style="margin:0 0 6px">Kabar</h2>
    <p>Kotak pesan &amp; notifikasi pribadi. Terima pesan dari skrip, server, bot, dan aplikasi Anda — dikelompokkan per chat, lengkap dengan notifikasi di HP.</p>
    <div style="text-align:left">
      <ol style="padding-left:20px">
        <li>Buat token GitHub: <a href="https://github.com/settings/tokens/new?scopes=gist&description=Kabar" target="_blank" rel="noopener">token baru dengan scope <b>gist</b> ↗</a>, lalu salin.</li>
        <li>Tempel di bawah. Kabar membuat <b>gist rahasia</b> di akun Anda sebagai kotak pesan.</li>
      </ol>
      <label class="field">Token GitHub (scope gist)<input id="tok" type="password" autocomplete="off" placeholder="ghp_…"></label>
      <div class="row-btns"><button class="btn pri" id="go" style="flex:1">Masuk</button></div>
      <p style="font-size:12.5px;color:var(--text-3)">Token hanya disimpan di perangkat ini dan hanya bisa mengakses gist — bukan repo atau akun Anda. Gist rahasia tidak tampil publik, tetapi siapa pun yang tahu alamatnya bisa membacanya; jangan kirim kata sandi lewat Kabar.</p>
    </div></div></div>`;
  $('#go').onclick = async () => {
    const t = $('#tok').value.trim();
    if (!t) { toast('Tempel token dulu'); return; }
    $('#go').disabled = true; $('#go').textContent = 'Menghubungkan…';
    try { await connect(t); location.hash = '#/'; render(); } catch (e) { S.token = ''; toast('Gagal: ' + e.message); $('#go').disabled = false; $('#go').textContent = 'Masuk'; }
  };
}

/* ------------------------------------------------------------ sheet */
function openSheet(html) { const w = $('#sheet'); $('.sheet', w).innerHTML = html; w.classList.remove('hidden'); }
function closeSheet() { $('#sheet').classList.add('hidden'); }
$('#sheet').addEventListener('click', (e) => { if (e.target.closest('[data-close]')) closeSheet(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') { closeSheet(); if (route().view !== 'list') location.hash = '#/'; } });

/* ------------------------------------------------------------ boot */
window.addEventListener('hashchange', render);
async function refresh() {
  if (!S.gid) return;
  try {
    const ch = await sync();
    if (ch) {
      const r = route();
      const typing = document.activeElement && document.activeElement.id === 'txt' && document.activeElement.value;
      if (!typing) render(); else setBadge();
      if (r.view === 'chat') { const b = $('#msgs'); if (b) b.scrollTop = b.scrollHeight; }
    }
  } catch (e) { if (/token/.test(e.message)) toast(e.message); }
}
render();
refresh();
setInterval(() => { if (document.visibilityState === 'visible') refresh(); }, 20000);
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') refresh(); });
if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  navigator.serviceWorker.register('sw.js').catch(() => {});
  navigator.serviceWorker.addEventListener('message', (e) => { if (e.data && e.data.type === 'push') { S.synced = 0; refresh(); } });
}
