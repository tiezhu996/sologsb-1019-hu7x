/**
 * 跨标签页互斥锁（基于 localStorage + storage 事件）。
 * 同一时刻只允许一个标签页执行“读账本 → 合并 → 写账本”的临界区，
 * 消除多页并发同步导致的后写覆盖。
 */
const LOCK_KEY = 'sologsb-1019-sync-lock';
const LOCK_TTL_MS = 4000;

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const readLockHolder = (): { holder: string; at: number } | null => {
  try {
    const raw = localStorage.getItem(LOCK_KEY);
    return raw ? (JSON.parse(raw) as { holder: string; at: number }) : null;
  } catch {
    return null;
  }
};

/** 等待获取跨标签页锁；失败或超时则放弃（下一轮 4s 定时同步会重试） */
export const acquireCrossTabLock = async (holder: string, timeoutMs = 2500): Promise<boolean> => {
  const deadline = Date.now() + timeoutMs;
  let pending: Array<() => void> = [];
  const onStorage = (event: StorageEvent) => { if (event.key === LOCK_KEY && !event.newValue) pending.forEach((fn) => fn()); };
  window.addEventListener('storage', onStorage);

  try {
    while (Date.now() < deadline) {
      const existing = readLockHolder();
      const stale = !existing || Date.now() - existing.at > LOCK_TTL_MS;
      if (stale) {
        try {
          localStorage.setItem(LOCK_KEY, JSON.stringify({ holder, at: Date.now() }));
          // 双检：极小概率两个标签页同时认为过期，确认持有者是自己
          const confirm = readLockHolder();
          if (confirm?.holder === holder) return true;
        } catch {
          return true; // 隐私模式等无法写锁时退化为不互斥（功能仍可用）
        }
      }
      await new Promise<void>((resolve) => {
        const done = () => { pending = pending.filter((fn) => fn !== done); resolve(); };
        pending.push(done);
        window.setTimeout(done, 120);
      });
    }
    return false;
  } finally {
    window.removeEventListener('storage', onStorage);
  }
};

export const releaseCrossTabLock = (holder: string): void => {
  try {
    const existing = readLockHolder();
    if (existing?.holder === holder) localStorage.removeItem(LOCK_KEY);
  } catch {
    /* ignore */
  }
};

export const lockDelay = wait;
