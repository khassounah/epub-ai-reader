/* global ePub */
// Offline-first EPUB reader. Everything lives in IndexedDB on this device and syncs to the server when reachable.

const APP_VERSION = '11';
const BUILD = document.querySelector('meta[name="reader-build"]')?.content || '';
console.info('Reader version', APP_VERSION);
const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];
function el(tag, attrs = {}, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') e.className = v;
    else if (k === 'html') e.innerHTML = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else if (k === 'checked' || k === 'value') e[k] = v;
    else e.setAttribute(k, v === true ? '' : v);
  }
  for (const k of kids.flat()) if (k != null && k !== false) e.append(k.nodeType ? k : document.createTextNode(String(k)));
  return e;
}
const uid = () => (crypto.randomUUID ? crypto.randomUUID().replace(/-/g, '') : Date.now().toString(36) + Math.random().toString(36).slice(2, 12));
const fmtDate = (ts) => new Date(ts).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
const pctStr = (p) => (p == null ? '—' : `${Math.round(p * 1000) / 10}%`);

// ---------------------------------------------------------------- IndexedDB
const idb = (() => {
  let dbp;
  const open = () => (dbp ||= new Promise((res, rej) => {
    const r = indexedDB.open('epub-reader', 2);
    r.onupgradeneeded = () => {
      const d = r.result;
      for (const [name, opts] of [['kv'], ['files'], ['outbox', { keyPath: 'key' }], ['parts']]) {
        if (!d.objectStoreNames.contains(name)) d.createObjectStore(name, opts);
      }
    };
    // A tab still running an older version keeps the database open and blocks the upgrade.
    r.onblocked = () => toast('Updating this device’s storage. Close or reload other tabs of the reader in this browser to continue.', null, null, 0);
    r.onsuccess = () => {
      const db = r.result;
      // when a newer version opens the database in another tab, step aside and reload into it
      db.onversionchange = () => { db.close(); location.reload(); };
      if (!$('#toast').hidden && /Updating this device/.test($('#toast').textContent)) $('#toast').hidden = true;
      res(db);
    };
    r.onerror = () => rej(r.error);
  }));
  async function run(store, mode, fn) {
    const d = await open();
    return new Promise((res, rej) => {
      const t = d.transaction(store, mode);
      const req = fn(t.objectStore(store));
      t.oncomplete = () => res(req?.result);
      t.onerror = () => rej(t.error);
      t.onabort = () => rej(t.error);
    });
  }
  return {
    get: (s, k) => run(s, 'readonly', (o) => o.get(k)),
    set: (s, k, v) => run(s, 'readwrite', (o) => (s === 'outbox' ? o.put(v) : o.put(v, k))),
    del: (s, k) => run(s, 'readwrite', (o) => o.delete(k)),
    all: (s) => run(s, 'readonly', (o) => o.getAll()),
    keys: (s) => run(s, 'readonly', (o) => o.getAllKeys()),
    delPrefix: (s, prefix) => run(s, 'readwrite', (o) => o.delete(IDBKeyRange.bound(prefix, prefix + '\uffff'))),
  };
})();

// ---------------------------------------------------------------- state + merge rules (mirror server.js)
const newer = (a, b) => (!a ? b : !b ? a : (b.updatedAt || 0) >= (a.updatedAt || 0) ? b : a);
function mergeProgress(a, b) {
  if (!a) return b;
  if (!b) return a;
  const cur = newer(a, b);
  const far = (b.furthestPercent || 0) > (a.furthestPercent || 0) ? b : a;
  return { ...cur, furthestCfi: far.furthestCfi, furthestPercent: far.furthestPercent, furthestChapter: far.furthestChapter };
}
function mergeConv(a, b) {
  if (!a) return b;
  if (!b) return a;
  const base = newer(a, b);
  const msgs = new Map();
  for (const m of [...(a.messages || []), ...(b.messages || [])]) {
    const prev = msgs.get(m.id);
    if (!prev || (m.content || '').length >= (prev.content || '').length) msgs.set(m.id, m);
  }
  return { ...base, messages: [...msgs.values()].sort((x, y) => x.ts - y.ts) };
}

const freshState = () => ({
  deviceId: null,
  books: {}, deleted: {}, progress: {}, lastBook: null, conversations: {},
  here: {}, // bookId -> this device's own position { cfi, percent, page, chapter, updatedAt }; never synced
  settings: { providers: [], defaultProviderId: null, updatedAt: 0 },
  prefs: { theme: 'light', fontSize: 100, updatedAt: 0 },
  dirty: { progress: [], conversations: [], lastBook: false, settings: false, prefs: false },
});
let S = freshState();

// This device's position in a book; a device that has never opened it starts where you last read anywhere.
const here = (id) => S.here[id] || S.progress[id] || null;
function deviceName() {
  const ua = navigator.userAgent;
  if (/iPad|Macintosh/.test(ua) && navigator.maxTouchPoints > 1) return 'iPad';
  if (/iPhone/.test(ua)) return 'iPhone';
  if (/Android/.test(ua)) return /Mobile/.test(ua) ? 'Android phone' : 'Android tablet';
  if (/Mac/.test(ua)) return 'Mac';
  if (/Windows/.test(ua)) return 'Windows PC';
  if (/Linux|X11|CrOS/.test(ua)) return 'Linux laptop';
  return 'another device';
}

async function loadLocal() {
  const saved = (await idb.get('kv', 'state')) || {};
  S = { ...freshState(), ...saved };
  S.dirty = { ...freshState().dirty, ...(saved.dirty || {}) };
  if (!S.deviceId) S.deviceId = uid().slice(0, 10);
  S.here ||= {};
}
let saveT;
function saveLocal() {
  clearTimeout(saveT);
  saveT = setTimeout(() => idb.set('kv', 'state', S).catch((e) => console.error('local save', e)), 250);
}
function markDirty(kind, id) {
  if (id) { if (!S.dirty[kind].includes(id)) S.dirty[kind].push(id); }
  else S.dirty[kind] = true;
  saveLocal();
  scheduleSync();
}

// ---------------------------------------------------------------- sync
let online = false, syncing = false, syncT = null, outboxKeys = new Set();
function setSyncStatus(s) {
  const n = $('#sync-status');
  n.className = s;
  n.textContent = { syncing: 'Syncing…', synced: 'Synced', offline: 'Offline', pending: 'Pending sync' }[s] || '';
}
function scheduleSync(ms = 2500) { clearTimeout(syncT); syncT = setTimeout(sync, ms); }

async function queue(op) { await idb.set('outbox', op.key, op); outboxKeys.add(op.key); }

async function flushOutbox() {
  const ops = await idb.all('outbox');
  for (const op of ops) {
    if (op.type === 'upload') {
      const blob = await idb.get('files', op.id);
      if (!blob) { await idb.del('outbox', op.key); outboxKeys.delete(op.key); continue; }
      const r = await fetch(`/api/books/${op.id}`, {
        method: 'PUT', body: blob,
        headers: { 'content-type': 'application/epub+zip', 'x-meta': encodeURIComponent(JSON.stringify(op.meta)) },
      });
      if (!r.ok) throw new Error('upload failed ' + r.status);
    } else if (op.type === 'delete') {
      const r = await fetch(`/api/books/${op.id}`, { method: 'DELETE' });
      if (!r.ok) throw new Error('delete failed ' + r.status);
    }
    await idb.del('outbox', op.key);
    outboxKeys.delete(op.key);
  }
}

async function sync() {
  if (syncing) return;
  syncing = true;
  setSyncStatus('syncing');
  try {
    await flushOutbox();
    const sent = { progress: {}, conversations: {} };
    const payload = { progress: {}, conversations: [] };
    for (const id of S.dirty.progress) if (S.progress[id]) { payload.progress[id] = S.progress[id]; sent.progress[id] = S.progress[id].updatedAt; }
    for (const id of S.dirty.conversations) if (S.conversations[id]) { payload.conversations.push(S.conversations[id]); sent.conversations[id] = S.conversations[id].updatedAt; }
    for (const k of ['lastBook', 'settings']) if (S.dirty[k] && S[k]) { payload[k] = S[k]; sent[k] = S[k].updatedAt; }

    const r = await fetch('/api/sync', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) });
    if (!r.ok) throw new Error('sync ' + r.status);
    const remote = await r.json();

    // clear dirty flags only for items unchanged since we sent them
    S.dirty.progress = S.dirty.progress.filter((id) => S.progress[id]?.updatedAt !== sent.progress[id]);
    S.dirty.conversations = S.dirty.conversations.filter((id) => S.conversations[id]?.updatedAt !== sent.conversations[id]);
    for (const k of ['lastBook', 'settings']) if (S.dirty[k] && S[k]?.updatedAt === sent[k]) S.dirty[k] = false;

    applyRemote(remote);
    online = true;
    setSyncStatus(outboxKeys.size ? 'pending' : 'synced');
    downloadMissing();
  } catch (e) {
    online = false;
    setSyncStatus('offline');
    console.warn('sync failed:', e.message);
  } finally {
    syncing = false;
    saveLocal();
  }
}

let lastRemoteNotice = 0, updateOffered = false, swError = '';
// Clear the saved app copy (service worker + its cache) and reload from the server.
// Books, positions, chats and keys (IndexedDB) are untouched.
async function hardReload() {
  try {
    for (const r of (await navigator.serviceWorker?.getRegistrations?.()) || []) await r.unregister();
    for (const k of (await caches?.keys?.()) || []) await caches.delete(k);
  } catch (e) { console.warn('hard reload', e); }
  location.reload();
}
// Another device read this book more recently than this one: offer to jump there (never move on our own).
function offerOtherDevice() {
  const p = S.progress[currentBookId], mine = S.here[currentBookId];
  if (!p?.cfi || p.device === S.deviceId || !locationsReady || !currentLoc) return;
  if (p.updatedAt <= (mine?.updatedAt || 0) || p.updatedAt <= lastRemoteNotice) return;
  const theirs = book.locations.locationFromCfi(p.cfi), ours = book.locations.locationFromCfi(currentLoc.start.cfi);
  if (Math.abs(theirs - ours) <= 1) return;
  lastRemoteNotice = p.updatedAt;
  const where = p.page ? `p. ${p.page}` : pctStr(p.percent);
  toast(`${p.deviceName || 'Another device'} is at ${where} (${theirs > ours ? 'ahead' : 'behind'})`, 'Jump', () => jumpTo(p.cfi), 15000);
}
function applyRemote(R) {
  if (R.build && BUILD && R.build !== BUILD && !updateOffered) {
    updateOffered = true;
    toast('A new version of the reader is available.', 'Update', hardReload, 0);
  }
  // books
  const remoteIds = new Set(R.books.map((b) => b.id));
  for (const b of R.books) S.books[b.id] = { ...S.books[b.id], ...b };
  for (const id of Object.keys(R.deleted || {})) {
    if (!remoteIds.has(id) && S.books[id]) removeLocalBook(id, false);
  }
  S.deleted = { ...S.deleted, ...R.deleted };

  // progress
  for (const [id, p] of Object.entries(R.progress || {})) S.progress[id] = mergeProgress(S.progress[id], p);
  // conversations
  for (const c of R.conversations || []) S.conversations[c.id] = mergeConv(S.conversations[c.id], c);
  // singletons
  S.lastBook = newer(S.lastBook, R.lastBook);
  const oldSettings = S.settings.updatedAt;
  S.settings = newer(S.settings, R.settings) || S.settings;
  if (S.settings.updatedAt !== oldSettings) renderProviderSelect();

  if (currentBookId && currentLoc) {
    offerOtherDevice();
    refreshAnnotations();
  }
  renderLibrary();
  if (!$('#chat-panel').hidden) renderChat();
  updateStatus();
}

let downloading = false;
async function downloadMissing() {
  if (downloading) return;
  downloading = true;
  try {
    const have = new Set(await idb.keys('files'));
    for (const id of Object.keys(S.books)) {
      if (!have.has(id)) await downloadBook(id).catch((e) => console.warn('download', id, e));
    }
  } finally { downloading = false; }
}
// One download per book at a time (background sync and opening the book share it), streamed so we can
// show progress, abort if the server stops sending, and report the real cause when it fails.
const downloads = new Map(); // id -> { promise, loaded, total, attempt }
// Partial downloads are saved to IndexedDB in ~4 MB parts as they arrive ('parts' store, keys
// `<id>:<seq>`; progress in kv `dl:<id>`), so a dropped connection, a refresh, or closing the app
// resumes from the last saved part with an HTTP Range request.
const mb = (n) => (n / 1048576).toFixed(1) + ' MB';
const STALL_MS = 30000;
const PART_BYTES = 4 * 1048576;
const partKey = (id, n) => `${id}:${String(n).padStart(6, '0')}`;
async function clearPartial(id) {
  await idb.delPrefix('parts', id + ':').catch(() => {});
  await idb.del('kv', 'dl:' + id).catch(() => {});
}

function downloadBook(id) {
  const existing = downloads.get(id);
  if (existing) return existing.promise;
  const d = { loaded: 0, total: S.books[id]?.size || 0, attempt: 0, receiving: false };
  const MAX_ATTEMPTS = 6;
  let saved = { loaded: 0, parts: 0, total: 0 }; // what is safely in IndexedDB
  let pending = [], pendingBytes = 0, flushChain = Promise.resolve();

  const flush = () => {
    if (!pendingBytes) return flushChain;
    const blob = new Blob(pending), bytes = pendingBytes;
    pending = []; pendingBytes = 0;
    flushChain = flushChain.then(async () => {
      await idb.set('parts', partKey(id, saved.parts), blob);
      saved = { loaded: saved.loaded + bytes, parts: saved.parts + 1, total: d.total };
      await idb.set('kv', 'dl:' + id, saved);
    });
    return flushChain;
  };
  const restart = async () => {
    pending = []; pendingBytes = 0;
    await flushChain.catch(() => {});
    await clearPartial(id);
    saved = { loaded: 0, parts: 0, total: 0 };
    d.loaded = 0;
  };

  async function attempt() {
    const ctrl = new AbortController();
    let stallT, stalled = false;
    const arm = () => { clearTimeout(stallT); stallT = setTimeout(() => { stalled = true; ctrl.abort(); }, STALL_MS); };
    arm();
    try {
      let r;
      const headers = d.loaded ? { range: `bytes=${d.loaded}-` } : {};
      try { r = await fetch(`/api/books/${id}/file`, { signal: ctrl.signal, cache: 'no-store', headers }); }
      catch (e) { throw Object.assign(new Error(stalled ? 'stalled' : `can't reach the server (${e.message})`), { retry: true }); }
      if (r.status === 404) {
        await restart();
        throw new Error("The server doesn't have this book's file (HTTP 404). Open the reader on the device you added it from so it can upload, or add the EPUB again.");
      }
      if (r.status === 416) { await restart(); throw Object.assign(new Error('saved partial download no longer matches the server'), { retry: true }); }
      if (!r.ok) throw Object.assign(new Error(`server returned HTTP ${r.status}`), { retry: r.status >= 500 });
      if (d.loaded && r.status !== 206) await restart(); // server ignored the range: start over
      if (!d.loaded) d.total = Number(r.headers.get('content-length')) || d.total;
      const reader = r.body.getReader();
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          pending.push(value);
          pendingBytes += value.length;
          d.loaded += value.length;
          d.receiving = true;
          arm();
          if (pendingBytes >= PART_BYTES) flush();
        }
      } catch (e) {
        throw Object.assign(new Error(stalled ? 'stalled' : `connection dropped (${e.message})`), { retry: true });
      }
      if (d.total && d.loaded < d.total) throw Object.assign(new Error('connection closed early'), { retry: true });
    } finally {
      clearTimeout(stallT);
      await flush().catch(() => {}); // keep whatever arrived, even on failure
    }
  }

  async function run() {
    if (await idb.get('files', id)) return; // another tab finished it
    const prev = await idb.get('kv', 'dl:' + id);
    if (prev?.loaded && (!d.total || prev.total === d.total)) {
      saved = prev;
      d.loaded = prev.loaded;
      d.total = prev.total || d.total;
    } else if (prev) await clearPartial(id);

    for (;;) {
      d.attempt++;
      d.receiving = false;
      try { await attempt(); break; }
      catch (e) {
        d.receiving = false;
        d.loaded = saved.loaded; // resume from what is safely stored
        if (!e.retry) throw e;
        if (d.attempt >= MAX_ATTEMPTS) {
          const why = e.message === 'stalled' ? `no data from the server for ${STALL_MS / 1000} s` : e.message;
          throw new Error(`Download failed after ${MAX_ATTEMPTS} tries (${why}). Got ${mb(d.loaded)}${d.total ? ' of ' + mb(d.total) : ''}; Retry continues from there.`);
        }
        await new Promise((res) => setTimeout(res, Math.min(10000, 1500 * d.attempt)));
      }
    }
    await flushChain;
    const parts = [];
    for (let i = 0; i < saved.parts; i++) {
      const part = await idb.get('parts', partKey(id, i));
      if (!part) { await restart(); throw new Error('A saved piece of the download was missing; Retry downloads it again.'); }
      parts.push(part);
    }
    const blob = new Blob(parts, { type: 'application/epub+zip' });
    if (d.total && blob.size !== d.total) {
      await restart();
      throw new Error(`Download incomplete: got ${mb(blob.size)} of ${mb(d.total)}. Retry downloads it again.`);
    }
    try { await idb.set('files', id, blob); }
    catch (e) { throw new Error(`Downloaded, but couldn't save it on this device (${e.name || e.message}). Browser storage may be full or blocked, e.g. in a private window.`); }
    await clearPartial(id);
    // Cover from a big book means parsing it a second time; for those, the cover is made when it's opened.
    if (blob.size < 30 * 1048576) blob.arrayBuffer().then((buf) => makeCover(id, buf)).then(renderLibrary);
    renderLibrary();
  }

  d.promise = (async () => {
    try {
      // one tab at a time per book; a second tab waits, then finds the finished file
      if (navigator.locks) await navigator.locks.request('download:' + id, run);
      else await run();
    } finally {
      downloads.delete(id);
    }
  })();
  downloads.set(id, d);
  return d.promise;
}

// ---------------------------------------------------------------- library
async function makeCover(id, buf) {
  try {
    const b = ePub(buf.slice(0));
    await b.ready;
    const url = await b.coverUrl();
    if (url) {
      const img = new Image();
      img.src = url;
      await img.decode();
      const c = document.createElement('canvas');
      const h = 200, w = Math.round((img.width / img.height) * h) || 140;
      c.width = w; c.height = h;
      c.getContext('2d').drawImage(img, 0, 0, w, h);
      await idb.set('kv', 'cover:' + id, c.toDataURL('image/jpeg', 0.8));
    }
    b.destroy();
  } catch (e) { console.warn('cover', e); }
}

async function addFiles(files) {
  let firstId = null;
  for (const f of files) {
    if (!/\.epub$/i.test(f.name) && f.type !== 'application/epub+zip') { toast(`${f.name} is not an EPUB`); continue; }
    if (Object.values(S.books).some((b) => b.filename === f.name && b.size === f.size)) { toast(`${f.name} is already in your library`); continue; }
    const id = uid();
    const buf = await f.arrayBuffer();
    const meta = { id, filename: f.name, title: f.name.replace(/\.epub$/i, ''), author: '', size: f.size, addedAt: Date.now() };
    try {
      const b = ePub(buf.slice(0));
      await b.ready;
      const md = await b.loaded.metadata;
      meta.title = md.title || meta.title;
      meta.author = md.creator || '';
      setTimeout(() => b.destroy(), 0);
    } catch (e) { toast(`Could not read ${f.name}: ${e.message}`); continue; }
    await idb.set('files', id, new Blob([buf], { type: 'application/epub+zip' }));
    await makeCover(id, buf);
    S.books[id] = meta;
    await queue({ key: 'upload:' + id, type: 'upload', id, meta });
    firstId ||= id;
  }
  saveLocal();
  renderLibrary();
  sync();
  if (firstId) { closeDrawers(); openBook(firstId); }
}

async function removeLocalBook(id, queueDelete = true) {
  delete S.books[id];
  delete S.progress[id];
  delete S.here[id];
  S.deleted[id] = Date.now();
  for (const c of Object.values(S.conversations)) if (c.bookId === id) Object.assign(c, { deleted: true, updatedAt: Date.now() });
  await idb.del('files', id).catch(() => {});
  await clearPartial(id);
  await idb.del('kv', 'cover:' + id).catch(() => {});
  await idb.del('kv', 'loc:' + id).catch(() => {});
  if (outboxKeys.has('upload:' + id)) { await idb.del('outbox', 'upload:' + id); outboxKeys.delete('upload:' + id); }
  else if (queueDelete) await queue({ key: 'delete:' + id, type: 'delete', id });
  if (currentBookId === id) closeBook();
  saveLocal();
  renderLibrary();
}

let libraryGen = 0;
async function renderLibrary() {
  const gen = ++libraryGen;
  const list = document.createElement('ul');
  const have = new Set(await idb.keys('files').catch(() => []));
  const books = Object.values(S.books).sort((a, b) => (S.progress[b.id]?.updatedAt || b.addedAt) - (S.progress[a.id]?.updatedAt || a.addedAt));
  if (!books.length) list.append(el('li', { class: 'hint' }, 'No books yet.'));
  for (const b of books) {
    const p = { ...(S.progress[b.id] || {}), percent: here(b.id)?.percent };
    const cover = await idb.get('kv', 'cover:' + b.id).catch(() => null);
    list.append(el('li', { class: b.id === currentBookId ? 'current' : '', onclick: () => { closeDrawers(); openBook(b.id); } },
      el('div', { class: 'cover' }, cover ? el('img', { src: cover, alt: '' }) : '📖'),
      el('div', { class: 'book-meta' },
        el('div', { class: 't truncate' }, b.title),
        el('div', { class: 'a truncate' }, b.author || ' '),
        el('div', { class: 'p' }, `${pctStr(p.percent)} · furthest ${pctStr(p.furthestPercent)}${have.has(b.id) ? '' : downloads.has(b.id) ? ' · downloading…' : ' · not downloaded'}`),
        el('div', { class: 'bar' }, el('b', { style: `width:${(p.furthestPercent || 0) * 100}%` }), el('i', { style: `width:${(p.percent || 0) * 100}%` }))),
      el('button', {
        class: 'ghost small', title: 'Remove from library (all devices)',
        onclick: (e) => { e.stopPropagation(); if (confirm(`Remove "${b.title}" from all devices? Its chats are removed too.`)) { removeLocalBook(b.id); sync(); } },
      }, '✕')));
  }
  if (gen === libraryGen) $('#library-list').replaceChildren(...list.childNodes); // a newer render supersedes this one
}

// ---------------------------------------------------------------- reader
let book = null, rendition = null, currentBookId = null, currentLoc = null, locationsReady = false;
let flatToc = [], navSource = null, lastLocalNav = 0, backStack = [];

function closeBook() {
  try { rendition?.destroy(); book?.destroy(); } catch {}
  book = rendition = currentLoc = null;
  currentBookId = null;
  locationsReady = false;
  annotated.clear();
  annotatedKey = '';
  backStack = [];
  $('#btn-back').hidden = true;
  $('#viewer').replaceChildren();
  $('#empty-state').hidden = false;
  $('#book-title').textContent = '';
  $('#btn-toc').disabled = $('#btn-chat').disabled = $('#scrubber').disabled = true;
  $('#chat-panel').hidden = true;
  updateStatus();
}

async function openBook(id) {
  let blob = await idb.get('files', id);
  if (!blob) {
    if (!S.books[id]) return;
    const title = S.books[id].title;
    const p = downloadBook(id);
    const tick = () => {
      const d = downloads.get(id);
      if (d) toast(`Downloading “${title}”… ${mb(d.loaded)}${d.total ? ' / ' + mb(d.total) : ''}${d.attempt > 1 && !d.receiving ? ` (reconnecting, try ${d.attempt})` : ''}`, null, null, 0);
    };
    tick();
    const iv = setInterval(tick, 400);
    try { await p; blob = await idb.get('files', id); $('#toast').hidden = true; }
    catch (e) { toast(e.message, 'Retry', () => openBook(id), 0); return; }
    finally { clearInterval(iv); }
  }
  closeBook();
  currentBookId = id;
  const meta = S.books[id];
  $('#empty-state').hidden = true;
  $('#book-title').textContent = meta.title + (meta.author ? ' — ' + meta.author : '');
  document.title = meta.title;

  book = ePub(await blob.arrayBuffer());
  const thisOpen = book._rdKey = id + ':' + Date.now();
  rendition = book.renderTo('viewer', { width: '100%', height: '100%', flow: 'paginated', spread: 'auto', allowScriptedContent: false });
  registerThemes();
  applyPrefs();

  rendition.hooks.content.register(attachContentHandlers);
  rendition.on('relocated', onRelocated);
  rendition.on('selected', onSelected);
  rendition.on('keyup', onKey);

  if (!S.here[id] && S.progress[id]?.cfi) {
    const r = S.progress[id];
    S.here[id] = { cfi: r.cfi, percent: r.percent, page: r.page, totalPages: r.totalPages, chapter: r.chapter, updatedAt: 0 };
  }
  const p = here(id);
  lastLocalNav = Date.now();
  try {
    await rendition.display(p?.cfi || undefined);
    takeOverResize();
    // Theme CSS (line-height/font size) reflows the section after the first layout; settle, then put
    // the saved first line back at the top of the page.
    if (p?.cfi) { await new Promise((r) => setTimeout(r, 60)); await displayAnchored(p.cfi); }
  } catch (e) { console.warn('restore position', e); await rendition.display(); }

  idb.get('kv', 'cover:' + id).then(async (have) => {
    if (have || book?._rdKey !== thisOpen) return;
    try {
      const url = await book.coverUrl();
      if (!url) return;
      const img = new Image(); img.src = url; await img.decode();
      const c = document.createElement('canvas'), h = 200;
      c.height = h; c.width = Math.round((img.width / img.height) * h) || 140;
      c.getContext('2d').drawImage(img, 0, 0, c.width, h);
      await idb.set('kv', 'cover:' + id, c.toDataURL('image/jpeg', 0.8));
      renderLibrary();
    } catch (e) { console.warn('cover', e); }
  });

  const nav = await book.loaded.navigation;
  flatToc = [];
  (function walk(items, depth) {
    for (const it of items) {
      const href = resolveTocHref(it.href);
      flatToc.push({ label: (it.label || '').trim(), href, depth, idx: href ? book.spine.get(href)?.index ?? -1 : -1 });
      if (it.subitems?.length) walk(it.subitems, depth + 1);
    }
  })(nav.toc || [], 0);
  renderToc();
  $('#btn-toc').disabled = $('#btn-chat').disabled = false;

  S.lastBook = { bookId: id, updatedAt: Date.now() };
  markDirty('lastBook');
  renderLibrary();
  refreshAnnotations();
  if (!$('#chat-panel').hidden) renderChat();

  // page numbers: cached per book, generated once
  const cached = await idb.get('kv', 'loc:' + id);
  const thisBook = book;
  if (cached) book.locations.load(cached);
  else {
    $('#page-info').textContent = 'Counting pages…';
    await book.locations.generate(1200);
    if (thisBook !== book) return;
    idb.set('kv', 'loc:' + id, book.locations.save());
  }
  if (thisBook !== book) return;
  locationsReady = true;
  $('#scrubber').disabled = false;
  saveProgress(true);
  updateStatus();
  offerOtherDevice();
}

function registerThemes() {
  // orphans/widows 1: lines fill columns exactly, so the anchor spacer below lands lines precisely.
  rendition.themes.default({
    'html, body': { orphans: '1 !important', widows: '1 !important' },
    '[data-rd-anchor]::before': { content: '""', display: 'block', height: 'var(--rd-gap, 0px)' },
  });
  const base = { 'line-height': '1.6' };
  rendition.themes.register('light', { body: { ...base, background: '#fbfaf7 !important', color: '#1d1c1a !important' } });
  rendition.themes.register('sepia', { body: { ...base, background: '#f6ecd6 !important', color: '#3b2f22 !important' } });
  rendition.themes.register('dark', {
    body: { ...base, background: '#1a1a19 !important', color: '#e3dfd6 !important' },
    'a, a:link, a:visited': { color: '#8cc7b2 !important' },
    '*': { 'border-color': '#444 !important' },
    // light boxes (code blocks, tables, call-outs): invert so they become dark with light text,
    // keeping the hues of syntax highlighting; images inside are inverted back
    '.rd-invert': { filter: 'invert(1) hue-rotate(180deg) !important', color: '#1d1c1a !important' },
    '.rd-invert, .rd-invert *': { 'border-color': '#cfcfcf !important' },
    '.rd-invert img, .rd-invert svg, .rd-invert video, .rd-invert picture': { filter: 'invert(1) hue-rotate(180deg) !important' },
    // dark text sitting directly on the dark page: same hue, made light
    '.rd-lighten': { color: 'var(--rd-fg) !important' },
  });
}

function applyPrefs() {
  const t = S.prefs.theme || 'light';
  document.body.dataset.theme = t;
  document.querySelector('meta[name="theme-color"]').content = getComputedStyle(document.body).getPropertyValue('--bg').trim();
  const key = t + '|' + (S.prefs.fontSize || 100) + '|' + (S.prefs.columns || 'auto');
  if (rendition && rendition._appliedPrefs !== key) {
    const hadPrefs = !!rendition._appliedPrefs;
    rendition._appliedPrefs = key;
    rendition.themes.select(t);
    for (const c of rendition.getContents()) fixContrast(c);
    rendition.themes.fontSize((S.prefs.fontSize || 100) + '%');
    if (hadPrefs) requestRelayout(0); // text size / columns reflow: keep the same first line
    else applyColumns();
  }
}

// ---------------------------------------------------------------- stable layout
// epub.js lays a chapter out in fixed columns from its first line, and after any reflow (resize, chat
// panel, text size) shows the page that *contains* the reading position, so the first line jumps.
// We own every reflow instead:
//   1. one serialized relayout at a time (epub.js's own window-resize handler is disabled; racing
//      re-renders are what left a blank band at the bottom after resizing)
//   2. after re-rendering, a CSS-only spacer (::before on the anchor's block, no DOM nodes added, so
//      CFIs and saved positions are unaffected) pushes the saved first line to the top of a page.
function takeOverResize() {
  const st = rendition?.manager?.stage;
  if (!st || st._rdOwned) return;
  st._rdOwned = true;
  if (st.resizeFunc) window.removeEventListener('resize', st.resizeFunc);
  if (st.orientationChangeFunc) window.removeEventListener('orientationchange', st.orientationChangeFunc);
}

let relayoutT = null, relayoutChain = Promise.resolve();
function requestRelayout(delay = 150) {
  clearTimeout(relayoutT);
  relayoutT = setTimeout(() => { relayoutChain = relayoutChain.then(relayout, relayout); }, delay);
}
async function relayout() {
  if (!rendition?.manager || !currentBookId) return;
  const r = rendition;
  const anchor = here(currentBookId)?.cfi || currentLoc?.start.cfi;
  applyColumns();
  r.manager._stageSize = undefined; // always re-measure; a stale cached size skipped real resizes
  r.manager.resize(undefined, undefined, anchor); // re-renders views at the container's real size
  if (anchor && r === rendition) await displayAnchored(anchor).catch((e) => console.warn('relayout', e));
}

const frames = (n = 2) => new Promise((res) => { const f = () => (--n <= 0 ? res() : requestAnimationFrame(f)); requestAnimationFrame(f); });

async function displayAnchored(cfi) {
  const r = rendition;
  await r.display(cfi);
  if (r !== rendition) return;
  await frames();
  if (placeAnchor(cfi)) {
    await frames();
    const view = r.manager.views.all().find((v) => v.contents && v.section?.index === sectionIndexOf(cfi));
    view?.expand();
    await r.display(cfi);
  }
}

function sectionIndexOf(cfi) {
  try { return book.spine.get(cfi)?.index; } catch { return undefined; }
}

// Make the line at `cfi` the first line of a page. Returns true if the layout changed.
function placeAnchor(cfi) {
  const idx = sectionIndexOf(cfi);
  const contents = rendition.getContents().find((c) => c.sectionIndex === idx);
  if (!contents) return false;
  const doc = contents.document, body = doc.body;
  let changed = false;
  for (const e of doc.querySelectorAll('[data-rd-anchor]')) { e.removeAttribute('data-rd-anchor'); e.style.removeProperty('--rd-gap'); changed = true; }

  let range;
  try { range = contents.range(cfi); } catch { return changed; }
  const lay = rendition.manager.layout;
  const delta = lay.delta, two = lay.divisor === 2;
  const bcs = doc.defaultView.getComputedStyle(body);
  const brect = body.getBoundingClientRect();
  const colTop = brect.top + parseFloat(bcs.paddingTop);
  const colH = body.clientHeight - parseFloat(bcs.paddingTop) - parseFloat(bcs.paddingBottom);
  if (!delta || !(colH > 50)) return changed;

  const node = range.startContainer.nodeType === 3 ? range.startContainer : (range.startContainer.childNodes[range.startOffset] || range.startContainer);
  const textEl = node.nodeType === 3 ? node.parentElement : node;
  const lineH = parseFloat(doc.defaultView.getComputedStyle(textEl).lineHeight) || parseFloat(doc.defaultView.getComputedStyle(textEl).fontSize) * 1.5 || 20;
  const measure = () => {
    const rr = doc.createRange();
    if (node.nodeType === 3) {
      const o = node === range.startContainer ? range.startOffset : 0;
      rr.setStart(node, Math.min(o, node.length));
      rr.setEnd(node, Math.min(o + 1, node.length));
      const rc = rr.getClientRects()[0] || rr.getBoundingClientRect();
      return rc;
    }
    return node.getBoundingClientRect();
  };

  // nearest block-level ancestor gets the spacer
  let block = textEl;
  while (block && block !== body && !/^(block|list-item|flow-root|table)$/.test(doc.defaultView.getComputedStyle(block).display)) block = block.parentElement;
  if (!block || block === body || block === doc.documentElement) return changed;

  let gap = 0;
  for (let i = 0; i < 6; i++) {
    const rc = measure();
    if (!rc || (!rc.width && !rc.height)) break;
    const yOff = rc.top - colTop;
    const atTop = yOff < lineH * 0.6;
    const secondCol = two && ((rc.left % delta) + delta) % delta >= delta / 2;
    if (atTop && !secondCol) return changed || gap > 0;
    gap += atTop ? colH : Math.max(1, colH - yOff - 0.5);
    block.setAttribute('data-rd-anchor', '');
    block.style.setProperty('--rd-gap', gap.toFixed(1) + 'px');
    changed = true;
  }
  return changed;
}


// Column layout. We decide one vs two columns ourselves from the space available:
// - two columns only when each column keeps >= ~480px of text (scaled by text size);
//   epub.js's default switches at 800px total, which gives cramped ~340px columns
// - a single column is capped at a readable line length and centred, instead of
//   stretching across a wide window.
const COL_MIN_PX = 480, SINGLE_MAX_PX = 760;
function applyColumns() {
  if (!rendition) return;
  const scale = (S.prefs.fontSize || 100) / 100;
  const avail = $('#viewer').parentElement.clientWidth - $('#prev').offsetWidth - $('#next').offsetWidth;
  const mode = S.prefs.columns || 'auto';
  // epub.js leaves a gap of ~16% of the width between the two columns: column = 0.418 × width
  const two = mode === 'two' ? avail >= 600 : mode === 'auto' ? avail * 0.418 >= COL_MIN_PX * scale : false;
  const maxW = two ? '' : Math.round(SINGLE_MAX_PX * scale) + 'px';
  const k = two + '|' + maxW;
  if (rendition._colKey === k) return false;
  rendition._colKey = k;
  $('#viewer').style.maxWidth = maxW;
  rendition.spread(two ? 'auto' : 'none', two ? 1 : undefined);
  return true;
}

// ---------------------------------------------------------------- dark-mode contrast
// Books style some elements for a white page (code blocks with a white background, black text set in
// the book's CSS). In dark mode: elements with a light background are inverted as a unit; dark text
// directly on the page is lightened keeping its hue. Only classes and a CSS variable are added, so
// CFIs (positions, highlights) are unaffected.
function parseRgb(c) {
  const m = /rgba?\(([^)]+)\)/.exec(c || '');
  if (!m) return null;
  const [r, g, b, a = 1] = m[1].split(/[ ,/]+/).filter(Boolean).map(Number);
  return { r, g, b, a };
}
const luminance = ({ r, g, b }) => (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
function lightened({ r, g, b }) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b), l = (max + min) / 2, dlt = max - min;
  let h = 0, sat = 0;
  if (dlt) {
    sat = dlt / (1 - Math.abs(2 * l - 1));
    h = max === r ? ((g - b) / dlt) % 6 : max === g ? (b - r) / dlt + 2 : (r - g) / dlt + 4;
    h = (h * 60 + 360) % 360;
  }
  return sat < 0.08 ? '#e3dfd6' : `hsl(${Math.round(h)} ${Math.round(Math.min(sat, 0.65) * 100)}% 72%)`;
}
function fixContrast(contents) {
  const doc = contents?.document;
  if (!doc?.body) return;
  for (const e of doc.querySelectorAll('.rd-invert, .rd-lighten')) { e.classList.remove('rd-invert', 'rd-lighten'); e.style.removeProperty('--rd-fg'); }
  if ((S.prefs.theme || 'light') !== 'dark') return;
  const win = doc.defaultView;
  const skip = /^(img|svg|image|video|canvas|picture|math|br|hr)$/i;
  for (const e of doc.body.querySelectorAll('*')) {
    if (skip.test(e.localName) || e.parentElement?.closest('.rd-invert')) continue; // inside an inverted box: handled by it
    const cs = win.getComputedStyle(e);
    const bg = parseRgb(cs.backgroundColor);
    if (bg && bg.a > 0.3 && luminance(bg) > 0.55) { e.classList.add('rd-invert'); continue; }
    const fg = parseRgb(cs.color);
    if (fg && luminance(fg) < 0.45 && [...e.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim())) {
      e.style.setProperty('--rd-fg', lightened(fg));
      e.classList.add('rd-lighten');
    }
  }
}

function attachContentHandlers(contents) {
  requestAnimationFrame(() => fixContrast(contents));
  const doc = contents.document;
  let x0 = null, y0 = null, t0 = 0;
  doc.addEventListener('touchstart', (e) => { x0 = e.touches[0].clientX; y0 = e.touches[0].clientY; t0 = Date.now(); }, { passive: true });
  doc.addEventListener('touchend', (e) => {
    if (x0 == null) return;
    const dx = e.changedTouches[0].clientX - x0, dy = e.changedTouches[0].clientY - y0;
    x0 = null;
    if (doc.getSelection()?.toString()) return;
    if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy) * 1.5 && Date.now() - t0 < 800) dx < 0 ? next() : prev();
  }, { passive: true });
  doc.addEventListener('mousedown', () => hideSelectionPop());
  doc.addEventListener('selectionchange', () => { if (!doc.getSelection()?.toString().trim()) hideSelectionPop(); });
}

function onKey(e) {
  if (e.target?.closest?.('textarea, input, select')) return;
  if (e.key === 'ArrowRight' || e.key === 'PageDown' || (e.key === ' ' && !e.shiftKey)) next();
  else if (e.key === 'ArrowLeft' || e.key === 'PageUp' || (e.key === ' ' && e.shiftKey)) prev();
}

function next() { if (!rendition) return; navSource = 'turn'; lastLocalNav = Date.now(); rendition.next(); }
function prev() { if (!rendition) return; navSource = 'back'; lastLocalNav = Date.now(); rendition.prev(); }
async function jumpTo(target, { remember = true } = {}) {
  if (!rendition || !target) return;
  if (remember && currentLoc) { backStack.push(currentLoc.start.cfi); $('#btn-back').hidden = false; }
  navSource = 'jump';
  lastLocalNav = Date.now();
  try { await rendition.display(target); }
  catch (e) { console.warn('jump', target, e); toast(`Could not open that location (${e?.message || e}).`); }
}
function goBack() {
  const cfi = backStack.pop();
  if (cfi) jumpTo(cfi, { remember: false });
  $('#btn-back').hidden = !backStack.length;
}

function onRelocated(loc) {
  currentLoc = loc;
  hideSelectionPop();
  saveProgress();
  updateStatus();
  highlightTocCurrent();
}

function currentPercent() {
  if (!currentLoc) return null;
  return locationsReady ? book.locations.percentageFromCfi(currentLoc.start.cfi) : null;
}
function currentPage() {
  if (!currentLoc || !locationsReady) return null;
  return book.locations.locationFromCfi(currentLoc.start.cfi) + 1;
}
function currentChapter() {
  if (!currentLoc) return '';
  const idx = currentLoc.start.index;
  let best = null;
  for (const t of flatToc) if (t.idx >= 0 && t.idx <= idx && (!best || t.idx > best.idx)) best = t;
  return best?.label || '';
}

// Only user navigation moves the saved position. Relocations caused by opening the book or resizing
// (chat panel, rotation) land on the page *containing* the saved CFI, whose start is slightly earlier;
// saving those would make the position creep backwards on every reload.
function saveProgress(force = false) {
  if (!currentLoc || !currentBookId) return;
  const p = S.progress[currentBookId] || {};          // synced: latest position anywhere + furthest
  const mine = S.here[currentBookId] || null;          // this device only
  if (!navSource && !force) return;
  const cfi = !navSource && mine?.cfi ? mine.cfi : (!navSource && !mine && p.cfi ? p.cfi : currentLoc.start.cfi);
  const pct = locationsReady ? book.locations.percentageFromCfi(cfi) : null;
  const page = locationsReady ? book.locations.locationFromCfi(cfi) + 1 : mine?.page;
  const updateFurthest = locationsReady && pct != null && pct > (p.furthestPercent ?? -1) && (navSource === 'turn' || p.furthestPercent == null);
  const userMoved = !!navSource;
  navSource = null;
  const pos = { cfi, percent: pct ?? mine?.percent ?? 0, page, totalPages: locationsReady ? book.locations.total : mine?.totalPages, chapter: currentChapter() };
  const moved = mine?.cfi !== cfi;
  if (!moved && !updateFurthest && !(force && mine && mine.page !== pos.page)) return;
  // a position only becomes "latest" (shown to other devices) when the user actually moved here
  const stamp = moved && (userMoved || !mine) ? Date.now() : (mine?.updatedAt || 0);
  S.here[currentBookId] = { ...pos, updatedAt: stamp };
  if (userMoved || updateFurthest) {
    const np = { ...p };
    if (userMoved) Object.assign(np, pos, { updatedAt: Date.now(), device: S.deviceId, deviceName: deviceName() });
    if (updateFurthest) Object.assign(np, { furthestCfi: cfi, furthestPercent: pct, furthestChapter: pos.chapter });
    S.progress[currentBookId] = np;
    markDirty('progress', currentBookId);
  } else saveLocal();
}

function updateStatus() {
  const p = currentBookId ? S.progress[currentBookId] : null;
  $('#chapter-name').textContent = currentLoc ? currentChapter() : '';
  if (!currentLoc) { $('#page-info').textContent = ''; $('#btn-furthest').hidden = true; return; }
  const sec = currentLoc.start.displayed;
  const chap = sec ? ` · ${sec.total - sec.page} left in chapter` : '';
  if (locationsReady) {
    $('#page-info').textContent = `p. ${currentPage()} / ${book.locations.total} · ${pctStr(currentPercent())}${chap}`;
    if (document.activeElement !== $('#scrubber')) $('#scrubber').value = Math.round((currentPercent() || 0) * 1000);
  } else if (!$('#page-info').textContent.startsWith('Counting')) $('#page-info').textContent = chap.slice(3);
  const far = p?.furthestPercent;
  const showFar = locationsReady && far != null && p.furthestCfi && far - Math.max(here(currentBookId)?.percent || 0, currentPercent() || 0) > 0.004;
  $('#btn-furthest').hidden = !showFar;
  if (showFar) $('#btn-furthest').textContent = `Furthest read (${pctStr(far)}) ›`;
}

// Contents links are written relative to the nav/NCX file, but epub.js looks them up relative to the
// package (OPF) folder. When those differ (e.g. Nav/toc.xhtml linking to ../Text/ch1.xhtml), or the
// link is URL-encoded differently from the manifest, the lookup fails. Map each link to its spine item.
function resolveTocHref(href) {
  if (!href) return null;
  const hashAt = href.indexOf('#');
  const path = hashAt >= 0 ? href.slice(0, hashAt) : href;
  const frag = hashAt >= 0 ? href.slice(hashAt) : '';
  const get = (p) => { try { return p ? book.spine.get(p) : null; } catch { return null; } };
  const dec = (p) => { try { return decodeURIComponent(p); } catch { return p; } };
  let sec = get(path) || get(dec(path)) || get(encodeURI(dec(path)));
  if (!sec) {
    // resolve relative to the nav document's folder (paths are relative to the OPF folder)
    const navPath = book.packaging?.navPath || book.packaging?.ncxPath || '';
    try {
      const resolved = new URL(path, 'http://book/' + navPath).pathname.slice(1);
      sec = get(resolved) || get(dec(resolved));
    } catch {}
  }
  if (!sec && path) {
    // last resort: the spine item whose path shares the longest tail with the link
    const want = dec(path).split('/').filter((x) => x && x !== '.' && x !== '..');
    let bestN = 0;
    book.spine.each((item) => {
      const have = dec(item.href).split('/');
      let n = 0;
      while (n < want.length && n < have.length && want[want.length - 1 - n] === have[have.length - 1 - n]) n++;
      if (n > bestN) { bestN = n; sec = item; }
    });
  }
  if (!sec) return path ? null : href; // a bare '#id' stays as is
  return sec.href + frag;
}

function renderToc() {
  const ul = $('#toc-list');
  ul.replaceChildren(...flatToc.map((t) => el('li', {},
    el('a', {
      href: '#', 'data-idx': t.idx, style: `padding-left:${10 + t.depth * 16}px`,
      class: t.href ? '' : 'missing', title: t.href ? null : 'This entry points to a file that is not in the book',
      onclick: (e) => { e.preventDefault(); closeDrawers(); if (t.href) jumpTo(t.href); else toast('This contents entry points to a part of the book that is missing from the EPUB.'); },
    }, t.label || '(untitled)'))));
}
function highlightTocCurrent() {
  const label = currentChapter();
  for (const a of $$('#toc-list a')) a.classList.toggle('current', a.textContent === label);
}

// ---------------------------------------------------------------- page text + selection
function rangeText(r) { return r.toString().replace(/\s+/g, ' ').trim(); }

function currentPageText() {
  if (!rendition) return '';
  try {
    const loc = rendition.currentLocation();
    const cs = rendition.getContents();
    const cStart = cs.find((c) => c.sectionIndex === loc.start.index) || cs[0];
    const cEnd = cs.find((c) => c.sectionIndex === loc.end.index) || cStart;
    const rs = cStart.range(loc.start.cfi);
    const re = cEnd.range(loc.end.cfi);
    if (cStart === cEnd) {
      const r = cStart.document.createRange();
      r.setStart(rs.startContainer, rs.startOffset);
      r.setEnd(re.endContainer, re.endOffset);
      return rangeText(r);
    }
    const r1 = cStart.document.createRange();
    r1.setStart(rs.startContainer, rs.startOffset);
    r1.setEndAfter(cStart.document.body.lastChild || cStart.document.body);
    const r2 = cEnd.document.createRange();
    r2.setStartBefore(cEnd.document.body.firstChild || cEnd.document.body);
    r2.setEnd(re.endContainer, re.endOffset);
    return rangeText(r1) + '\n\n' + rangeText(r2);
  } catch (e) {
    console.warn('page text', e);
    return '';
  }
}

let pendingSelection = null;
function onSelected(cfiRange, contents) {
  const sel = contents.window.getSelection();
  const text = sel?.toString().replace(/\s+/g, ' ').trim();
  if (!text) return;
  pendingSelection = { cfiRange, text };
  const rect = sel.getRangeAt(0).getBoundingClientRect();
  const frame = contents.document.defaultView.frameElement.getBoundingClientRect();
  const pop = $('#selection-pop');
  pop.hidden = false;
  const w = pop.offsetWidth || 130;
  const x = Math.min(window.innerWidth - w - 8, Math.max(8, frame.left + rect.left + rect.width / 2 - w / 2));
  let y = frame.top + rect.bottom + 8;
  if (y > window.innerHeight - 60) y = frame.top + rect.top - 44;
  pop.style.left = x + 'px';
  pop.style.top = y + 'px';
}
function hideSelectionPop() { $('#selection-pop').hidden = true; }

// highlights for saved highlight-conversations
let annotated = new Set(), annotatedKey = '';
function refreshAnnotations() {
  if (!rendition) return;
  const wanted = Object.values(S.conversations).filter((c) => c.bookId === currentBookId && !c.deleted && c.context?.type === 'highlight' && c.context.cfiRange);
  const key = currentBookId + '|' + wanted.map((c) => c.id).sort().join(',');
  if (key === annotatedKey) return;
  annotatedKey = key;
  for (const cfi of annotated) rendition.annotations.remove(cfi, 'highlight');
  annotated.clear();
  for (const c of wanted) {
    if (annotated.has(c.context.cfiRange)) continue;
    try {
      rendition.annotations.highlight(c.context.cfiRange, { convId: c.id }, () => openThread(c.id), 'conv-hl',
        { fill: '#f5c542', 'fill-opacity': '0.35', 'mix-blend-mode': 'multiply' });
      annotated.add(c.context.cfiRange);
    } catch (e) { console.warn('annotate', e); }
  }
}

// ---------------------------------------------------------------- AI providers
const PRESETS = {
  anthropic: { name: 'Claude', type: 'anthropic', baseUrl: 'https://api.anthropic.com', model: 'claude-sonnet-5-5' },
  openai: { name: 'OpenAI', type: 'openai', baseUrl: 'https://api.openai.com/v1', model: 'gpt-5' },
  openrouter: { name: 'OpenRouter', type: 'openai', baseUrl: 'https://openrouter.ai/api/v1', model: 'anthropic/claude-sonnet-5.5' },
  gemini: { name: 'Gemini', type: 'openai', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', model: 'gemini-2.5-pro' },
  ollama: { name: 'Ollama', type: 'openai', baseUrl: 'http://localhost:11434/v1', model: 'llama3.1' },
  custom: { name: 'Custom', type: 'openai', baseUrl: 'https://', model: '' },
};
const getProvider = (id) => S.settings.providers.find((p) => p.id === id) ||
  S.settings.providers.find((p) => p.id === S.settings.defaultProviderId) || S.settings.providers[0];

class ProviderError extends Error {}

async function readSSE(resp, onData) {
  const reader = resp.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line.startsWith('data:')) continue;
      const d = line.slice(5).trim();
      if (d === '[DONE]') return;
      let j;
      try { j = JSON.parse(d); } catch { continue; }
      onData(j);
    }
  }
}

async function streamChat(provider, system, messages, onText, signal) {
  const base = (provider.baseUrl || '').replace(/\/+$/, '');
  if (provider.type === 'anthropic') {
    const r = await fetch(base + '/v1/messages', {
      method: 'POST', signal,
      headers: {
        'content-type': 'application/json', 'x-api-key': provider.apiKey || '',
        'anthropic-version': '2023-06-01', 'anthropic-dangerous-direct-browser-access': 'true',
      },
      body: JSON.stringify({ model: provider.model, max_tokens: 4096, system, messages, stream: true }),
    });
    if (!r.ok) throw new ProviderError(`${r.status}: ${await r.text()}`);
    await readSSE(r, (j) => {
      if (j.type === 'content_block_delta' && j.delta?.type === 'text_delta') onText(j.delta.text);
      else if (j.type === 'error') throw new ProviderError(j.error?.message || 'stream error');
    });
  } else {
    const headers = { 'content-type': 'application/json' };
    if (provider.apiKey) headers.authorization = 'Bearer ' + provider.apiKey;
    const r = await fetch(base + '/chat/completions', {
      method: 'POST', signal, headers,
      body: JSON.stringify({ model: provider.model, stream: true, messages: [{ role: 'system', content: system }, ...messages] }),
    });
    if (!r.ok) throw new ProviderError(`${r.status}: ${await r.text()}`);
    await readSSE(r, (j) => {
      if (j.error) throw new ProviderError(j.error.message || JSON.stringify(j.error));
      const t = j.choices?.[0]?.delta?.content;
      if (t) onText(t);
    });
  }
}

// ---------------------------------------------------------------- chat
let activeConvId = null, draft = null, streaming = null;

function buildContext(type, sel) {
  const ctx = {
    type, chapter: currentChapter(), page: currentPage(), totalPages: locationsReady ? book.locations.total : null,
    percent: currentPercent(), cfi: currentLoc?.start.cfi,
  };
  if (type !== 'general') ctx.pageText = currentPageText().slice(0, 15000);
  if (type === 'highlight') Object.assign(ctx, { text: sel.text.slice(0, 8000), cfiRange: sel.cfiRange });
  return ctx;
}

function newDraft(type, sel) {
  draft = {
    id: uid(), bookId: currentBookId, title: '', context: buildContext(type, sel),
    providerId: getProvider()?.id || null, messages: [], createdAt: Date.now(), updatedAt: Date.now(), deleted: false,
  };
  activeConvId = draft.id;
  openChatPanel();
  renderChat();
  $('#chat-input').focus();
}

const activeConv = () => (draft && draft.id === activeConvId ? draft : S.conversations[activeConvId]);

function systemPrompt(conv) {
  const m = S.books[conv.bookId] || {};
  const c = conv.context || {};
  const where = [c.chapter && `chapter "${c.chapter}"`, c.page && `page ${c.page}${c.totalPages ? ' of ' + c.totalPages : ''}`, c.percent != null && `${pctStr(c.percent)} through`].filter(Boolean).join(', ');
  let s = `You are a knowledgeable reading companion. The user is reading "${m.title || 'a book'}"${m.author ? ' by ' + m.author : ''}.`;
  if (where) s += ` When this conversation started they were at ${where}.`;
  s += '\nAnswer directly and concisely, using markdown where it helps. Draw on general knowledge of the subject as well as the text. Do not reveal plot or content beyond their current position unless they ask for it.';
  if (c.type === 'general') s += '\nThis is a general conversation about the book and its subject.';
  if (c.type === 'highlight') s += `\n\nThe user highlighted this passage and their questions are about it:\n<highlight>\n${c.text}\n</highlight>`;
  if (c.pageText) s += `\n\nText of the page they were reading${c.type === 'highlight' ? ' (surrounding the highlight)' : ''}:\n<page>\n${c.pageText}\n</page>`;
  return s;
}

function apiMessages(conv) {
  const out = [];
  for (const m of conv.messages) {
    if (m.error || !m.content) continue;
    const last = out[out.length - 1];
    if (last && last.role === m.role) last.content += '\n\n' + m.content;
    else out.push({ role: m.role, content: m.content });
  }
  while (out.length && out[out.length - 1].role === 'assistant') out.pop();
  return out;
}

async function send(text) {
  if (streaming) return;
  let conv = activeConv();
  if (!conv) { newDraft('general'); conv = draft; }
  if (conv === draft) {
    if (conv.context.type === 'page' && rendition) conv.context = buildContext('page'); // capture the page as of the first question
    S.conversations[conv.id] = conv;
    draft = null;
    if (conv.context.type === 'highlight') refreshAnnotations();
  }
  conv.messages.push({ id: uid(), role: 'user', content: text, ts: Date.now(), at: currentLoc ? { cfi: currentLoc.start.cfi, page: currentPage(), chapter: currentChapter() } : null });
  if (!conv.title) conv.title = text.slice(0, 90);
  conv.updatedAt = Date.now();
  markDirty('conversations', conv.id);
  await generate(conv);
}

async function generate(conv) {
  const provider = getProvider(conv.providerId);
  if (!provider) { renderThread(); toast('Add an AI provider in Settings first', 'Open', openSettings); return; }
  const asst = { id: uid(), role: 'assistant', content: '', ts: Date.now() + 1, model: provider.model, provider: provider.name };
  conv.messages.push(asst);
  renderThread();
  streaming = new AbortController();
  $('#chat-send').textContent = 'Stop';
  let pending = false;
  try {
    await streamChat(provider, systemPrompt(conv), apiMessages(conv), (t) => {
      asst.content += t;
      if (!pending) { pending = true; requestAnimationFrame(() => { pending = false; updateBubble(asst, true); }); }
    }, streaming.signal);
  } catch (e) {
    if (e.name !== 'AbortError') asst.error = e instanceof TypeError ? `Network error reaching ${provider.name} (${e.message}). Check your connection, the base URL, or CORS for local servers.` : e.message;
  } finally {
    streaming = null;
    $('#chat-send').textContent = 'Send';
    conv.updatedAt = Date.now();
    markDirty('conversations', conv.id);
    renderThread();
  }
}

function retry(conv) {
  const last = conv.messages[conv.messages.length - 1];
  if (last?.role === 'assistant') conv.messages.pop();
  generate(conv);
}

// minimal, safe markdown
function md(src) {
  const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const blocks = [];
  src = src.replace(/```[^\n]*\n?([\s\S]*?)(```|$)/g, (_, code) => { blocks.push(`<pre><code>${esc(code)}</code></pre>`); return `\u0000${blocks.length - 1}\u0000`; });
  const inline = (s) => esc(s)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*\s][^*]*)\*/g, '$1<em>$2</em>')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
  const out = [];
  let list = null, para = [];
  const flushPara = () => { if (para.length) { out.push(`<p>${para.map(inline).join('<br>')}</p>`); para = []; } };
  const flushList = () => { if (list) { out.push(`<${list.tag}>${list.items.map((i) => `<li>${inline(i)}</li>`).join('')}</${list.tag}>`); list = null; } };
  for (const line of src.split('\n')) {
    let m;
    if (/^\u0000\d+\u0000$/.test(line.trim())) { flushPara(); flushList(); out.push(blocks[+line.trim().slice(1, -1)]); }
    else if ((m = line.match(/^(#{1,4})\s+(.*)/))) { flushPara(); flushList(); out.push(`<h${m[1].length + 1}>${inline(m[2])}</h${m[1].length + 1}>`); }
    else if ((m = line.match(/^\s*[-*+]\s+(.*)/))) { flushPara(); if (list?.tag !== 'ul') { flushList(); list = { tag: 'ul', items: [] }; } list.items.push(m[1]); }
    else if ((m = line.match(/^\s*\d+[.)]\s+(.*)/))) { flushPara(); if (list?.tag !== 'ol') { flushList(); list = { tag: 'ol', items: [] }; } list.items.push(m[1]); }
    else if ((m = line.match(/^>\s?(.*)/))) { flushPara(); flushList(); out.push(`<blockquote>${inline(m[1])}</blockquote>`); }
    else if (!line.trim()) { flushPara(); flushList(); }
    else { flushList(); para.push(line); }
  }
  flushPara(); flushList();
  return out.join('').replace(/\u0000(\d+)\u0000/g, (_, i) => blocks[+i]);
}

function openChatPanel() {
  $('#chat-panel').hidden = false;
}
function closeChatPanel() {
  $('#chat-panel').hidden = true;
}
function openThread(id) { activeConvId = id; if (draft && draft.id !== id) draft = null; openChatPanel(); renderChat(); }
function showList() { activeConvId = null; draft = null; renderChat(); }

function renderChat() {
  renderProviderSelect();
  const conv = activeConv();
  $('#chat-list-view').hidden = !!conv;
  $('#chat-thread-view').hidden = !conv;
  $('#chat-back').hidden = !conv;
  $('#chat-heading').textContent = conv ? (conv.title || 'New chat') : 'Chats';
  if (conv) renderThread(); else renderChatList();
}

function ctxBadges(c) {
  const ctx = c.context || {};
  const loc = ctx.page ? `p. ${ctx.page}` : ctx.percent != null ? pctStr(ctx.percent) : '';
  return [
    el('span', { class: 'badge' + (ctx.type === 'highlight' ? ' highlight' : '') }, { general: 'General', page: 'Page', highlight: 'Highlight' }[ctx.type] || ctx.type),
    loc && el('span', { class: 'badge' }, loc),
    ctx.chapter && el('span', { class: 'badge' }, ctx.chapter.slice(0, 40)),
  ];
}

function renderChatList() {
  const ul = $('#chat-list');
  const convs = Object.values(S.conversations).filter((c) => c.bookId === currentBookId && !c.deleted).sort((a, b) => b.updatedAt - a.updatedAt);
  ul.replaceChildren(...(convs.length ? convs.map((c) => el('li', { onclick: () => openThread(c.id) },
    el('div', { class: 'ttl truncate' }, c.title || 'Untitled'),
    el('div', {}, ctxBadges(c)),
    c.context?.type === 'highlight' && el('div', { class: 'sub truncate' }, '“' + c.context.text + '”'),
    el('div', { class: 'sub' }, `${fmtDate(c.updatedAt)} · ${c.messages.filter((m) => m.role === 'user').length} questions`),
    el('button', {
      class: 'ghost small del', title: 'Delete chat',
      onclick: (e) => { e.stopPropagation(); if (confirm('Delete this chat?')) { Object.assign(c, { deleted: true, updatedAt: Date.now() }); markDirty('conversations', c.id); refreshAnnotations(); renderChatList(); } },
    }, '✕'))) : [el('li', { class: 'sub' }, 'No chats for this book yet.')]));
}

function renderThread() {
  const conv = activeConv();
  if (!conv) return;
  const ctx = conv.context || {};
  const box = $('#chat-context');
  box.replaceChildren();
  const line = el('div', { class: 'ctx-line' }, ...ctxBadges(conv));
  if (ctx.cfi) line.append(el('a', { onclick: () => jumpTo(ctx.cfiRange || ctx.cfi) }, 'Go to location'));
  box.append(line);
  if (!conv.messages.length && ctx.type !== 'highlight') {
    box.append(el('div', { class: 'ctx-line' }, 'Context:', el('span', { class: 'seg' },
      ...['general', 'page'].map((t) => el('button', {
        type: 'button', class: ctx.type === t ? 'on' : '',
        onclick: () => { conv.context = buildContext(t); renderThread(); },
      }, t === 'general' ? 'General' : 'This page')))));
  }
  if (ctx.type === 'highlight') box.append(el('blockquote', { title: 'Go to highlight', onclick: () => jumpTo(ctx.cfiRange) }, ctx.text));
  if (ctx.type === 'page' && ctx.pageText) box.append(el('div', { class: 'truncate', title: ctx.pageText.slice(0, 600) }, 'Page text included: “' + ctx.pageText.slice(0, 120) + '…”'));

  const msgs = $('#chat-messages');
  msgs.replaceChildren(...conv.messages.map((m) => bubble(m, conv)));
  msgs.scrollTop = msgs.scrollHeight;
}

function bubble(m, conv) {
  const isLast = conv.messages[conv.messages.length - 1] === m;
  const div = el('div', { class: `msg ${m.role}${m.error ? ' error' : ''}`, 'data-id': m.id });
  if (m.role === 'user') {
    div.append(el('div', {}, m.content));
    if (m.at) div.append(el('div', { class: 'meta' }, el('a', { onclick: () => jumpTo(m.at.cfi) }, `asked at ${m.at.page ? 'p. ' + m.at.page : m.at.chapter || 'this location'}`)));
  } else {
    const body = el('div', { class: 'body' + (streaming && isLast && !m.error ? ' typing' : ''), html: md(m.content || '') });
    div.append(body);
    if (m.error) div.append(el('div', {}, 'Error: ' + m.error));
    div.append(el('div', { class: 'meta' }, [m.provider, m.model].filter(Boolean).join(' · '),
      (m.error || (isLast && !streaming)) ? el('span', {}, ' · ', el('a', { onclick: () => retry(conv) }, 'retry')) : null));
  }
  return div;
}

function updateBubble(m, typing) {
  const node = document.querySelector(`.msg[data-id="${m.id}"] .body`);
  if (!node) return;
  node.innerHTML = md(m.content);
  node.classList.toggle('typing', typing);
  const msgs = $('#chat-messages');
  if (msgs.scrollHeight - msgs.scrollTop - msgs.clientHeight < 120) msgs.scrollTop = msgs.scrollHeight;
}

function renderProviderSelect() {
  const sel = $('#chat-provider');
  const conv = activeConv();
  const cur = getProvider(conv?.providerId);
  sel.replaceChildren(...(S.settings.providers.length
    ? S.settings.providers.map((p) => el('option', { value: p.id, selected: p.id === cur?.id }, `${p.name} · ${p.model}`))
    : [el('option', { value: '' }, 'No provider — add in Settings')]));
}

// ---------------------------------------------------------------- settings
let editProviders = [];
function openSettings() {
  editProviders = structuredClone(S.settings.providers);
  $('#pref-theme').value = S.prefs.theme;
  $('#pref-size').value = S.prefs.fontSize;
  $('#pref-size-val').textContent = S.prefs.fontSize + '%';
  $('#pref-columns').value = S.prefs.columns || 'auto';
  const swOk = 'serviceWorker' in navigator;
  const offline = navigator.serviceWorker?.controller ? 'Offline: ready. The reader opens without the server.'
    : !swOk ? (/iPad|iPhone/.test(navigator.userAgent) || (navigator.maxTouchPoints > 1 && /Mac/.test(navigator.userAgent))
      ? 'Offline: not supported in this browser. On iPad/iPhone use Safari (ideally Share → Add to Home Screen) to open the reader without the server.'
      : 'Offline: unavailable. The page must be served over HTTPS (e.g. tailscale serve) or from localhost.')
    : swError ? `Offline: this browser refused it (${swError}). On iPad/iPhone use Safari for offline reading.`
    : 'Offline: not active yet. Reload once while connected.';
  $('#device-info').replaceChildren(
    el('div', {}, `Reader version ${APP_VERSION}${BUILD ? ` (build ${BUILD})` : ''} · ${deviceName()} · device ${S.deviceId}`),
    el('div', {}, offline + ' Books, positions and chats are stored on this device either way.'),
    el('button', { type: 'button', class: 'btn small', style: 'margin-top:6px', onclick: hardReload, title: 'Clears the saved copy of the app and loads it fresh from the server. Your books and data stay.' }, 'Reload app from server'));
  renderProviders();
  $('#dlg-settings').showModal();
}
function renderProviders() {
  const box = $('#provider-list');
  if (!editProviders.length) { box.replaceChildren(el('p', { class: 'hint' }, 'No providers yet. Add one below.')); return; }
  const defId = editProviders.some((p) => p.id === S.settings.defaultProviderId) ? S.settings.defaultProviderId : editProviders[0].id;
  box.replaceChildren(...editProviders.map((p) => {
    const field = (label, key, type = 'text', cls = '') => el('label', { class: cls }, label,
      el('input', { type, value: p[key] || '', autocomplete: 'off', spellcheck: 'false', oninput: (e) => { p[key] = e.target.value.trim(); } }));
    return el('div', { class: 'provider' },
      field('Name', 'name'),
      el('label', {}, 'API format', el('select', { onchange: (e) => { p.type = e.target.value; } },
        el('option', { value: 'anthropic', selected: p.type === 'anthropic' }, 'Anthropic Messages'),
        el('option', { value: 'openai', selected: p.type === 'openai' }, 'OpenAI-compatible'))),
      field('Base URL', 'baseUrl', 'url', 'full'),
      field('Model', 'model'),
      field('API key', 'apiKey', 'password'),
      el('div', { class: 'actions' },
        el('label', {}, el('input', { type: 'radio', name: 'default-provider', checked: p.id === defId, onchange: () => { S._pendingDefault = p.id; } }), 'Default'),
        el('button', { type: 'button', class: 'ghost small', onclick: () => { editProviders = editProviders.filter((x) => x !== p); renderProviders(); } }, 'Remove')));
  }));
}
function saveSettings() {
  const def = S._pendingDefault && editProviders.some((p) => p.id === S._pendingDefault) ? S._pendingDefault
    : editProviders.some((p) => p.id === S.settings.defaultProviderId) ? S.settings.defaultProviderId : editProviders[0]?.id || null;
  delete S._pendingDefault;
  S.settings = { providers: editProviders, defaultProviderId: def, updatedAt: Date.now() };
  markDirty('settings');
  const theme = $('#pref-theme').value, size = +$('#pref-size').value, columns = $('#pref-columns').value;
  if (theme !== S.prefs.theme || size !== S.prefs.fontSize || columns !== (S.prefs.columns || 'auto')) {
    S.prefs = { theme, fontSize: size, columns, updatedAt: Date.now() }; // this device only
    saveLocal();
    applyPrefs();
  }
  renderProviderSelect();
  $('#dlg-settings').close();
  sync();
}

// ---------------------------------------------------------------- UI chrome
let toastT;
// ms: auto-hide delay; 0 = stays until replaced or dismissed
function toast(msg, action, fn, ms) {
  const t = $('#toast');
  t.replaceChildren(el('span', {}, msg));
  if (action) t.append(el('button', { onclick: () => { t.hidden = true; fn(); } }, action));
  if (ms === 0) t.append(el('button', { title: 'Dismiss', onclick: () => { t.hidden = true; } }, '✕'));
  t.hidden = false;
  clearTimeout(toastT);
  if (ms !== 0) toastT = setTimeout(() => (t.hidden = true), ms || (action ? 9000 : 3500));
}
function openDrawer(id) { closeDrawers(); $('#' + id).hidden = false; $('#scrim').hidden = false; }
function closeDrawers() { $$('.drawer').forEach((d) => (d.hidden = true)); $('#scrim').hidden = true; }

function wireUI() {
  $('#btn-library').onclick = () => { renderLibrary(); openDrawer('drawer-library'); };
  $('#btn-toc').onclick = () => { openDrawer('drawer-toc'); $('#toc-list a.current')?.scrollIntoView({ block: 'center' }); };
  $('#scrim').onclick = closeDrawers;
  $('#btn-settings').onclick = openSettings;
  $('#btn-chat').onclick = () => ($('#chat-panel').hidden ? (openChatPanel(), renderChat()) : closeChatPanel());
  $('#chat-close').onclick = closeChatPanel;
  $('#chat-back').onclick = showList;
  $('#new-general').onclick = () => newDraft('general');
  $('#new-page').onclick = () => newDraft('page');
  $('#prev').onclick = prev;
  $('#next').onclick = next;
  $('#btn-back').onclick = goBack;
  $('#btn-furthest').onclick = () => { const p = S.progress[currentBookId]; if (p?.furthestCfi) jumpTo(p.furthestCfi); };
  $('#scrubber').onchange = (e) => { if (locationsReady) jumpTo(book.locations.cfiFromPercentage(e.target.value / 1000)); };
  $('#scrubber').oninput = (e) => { if (locationsReady) $('#page-info').textContent = `→ ${pctStr(e.target.value / 1000)}`; };

  $('#ask-selection').onclick = () => {
    if (!pendingSelection) return;
    const sel = pendingSelection;
    hideSelectionPop();
    rendition.getContents().forEach((c) => c.window.getSelection()?.removeAllRanges());
    newDraft('highlight', sel);
  };

  $('#chat-provider').onchange = (e) => {
    const conv = activeConv();
    if (conv) { conv.providerId = e.target.value; conv.updatedAt = Date.now(); if (conv !== draft) markDirty('conversations', conv.id); }
  };
  $('#chat-form').onsubmit = (e) => {
    e.preventDefault();
    if (streaming) { streaming.abort(); return; }
    const t = $('#chat-input').value.trim();
    if (!t) return;
    $('#chat-input').value = '';
    autoGrow();
    send(t);
  };
  const autoGrow = () => { const t = $('#chat-input'); t.style.height = 'auto'; t.style.height = Math.min(180, t.scrollHeight) + 'px'; };
  $('#chat-input').addEventListener('input', autoGrow);
  $('#chat-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); $('#chat-form').requestSubmit(); }
  });

  $('#provider-add').onclick = () => {
    const pr = PRESETS[$('#provider-preset').value];
    editProviders.push({ id: uid(), apiKey: '', ...pr });
    renderProviders();
  };
  $('#settings-save').onclick = saveSettings;
  $('#pref-size').oninput = (e) => { $('#pref-size-val').textContent = e.target.value + '%'; };

  for (const input of $$('.file-input')) input.onchange = (e) => { addFiles([...e.target.files]); e.target.value = ''; };

  // drag & drop
  let dragDepth = 0;
  window.addEventListener('dragenter', (e) => { if (e.dataTransfer?.types.includes('Files')) { dragDepth++; $('#drop-overlay').hidden = false; } });
  window.addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; $('#drop-overlay').hidden = true; } });
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', (e) => { e.preventDefault(); dragDepth = 0; $('#drop-overlay').hidden = true; addFiles([...e.dataTransfer.files]); });

  document.addEventListener('keydown', (e) => {
    if (e.target.closest('textarea, input, select, dialog')) return;
    if (e.key === 'Escape') { closeDrawers(); hideSelectionPop(); return; }
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.key === 'l') $('#btn-library').click();
    else if (e.key === 't' && book) $('#btn-toc').click();
    else if (e.key === 'c' && book) $('#btn-chat').click();
    else onKey(e);
  });

  // keep the reader sized correctly when the chat panel or window changes
  let lastWrap = '';
  new ResizeObserver(([e]) => {
    const k = Math.round(e.contentRect.width) + 'x' + Math.round(e.contentRect.height);
    if (k === lastWrap) return;
    lastWrap = k;
    if (rendition) requestRelayout();
  }).observe($('#reader-wrap'));

  window.addEventListener('online', () => sync());
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') sync();
    else { idb.set('kv', 'state', S); if (S.dirty.progress.length || S.dirty.lastBook) navigator.sendBeacon?.('/api/sync', new Blob([JSON.stringify({ progress: Object.fromEntries(S.dirty.progress.map((id) => [id, S.progress[id]]).filter((x) => x[1])), lastBook: S.lastBook })], { type: 'application/json' })); }
  });
  setInterval(() => { if (document.visibilityState === 'visible') sync(); }, 30000);
}

// ---------------------------------------------------------------- boot
async function boot() {
  wireUI();
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch((e) => { swError = e?.message || String(e); console.warn('sw', e); });
  await loadLocal();
  outboxKeys = new Set(await idb.keys('outbox'));
  applyPrefs();
  renderProviderSelect();
  // wait briefly for the server so we open at the newest position across devices; fall back to local
  await Promise.race([sync(), new Promise((r) => setTimeout(r, 2500))]);
  const last = S.lastBook?.bookId;
  if (last && S.books[last]) await openBook(last);
  else renderLibrary();
}
boot();
