// App-shell cache so the reader loads with no server connection.
// Books, progress and chats live in IndexedDB; this only caches the code.
//
// Network-first: when the server is reachable you always get the latest code (a cheap 304 when
// nothing changed). If the server doesn't answer within NETWORK_TIMEOUT_MS (offline, or a broken
// Tailscale link where connections hang), the saved copy is used, and for OFFLINE_HOLD_MS after that
// every request goes straight to the saved copy so startup isn't slowed by one timeout per file.
// Pages served from the saved copy are marked so the app can show "Loaded from: offline copy".
const CACHE = 'reader-shell-v12';
const SHELL = ['/', '/index.html', '/styles.css', '/app.js', '/manifest.json', '/icon.svg', '/lib/epub.min.js', '/lib/jszip.min.js'];
const NETWORK_TIMEOUT_MS = 3000;
const OFFLINE_HOLD_MS = 30000;
let offlineUntil = 0;

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});

async function fromCache(cache, key, navigate) {
  const cached = await cache.match(key);
  if (!cached) return Response.error();
  if (!navigate) return cached;
  const savedAt = cached.headers.get('x-saved-at') || '';
  const html = (await cached.text()).replace('<head>',
    `<head>\n  <meta name="reader-source" content="offline-copy">\n  <meta name="reader-saved-at" content="${savedAt}">`);
  return new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8' } });
}

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin || url.pathname.startsWith('/api/')) return;
  const navigate = e.request.mode === 'navigate';
  const key = navigate ? '/index.html' : url.pathname;
  e.respondWith((async () => {
    const cache = await caches.open(CACHE);
    // a navigation always probes the network; sub-resources follow the latest verdict
    if (!navigate && Date.now() < offlineUntil) return fromCache(cache, key, false);
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), NETWORK_TIMEOUT_MS);
    try {
      // a navigate-mode Request can't be re-issued with options, so fetch by URL
      const res = await fetch(navigate ? '/' : url.pathname + url.search, { signal: ctrl.signal, cache: 'no-cache' });
      offlineUntil = 0;
      if (res.ok) {
        if (navigate) {
          const html = await res.clone().text();
          await cache.put(key, new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8', 'x-saved-at': String(Date.now()) } }));
        } else await cache.put(key, res.clone());
      }
      return res;
    } catch {
      offlineUntil = Date.now() + OFFLINE_HOLD_MS;
      return fromCache(cache, key, navigate);
    } finally {
      clearTimeout(timer);
    }
  })());
});
