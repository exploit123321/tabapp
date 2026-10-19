// IndexedDB persistence for documents.
const DB_NAME = 'framepad';
const STORE = 'docs';
let dbPromise;

function db() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: 'id' });
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return dbPromise;
}

function tx(mode, fn) {
  return db().then(
    (d) =>
      new Promise((resolve, reject) => {
        const t = d.transaction(STORE, mode);
        const req = fn(t.objectStore(STORE));
        t.oncomplete = () => resolve(req && req.result);
        t.onerror = () => reject(t.error);
      })
  );
}

export const saveDoc = (doc) => tx('readwrite', (s) => s.put(doc));
export const loadDoc = (id) => tx('readonly', (s) => s.get(id));
export const deleteDoc = (id) => tx('readwrite', (s) => s.delete(id));
export const listDocs = () => tx('readonly', (s) => s.getAll());
