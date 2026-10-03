import type { ClientRecord, PersistedEnvelope, SyncMeta } from '../types';

const DB_NAME = 'sologsb-1019-coding';
const DB_VERSION = 2;
const LEGACY_STORE = 'snapshots';
const LEGACY_KEY = 'current';
const META_STORE = 'sync-meta';
const CLIENTS_STORE = 'clients';
const META_KEY = 'shared';

const openDatabase = (): Promise<IDBDatabase> =>
  new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(LEGACY_STORE)) db.createObjectStore(LEGACY_STORE);
      if (!db.objectStoreNames.contains(META_STORE)) db.createObjectStore(META_STORE);
      if (!db.objectStoreNames.contains(CLIENTS_STORE)) db.createObjectStore(CLIENTS_STORE);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });

/** 旧版整份快照，仅用于首次迁移 */
export async function readLegacyEnvelope(): Promise<PersistedEnvelope | null> {
  if (!('indexedDB' in window)) return null;
  const db = await openDatabase();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(LEGACY_STORE, 'readonly');
      const request = tx.objectStore(LEGACY_STORE).get(LEGACY_KEY);
      request.onsuccess = () => resolve((request.result as PersistedEnvelope | undefined) ?? null);
      request.onerror = () => reject(request.error);
    });
  } finally {
    db.close();
  }
}

export async function readMeta(): Promise<SyncMeta | null> {
  if (!('indexedDB' in window)) return null;
  const db = await openDatabase();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(META_STORE, 'readonly');
      const request = tx.objectStore(META_STORE).get(META_KEY);
      request.onsuccess = () => resolve((request.result as SyncMeta | undefined) ?? null);
      request.onerror = () => reject(request.error);
    });
  } finally {
    db.close();
  }
}

export async function writeMeta(meta: SyncMeta): Promise<void> {
  if (!('indexedDB' in window)) return;
  const db = await openDatabase();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(META_STORE, 'readwrite');
      tx.objectStore(META_STORE).put(meta, META_KEY);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}

/** 仅当当前 baseRev 与 expectedRev 一致时写入，防止两个标签页互相覆盖元数据 */
export async function compareSetMeta(expectedRev: number, meta: SyncMeta): Promise<boolean> {
  if (!('indexedDB' in window)) return true;
  const db = await openDatabase();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(META_STORE, 'readwrite');
      const store = tx.objectStore(META_STORE);
      const current = store.get(META_KEY);
      current.onsuccess = () => {
        const existing = current.result as SyncMeta | undefined;
        if (existing && existing.baseRev !== expectedRev) {
          tx.abort();
          resolve(false);
          return;
        }
        store.put(meta, META_KEY);
      };
      current.onerror = () => reject(current.error);
      tx.oncomplete = () => resolve(true);
      tx.onabort = () => resolve(false);
    });
  } finally {
    db.close();
  }
}

export async function readAllClients(): Promise<ClientRecord[]> {
  if (!('indexedDB' in window)) return [];
  const db = await openDatabase();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(CLIENTS_STORE, 'readonly');
      const request = tx.objectStore(CLIENTS_STORE).getAll();
      request.onsuccess = () => resolve((request.result as ClientRecord[] | undefined) ?? []);
      request.onerror = () => reject(request.error);
    });
  } finally {
    db.close();
  }
}

export async function readClient(clientId: string): Promise<ClientRecord | null> {
  if (!('indexedDB' in window)) return null;
  const db = await openDatabase();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(CLIENTS_STORE, 'readonly');
      const request = tx.objectStore(CLIENTS_STORE).get(clientId);
      request.onsuccess = () => resolve((request.result as ClientRecord | undefined) ?? null);
      request.onerror = () => reject(request.error);
    });
  } finally {
    db.close();
  }
}

export async function putClient(record: ClientRecord): Promise<void> {
  if (!('indexedDB' in window)) return;
  const db = await openDatabase();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(CLIENTS_STORE, 'readwrite');
      tx.objectStore(CLIENTS_STORE).put(record, record.clientId);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}

export async function deleteClient(clientId: string): Promise<void> {
  if (!('indexedDB' in window)) return;
  const db = await openDatabase();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(CLIENTS_STORE, 'readwrite');
      tx.objectStore(CLIENTS_STORE).delete(clientId);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}
