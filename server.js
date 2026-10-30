// EPUB reader sync server.
// Stores books, reading progress, conversations and settings under DATA_DIR.
// The client is offline-first: it keeps its own copy of everything and syncs here when reachable.

import express from 'express';
import fs from 'fs/promises';
import fss from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const BOOKS_DIR = path.join(DATA_DIR, 'books');
const DB_FILE = path.join(DATA_DIR, 'db.json');
const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '127.0.0.1';

await fs.mkdir(BOOKS_DIR, { recursive: true });

const emptyDb = () => ({
  books: {},          // id -> { id, title, author, filename, size, addedAt }
  deleted: {},        // id -> deletedAt (tombstones so other devices drop the book)
  progress: {},       // bookId -> { cfi, percent, page, chapter, updatedAt, device, furthestCfi, furthestPercent, furthestChapter }
  lastBook: null,     // { bookId, updatedAt }
  conversations: {},  // id -> { id, bookId, title, context, providerId, messages[], createdAt, updatedAt, deleted }
  settings: { providers: [], defaultProviderId: null, updatedAt: 0 },
  prefs: { theme: 'light', fontSize: 100, updatedAt: 0 },
});

let db = emptyDb();
try {
  db = { ...emptyDb(), ...JSON.parse(await fs.readFile(DB_FILE, 'utf8')) };
} catch (e) {
  if (e.code !== 'ENOENT') console.error('Could not read db.json, starting fresh:', e.message);
}

let saveTimer = null;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    try {
      const tmp = DB_FILE + '.tmp';
      await fs.writeFile(tmp, JSON.stringify(db), { mode: 0o600 });
      await fs.rename(tmp, DB_FILE);
    } catch (e) {
      console.error('Save failed:', e);
    }
  }, 200);
}

// ---------- merge rules (mirrored in the client) ----------
const newer = (a, b) => (!a ? b : !b ? a : (b.updatedAt || 0) >= (a.updatedAt || 0) ? b : a);

function mergeProgress(a, b) {
  if (!a) return b;
  if (!b) return a;
  const cur = newer(a, b);
  const far = (b.furthestPercent || 0) > (a.furthestPercent || 0) ? b : a;
  return {
    ...cur,
    furthestCfi: far.furthestCfi,
    furthestPercent: far.furthestPercent,
    furthestChapter: far.furthestChapter,
  };
}

function mergeConv(a, b) {
  if (!a) return b;
  if (!b) return a;
  const base = newer(a, b);
  const msgs = new Map();
  for (const m of [...(a.messages || []), ...(b.messages || [])]) {
    const prev = msgs.get(m.id);
    // prefer the longer version of a message (a stream that finished on another device)
    if (!prev || (m.content || '').length >= (prev.content || '').length) msgs.set(m.id, m);
  }
  return { ...base, messages: [...msgs.values()].sort((x, y) => x.ts - y.ts) };
}

const stateOut = () => ({
  books: Object.values(db.books),
  deleted: db.deleted,
  progress: db.progress,
  lastBook: db.lastBook,
  conversations: Object.values(db.conversations),
  settings: db.settings,
  prefs: db.prefs,
  serverTime: Date.now(),
});

const safeId = (id) => /^[A-Za-z0-9_-]{1,64}$/.test(id);

// ---------- app ----------
const app = express();
app.disable('x-powered-by');

app.get('/api/health', (_req, res) => res.json({ ok: true }));

app.get('/api/state', (_req, res) => res.json(stateOut()));

app.post('/api/sync', express.json({ limit: '50mb' }), (req, res) => {
  const b = req.body || {};
  let changed = false;
  for (const [id, p] of Object.entries(b.progress || {})) {
    if (!p) continue;
    db.progress[id] = mergeProgress(db.progress[id], p);
    changed = true;
  }
  for (const c of b.conversations || []) {
    if (!c?.id) continue;
    db.conversations[c.id] = mergeConv(db.conversations[c.id], c);
    changed = true;
  }
  for (const key of ['lastBook', 'settings', 'prefs']) {
    if (b[key]) {
      db[key] = newer(db[key], b[key]);
      changed = true;
    }
  }
  if (changed) save();
  res.json(stateOut());
});

app.put('/api/books/:id', express.raw({ type: '*/*', limit: '500mb' }), async (req, res) => {
  const { id } = req.params;
  if (!safeId(id)) return res.status(400).json({ error: 'bad id' });
  let meta = {};
  try {
    meta = JSON.parse(decodeURIComponent(req.get('x-meta') || '%7B%7D'));
  } catch {}
  if (!req.body?.length) return res.status(400).json({ error: 'empty body' });
  await fs.writeFile(path.join(BOOKS_DIR, id + '.epub'), req.body);
  console.log(`[books] PUT ${id}: stored ${(req.body.length / 1048576).toFixed(1)} MB`);
  db.books[id] = {
    id,
    title: String(meta.title || 'Untitled').slice(0, 500),
    author: String(meta.author || '').slice(0, 300),
    filename: String(meta.filename || '').slice(0, 300),
    size: req.body.length,
    addedAt: Number(meta.addedAt) || Date.now(),
  };
  delete db.deleted[id];
  save();
  res.json(db.books[id]);
});

app.get('/api/books/:id/file', (req, res) => {
  const { id } = req.params;
  if (!safeId(id)) return res.status(400).end();
  const file = path.join(BOOKS_DIR, id + '.epub');
  if (!fss.existsSync(file)) {
    console.warn(`[books] GET ${id}: 404, no file on server`);
    return res.status(404).end();
  }
  const t0 = Date.now();
  res.type('application/epub+zip').sendFile(file, (err) => {
    if (err) console.warn(`[books] GET ${id}: failed after ${Date.now() - t0} ms: ${err.message}`);
    else console.log(`[books] GET ${id}: sent ${db.books[id]?.title || ''} in ${Date.now() - t0} ms`);
  });
});

app.delete('/api/books/:id', async (req, res) => {
  const { id } = req.params;
  if (!safeId(id)) return res.status(400).end();
  await fs.rm(path.join(BOOKS_DIR, id + '.epub'), { force: true });
  delete db.books[id];
  delete db.progress[id];
  db.deleted[id] = Date.now();
  if (db.lastBook?.bookId === id) db.lastBook = { bookId: null, updatedAt: Date.now() };
  for (const c of Object.values(db.conversations)) {
    if (c.bookId === id) Object.assign(c, { deleted: true, updatedAt: Date.now() });
  }
  save();
  res.json({ ok: true });
});

// Vendor libraries served locally so the app works fully offline.
app.get('/lib/epub.min.js', (_req, res) => res.sendFile(path.join(__dirname, 'node_modules/epubjs/dist/epub.min.js')));
app.get('/lib/jszip.min.js', (_req, res) => res.sendFile(path.join(__dirname, 'node_modules/jszip/dist/jszip.min.js')));

app.use(express.static(path.join(__dirname, 'public'), {
  setHeaders: (res, p) => {
    if (p.endsWith('sw.js')) res.setHeader('Cache-Control', 'no-cache');
  },
}));

app.listen(PORT, HOST, () => {
  console.log(`EPUB reader running at http://${HOST}:${PORT}`);
  console.log(`Data directory: ${DATA_DIR}`);
});
