import type { PersistedEnvelope, ReplicaDoc, SyncBundle, SyncMeta, CodingState } from '../types';
const DB_NAME = 'sologsb-1019-coding';
const DB_VERSION = 2;
const STORE_NAME = 'snapshots';
const SNAPSHOT_KEY = 'current';
const BASE_KEY = 'base';
const META_KEY = 'meta';
const REPLICA_PREFIX = 'replica:';
const SYNC_KEY_LEGACY = 'sync-bundle-v2';
const LEGACY_STATE_KEY = 'sologsb-1019-state-v1';
const SYNC_FALLBACK_KEY = 'sologsb-1019-sync-v2';

let dbPromise: Promise<IDBDatabase> | null = null;

const openDatabase = (): Promise<IDBDatabase> => {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) db.createObjectStore(STORE_NAME);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => { dbPromise = null; reject(request.error); };
  });
  return dbPromise;
};

export async function readEnvelope(): Promise<PersistedEnvelope | null> {
  if (!('indexedDB' in window)) return null;
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const request = tx.objectStore(STORE_NAME).get(SNAPSHOT_KEY);
    request.onsuccess = () => resolve((request.result as PersistedEnvelope | undefined) ?? null);
    request.onerror = () => reject(request.error);
  });
}

/**
 * 读取同步账本：base、meta、各标签页副本分键存放，
 * 因此任何标签页写入都不会整体覆盖另一个标签页未同步的本地改动。
 */
export async function readSyncBundle(): Promise<SyncBundle | null> {
  if (!('indexedDB' in window)) return readFallbackBundle();
  const db = await openDatabase();
  const entries = await new Promise<[string, unknown][]>((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const collected: [string, unknown][] = [];
    const request = tx.objectStore(STORE_NAME).openCursor();
    request.onsuccess = () => {
      const cursor = request.result;
      if (cursor) { collected.push([cursor.key as string, cursor.value]); cursor.continue(); }
      else resolve(collected);
    };
    request.onerror = () => reject(request.error);
  });

  let base = entries.find(([key]) => key === BASE_KEY)?.[1] as CodingState | undefined;
  let meta = entries.find(([key]) => key === META_KEY)?.[1] as SyncMeta | undefined;
  const replicas = entries
    .filter(([key]) => typeof key === 'string' && key.startsWith(REPLICA_PREFIX))
    .map(([, value]) => value as ReplicaDoc);

  // 迁移：v2 早期版本整包存于一个键
  if ((!base || !meta) && entries.some(([key]) => key === SYNC_KEY_LEGACY)) {
    const legacy = entries.find(([key]) => key === SYNC_KEY_LEGACY)?.[1] as SyncBundle;
    base ??= legacy.base;
    meta ??= legacy.meta;
    if (!replicas.length) replicas.push(...legacy.replicas);
  }

  if (base && meta && replicas.length) return { base, meta, replicas };
  // IDB 已有任一账本键时不回退 localStorage（其整包可能只含单个标签页的副本）
  if (entries.some(([key]) => key === BASE_KEY || key.startsWith(REPLICA_PREFIX))) return null;
  return readFallbackBundle();
}

/**
 * 写入账本。
 * - 本标签页的副本始终只写自己的键（任何时刻都可安全落盘，断网改动不丢）；
 * - base/meta 仅在持锁的合并临界区（includeBase=true）写入，杜绝跨页用旧基线覆盖新基线。
 */
export async function writeSyncBundle(
  bundle: SyncBundle,
  writerId: string,
  includeBase: boolean
): Promise<void> {
  // 兜底：无 IndexedDB 的隐私模式下才用 localStorage 记录本页副本，供重开后认领；
  // 不写整包，避免跨页用单页内容互相覆盖
  try {
    const mine = bundle.replicas.find((replica) => replica.writerId === writerId);
    if (mine && !('indexedDB' in window)) {
      localStorage.setItem(`${SYNC_FALLBACK_KEY}-${writerId}`, JSON.stringify({ base: bundle.base, meta: bundle.meta, replica: mine }));
    }
  } catch { /* 配额或隐私模式忽略 */ }
  if (!('indexedDB' in window)) return;
  const db = await openDatabase();
  const mine = bundle.replicas.find((replica) => replica.writerId === writerId);
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    if (includeBase) {
      store.put(bundle.base, BASE_KEY);
      store.put(bundle.meta, META_KEY);
    }
    if (mine) store.put(mine, `${REPLICA_PREFIX}${writerId}`);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

const readFallbackBundle = (): SyncBundle | null => {
  try {
    // 优先旧版整包键
    const raw = localStorage.getItem(SYNC_FALLBACK_KEY);
    if (raw) return JSON.parse(raw) as SyncBundle;
    // 无 IndexedDB 模式：收集各页按 writer 分键的兜底副本
    const records: Array<{ base: CodingState; meta: SyncMeta; replica: ReplicaDoc }> = [];
    for (let i = 0; i < localStorage.length; i += 1) {
      const key = localStorage.key(i);
      if (key?.startsWith(`${SYNC_FALLBACK_KEY}-`)) {
        records.push(JSON.parse(localStorage.getItem(key)!) as typeof records[number]);
      }
    }
    if (!records.length) return null;
    records.sort((a, b) => (a.base.updatedAt < b.base.updatedAt ? 1 : -1));
    const newest = records[0];
    return { base: newest.base, meta: newest.meta, replicas: records.map((record) => record.replica) };
  } catch {
    return null;
  }
};

/** 旧版本（v1 整份快照）迁移为初始合并基线 */
export const readLegacyState = <T>(): T | null => {
  try {
    const raw = localStorage.getItem(LEGACY_STATE_KEY);
    if (raw) return JSON.parse(raw) as T;
  } catch {
    localStorage.removeItem(LEGACY_STATE_KEY);
  }
  return null;
};
