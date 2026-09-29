// The only module that knows where Aula's data lives.
// Today: IndexedDB in this browser. Later: swap these functions for fetch() calls
// to a FastAPI backend and nothing else in the app has to change.

const DB_NAME = 'aula';
const DB_VERSION = 1;
export const COLLECTIONS = ['term', 'courses', 'modules', 'assignments', 'documents'];
const FILES = 'files';
const META = 'meta';

let dbPromise = null;
function open() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      for (const name of [...COLLECTIONS, FILES]) {
        if (!db.objectStoreNames.contains(name)) db.createObjectStore(name, { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains(META)) db.createObjectStore(META, { keyPath: 'key' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function tx(stores, mode, fn) {
  return open().then(db => new Promise((resolve, reject) => {
    const t = db.transaction(stores, mode);
    let result;
    Promise.resolve(fn(t)).then(r => { result = r; }, reject);
    t.oncomplete = () => resolve(result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error || new Error('Transaction aborted'));
  }));
}
const reqP = r => new Promise((resolve, reject) => { r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });

/* ---------- change notification (this tab + other tabs) ---------- */
const listeners = new Map(); // collection -> Set<fn>
let channel = null;
try { channel = new BroadcastChannel('aula'); channel.onmessage = e => emit(e.data, false); } catch (_) { channel = null; }

async function emit(coll, broadcast = true) {
  const subs = listeners.get(coll);
  if (subs && subs.size) {
    const rows = await list(coll);
    subs.forEach(fn => fn(rows));
  }
  if (broadcast && channel) channel.postMessage(coll);
}

/* ---------- records ---------- */
export function list(coll) {
  return tx([coll], 'readonly', t => reqP(t.objectStore(coll).getAll()));
}

export function subscribe(coll, fn) {
  if (!listeners.has(coll)) listeners.set(coll, new Set());
  listeners.get(coll).add(fn);
  list(coll).then(fn, () => fn([]));
  return () => listeners.get(coll).delete(fn);
}

export async function set(coll, id, data) {
  await tx([coll], 'readwrite', t => { t.objectStore(coll).put({ ...data, id }); });
  emit(coll);
}

export async function update(coll, id, patch) {
  await tx([coll], 'readwrite', async t => {
    const s = t.objectStore(coll);
    const cur = await reqP(s.get(id));
    if (!cur) throw new Error('No ' + coll + ' record ' + id);
    s.put({ ...cur, ...patch, id });
  });
  emit(coll);
}

export async function remove(coll, id) {
  await tx([coll], 'readwrite', t => { t.objectStore(coll).delete(id); });
  emit(coll);
}

export const newId = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));

/* ---------- files ---------- */
const urlCache = new Map();
export const files = {
  async put(file) {
    const id = newId();
    const rec = { id, blob: file, name: file.name, type: file.type || 'application/octet-stream', size: file.size, createdAt: new Date().toISOString() };
    await tx([FILES], 'readwrite', t => { t.objectStore(FILES).put(rec); });
    return { assetId: id, fileName: file.name, fileSize: file.size, fileType: rec.type };
  },
  async url(id) {
    if (urlCache.has(id)) return urlCache.get(id);
    const rec = await tx([FILES], 'readonly', t => reqP(t.objectStore(FILES).get(id)));
    if (!rec) return null;
    const u = URL.createObjectURL(rec.blob);
    urlCache.set(id, u);
    return u;
  },
  async remove(id) {
    await tx([FILES], 'readwrite', t => { t.objectStore(FILES).delete(id); });
    if (urlCache.has(id)) { URL.revokeObjectURL(urlCache.get(id)); urlCache.delete(id); }
  },
};

/* ---------- import, export, first run ---------- */
export async function importData(data, { replace = false } = {}) {
  if (!data || data.app !== 'aula') throw new Error('That file is not an Aula backup.');
  await tx([...COLLECTIONS, META], 'readwrite', t => {
    for (const coll of COLLECTIONS) {
      const s = t.objectStore(coll);
      if (replace) s.clear();
      for (const row of data[coll] || []) if (row && row.id) s.put(row);
    }
    t.objectStore(META).put({ key: 'seeded', at: new Date().toISOString() });
  });
  COLLECTIONS.forEach(c => emit(c));
}

export async function exportData() {
  const out = { app: 'aula', schema: 1, exportedAt: new Date().toISOString() };
  for (const coll of COLLECTIONS) out[coll] = await list(coll);
  return out;
}

export async function seedIfEmpty(url) {
  const seeded = await tx([META], 'readonly', t => reqP(t.objectStore(META).get('seeded')));
  if (seeded) return false;
  const res = await fetch(url);
  if (!res.ok) throw new Error('Could not load ' + url);
  await importData(await res.json());
  return true;
}
