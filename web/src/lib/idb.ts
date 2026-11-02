/**
 * A very small promise wrapper over IndexedDB.
 *
 * IndexedDB rather than localStorage because the outbox has to survive the tab
 * being killed mid-send, and because the service worker needs to read the same
 * data from a context that has no localStorage at all. No library: the four
 * operations below are all this app needs.
 */

export const DB_NAME = 'field-reports';
export const DB_VERSION = 1;

export const STORE = {
  list: 'list',
  details: 'details',
  outbox: 'outbox',
  meta: 'meta',
} as const;

export type StoreName = (typeof STORE)[keyof typeof STORE];

let dbPromise: Promise<IDBDatabase> | null = null;

function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('IndexedDB request failed'));
  });
}

export function openDb(): Promise<IDBDatabase> {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        // `list` holds one row (the cached site list); `details` one row per site.
        if (!db.objectStoreNames.contains(STORE.list)) db.createObjectStore(STORE.list);
        if (!db.objectStoreNames.contains(STORE.details)) {
          db.createObjectStore(STORE.details, { keyPath: 'id' });
        }
        if (!db.objectStoreNames.contains(STORE.outbox)) {
          const outbox = db.createObjectStore(STORE.outbox, { keyPath: 'id' });
          outbox.createIndex('by_created', 'createdAt');
        }
        if (!db.objectStoreNames.contains(STORE.meta)) db.createObjectStore(STORE.meta);
      };
      req.onsuccess = () => {
        const db = req.result;
        // Another tab running a newer build needs us to let go of the handle.
        db.onversionchange = () => {
          db.close();
          dbPromise = null;
        };
        resolve(db);
      };
      req.onerror = () => reject(req.error ?? new Error('Could not open IndexedDB'));
      req.onblocked = () => reject(new Error('IndexedDB upgrade blocked by another tab'));
    });
  }
  return dbPromise;
}

async function withStore<T>(
  name: StoreName,
  mode: IDBTransactionMode,
  fn: (store: IDBObjectStore) => IDBRequest<T> | Promise<T>,
): Promise<T> {
  const db = await openDb();
  const transaction = db.transaction(name, mode);
  const result = fn(transaction.objectStore(name));
  const value = result instanceof IDBRequest ? await request(result) : await result;
  await new Promise<void>((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = transaction.onerror = () =>
      reject(transaction.error ?? new Error('IndexedDB transaction failed'));
  });
  return value;
}

export function idbGet<T>(store: StoreName, key: IDBValidKey): Promise<T | undefined> {
  return withStore(store, 'readonly', (s) => s.get(key) as IDBRequest<T | undefined>);
}

export function idbGetAll<T>(store: StoreName): Promise<T[]> {
  return withStore(store, 'readonly', (s) => s.getAll() as IDBRequest<T[]>);
}

/** `key` is omitted for stores declared with a keyPath. */
export function idbPut(store: StoreName, value: unknown, key?: IDBValidKey): Promise<IDBValidKey> {
  return withStore(store, 'readwrite', (s) => s.put(value, key));
}

export function idbDelete(store: StoreName, key: IDBValidKey): Promise<undefined> {
  return withStore(store, 'readwrite', (s) => s.delete(key));
}

export function idbClear(store: StoreName): Promise<undefined> {
  return withStore(store, 'readwrite', (s) => s.clear());
}

/** Read, modify and write one record inside a single transaction. */
export async function idbUpdate<T>(
  store: StoreName,
  key: IDBValidKey,
  mutate: (current: T | undefined) => T | undefined,
): Promise<T | undefined> {
  const db = await openDb();
  const transaction = db.transaction(store, 'readwrite');
  const objectStore = transaction.objectStore(store);
  const current = await request<T | undefined>(objectStore.get(key) as IDBRequest<T | undefined>);
  const next = mutate(current);
  if (next === undefined) {
    await request(objectStore.delete(key));
  } else if (objectStore.keyPath) {
    await request(objectStore.put(next));
  } else {
    await request(objectStore.put(next, key));
  }
  await new Promise<void>((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = transaction.onerror = () =>
      reject(transaction.error ?? new Error('IndexedDB transaction failed'));
  });
  return next;
}

/** Test helper: forget the cached connection so a fresh database can be opened. */
export function resetDbHandleForTests(): void {
  dbPromise = null;
}
