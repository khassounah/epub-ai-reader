// App-shell cache so the reader loads with no server connection.
// Books, progress and chats live in IndexedDB; this only caches the code.
//
// Network-first: when the server is reachable you always get the latest code (a cheap 304 when
// nothing changed); the cached copy is used only when the server can't be reached within a few
// seconds, e.g. offline or on a plane.
const CACHE = 'reader-shell-v10';
const SHELL = ['/', '/index.html', '/styles.css', '/app.js', '/manifest.json', '/icon.svg', '/lib/epub.min.js', '/lib/jszip.min.js'];
const NETWORK_TIMEOUT_MS = 4000;

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin || url.pathname.startsWith('/api/')) return;
  const navigate = e.request.mode === 'navigate';
  const key = navigate ? '/index.html' : url.pathname;
  e.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), NETWORK_TIMEOUT_MS);
    try {
      // a navigate-mode Request can't be re-issued with options, so fetch by URL
      const res = await fetch(navigate ? '/' : url.pathname + url.search, { signal: ctrl.signal, cache: 'no-cache' });
      if (res.ok) await cache.put(key, res.clone());
      return res;
    } catch {
      const cached = await cache.match(key);
      return cached || Response.error();
    } finally {
      clearTimeout(timer);
    }
  })());
});
