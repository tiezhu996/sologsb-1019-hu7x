import { createSignal } from 'solid-js';
import { createStore, reconcile, unwrap } from 'solid-js/store';
import { seedState } from '../data/seed';
import type {
  CoderId,
  CodingState,
  PendingConflict,
  ReplicaDoc,
  Segment,
  SyncBundle,
  SyncMeta,
  Theme,
  UnitKind,
  UnitValue
} from '../types';
import {
  readEnvelope,
  readLegacyState,
  readSyncBundle,
  writeSyncBundle
} from '../utils/db';
import {
  applyUnit,
  createSyncMeta,
  entityLabelOf,
  extractUnits,
  fieldLabel,
  mergeStates,
  parseKey,
  resolveConflict as resolveConflictUnit
} from '../utils/merge';
import { acquireCrossTabLock, releaseCrossTabLock } from '../utils/lock';

const clone = <T,>(value: T): T => structuredClone(value);
const nowIso = () => new Date().toISOString();
const shortId = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

let myWriterId: string = crypto.randomUUID();

// —— 内存中的同步账本（进程内单例，所有 useCodingStore 调用共享） ——
let bundle: SyncBundle | null = null;
let lastPersistedMe: CodingState | null = null;
let channel: BroadcastChannel | null = null;
let saveTimer: number | undefined;
let mergeTimer: number | undefined;
let hydrating = false;
let syncChain: Promise<void> = Promise.resolve();

const [state, setState] = createStore<CodingState>(seedState());
const [resolvedState, setResolvedState] = createStore<CodingState>(seedState());
const [meta, setMeta] = createStore<SyncMeta>(createSyncMeta());
const [undoStack, setUndoStack] = createSignal<CodingState[]>([]);
const [redoStack, setRedoStack] = createSignal<CodingState[]>([]);
const [storageReady, setStorageReady] = createSignal(false);
const [lastSavedAt, setLastSavedAt] = createSignal<Date | null>(null);
const [online, setOnline] = createSignal(typeof navigator === 'undefined' ? true : navigator.onLine);
const [externalActive, setExternalActive] = createSignal(false);

const myReplica = (): ReplicaDoc => {
  const found = bundle!.replicas.find((replica) => replica.writerId === myWriterId);
  if (found) return found;
  const created: ReplicaDoc = { writerId: myWriterId, state: clone(bundle!.base), forkBase: clone(bundle!.base), lastSeen: nowIso() };
  bundle!.replicas.push(created);
  return created;
};

const sameValue = (a: UnitValue, b: UnitValue): boolean => {
  if (Array.isArray(a) || Array.isArray(b)) {
    const aa = Array.isArray(a) ? a : [a];
    const bb = Array.isArray(b) ? b : [b];
    return aa.length === bb.length && aa.every((item, index) => item === bb[index]);
  }
  return a === b;
};

/**
 * 合并“磁盘上的本页副本”与“本页内存工作稿”。
 * 逐单元比较三方：磁盘值 d、内存值 m、上次落盘值 p。
 * - m === p：内存没有新改动（可能上一轮已提前落盘）→ 采用磁盘值 d（它可能已含更早的合并）；
 * - m !== p：内存有未落盘改动 → 以内存值 m 为准覆盖磁盘值。
 */
const overlayLocalEdits = (incomingMe: ReplicaDoc) => {
  if (!lastPersistedMe) return;
  const diskUnits = extractUnits(incomingMe.state);
  const before = extractUnits(lastPersistedMe);
  const current = extractUnits(unwrap(state));
  const allUnitKeys = new Set<string>([...diskUnits.keys(), ...before.keys(), ...current.keys()]);
  allUnitKeys.forEach((key) => {
    const { kind, entityId } = parseKey(key);
    const diskValue = diskUnits.get(key);
    const persistedValue = before.get(key);
    const memoryValue = current.get(key);
    const memoryDirty = current.has(key) && (!before.has(key) || !sameValue(persistedValue as UnitValue, memoryValue as UnitValue));
    if (memoryDirty) {
      applyUnit(incomingMe.state, kind, entityId, current.has(key) ? (memoryValue as UnitValue) : null);
    } else if (diskUnits.has(key)) {
      applyUnit(incomingMe.state, kind, entityId, diskValue as UnitValue);
    }
  });
  // 活动选择不属于合并单元：优先保留当前界面选择
  incomingMe.state.activeTranscriptId = state.activeTranscriptId;
  incomingMe.state.activeSegmentId = state.activeSegmentId;
  incomingMe.state.activeThemeId = state.activeThemeId;
};

const pendingKey = (conflict: PendingConflict) => `${conflict.kind}:${conflict.entityId}`;

const unionPending = (a: PendingConflict[], b: PendingConflict[]): PendingConflict[] => {
  const byKey = new Map<string, PendingConflict>();
  [...a, ...b].forEach((conflict) => {
    const existing = byKey.get(pendingKey(conflict));
    if (!existing || conflict.createdAt >= existing.createdAt) byKey.set(pendingKey(conflict), conflict);
  });
  return [...byKey.values()];
};

/**
 * 从磁盘读取其他标签页落盘的账本。
 * 外部副本一律以磁盘为准（各页只写自己的副本键，故磁盘即最新）；
 * 本页副本先叠加内存中尚未落盘的改动，避免同步往返抹掉刚做的编辑。
 */
const ingestStoredBundle = async (stored: SyncBundle) => {
  if (!bundle) return;
  const storedMe = stored.replicas.find((replica) => replica.writerId === myWriterId);
  if (storedMe) overlayLocalEdits(storedMe);

  if (stored.base.updatedAt >= bundle.base.updatedAt) bundle.base = stored.base;
  bundle.meta.pendingConflicts = unionPending(bundle.meta.pendingConflicts, stored.meta.pendingConflicts);
  if (stored.meta.resolutions.length >= bundle.meta.resolutions.length) bundle.meta.resolutions = stored.meta.resolutions;
  Object.entries(stored.meta.writerLabels).forEach(([writerId, label]) => { bundle!.meta.writerLabels[writerId] = label; });

  // 副本表：他页副本永远以磁盘为准；本页副本采用 overlay 合并磁盘最新值后的 storedMe
  const localById = new Map(bundle.replicas.map((replica) => [replica.writerId, replica]));
  const mergedMe = storedMe ?? localById.get(myWriterId) ?? myReplica();
  bundle.replicas = stored.replicas
    .filter((replica) => replica.writerId !== myWriterId)
    .concat(mergedMe);
  // 磁盘上出现过、但本次拉取结果里暂时缺失的他页副本（对方恰好在写）也不删除
  localById.forEach((replica, writerId) => {
    if (writerId !== myWriterId && !bundle!.replicas.some((item) => item.writerId === writerId)) bundle!.replicas.push(replica);
  });
  if (!bundle.replicas.some((replica) => replica.writerId === myWriterId)) bundle.replicas.push(myReplica());
  setExternalActive(bundle.replicas.some((replica) => replica.writerId !== myWriterId));
};

const pendingSignature = (list: PendingConflict[]) =>
  list.map((conflict) =>
    `${pendingKey(conflict)}:${conflict.opinions.map((opinion) => `${opinion.writerId}=${JSON.stringify(opinion.value)}`).join('|')}`
  ).sort().join(';;');

/** 核心：对所有写作副本执行字段级三方合并（各副本状态已在 ingest 阶段与磁盘/内存对齐） */
const runMerge = (): boolean => {
  if (!bundle) return false;
  const me = myReplica();
  me.lastSeen = nowIso();

  const before = JSON.stringify({ revision: bundle.base.revision, pending: pendingSignature(bundle.meta.pendingConflicts) });

  const branches = new Map<string, CodingState>();
  const forkBases = new Map<string, CodingState>();
  bundle.replicas.forEach((replica) => {
    branches.set(replica.writerId, replica.state);
    forkBases.set(replica.writerId, replica.forkBase ?? bundle!.base);
  });

  const output = mergeStates({
    base: clone(bundle.base),
    branches,
    forkBases,
    writerLabels: bundle.meta.writerLabels,
    existingPending: bundle.meta.pendingConflicts
  });

  // 自动达成一致的单元：同步到所有副本工作稿，并把 forkBase fast-forward 到共识值。
  // 冲突单元保持各方原值不动，等待研究员裁决。
  bundle.replicas.forEach((replica) => {
    output.autoMerged.forEach((unit) => {
      applyUnit(replica.state, unit.kind, unit.entityId, unit.value);
      applyUnit(replica.forkBase, unit.kind, unit.entityId, unit.value);
    });
  });
  // 追赶单元（无人改动的基线值）：只写给当前值确实落后的副本，避免每轮无谓重写全部数据。
  bundle.replicas.forEach((replica) => {
    const units = extractUnits(replica.state);
    output.catchupUnits.forEach((unit) => {
      const current = units.get(unit.key);
      if (!units.has(unit.key) || !sameValue(current as UnitValue, unit.value)) {
        applyUnit(replica.state, unit.kind, unit.entityId, unit.value);
      }
    });
    // 本轮合并完成后，各副本的共同祖先整体 fast-forward 到新基线，
    // 保证落后副本不会在后续轮次对已合入的改动误投“改回旧值”票。
    replica.forkBase = clone(output.merged);
  });
  bundle.base = output.merged;
  bundle.meta.pendingConflicts = output.pendingConflicts;
  bundle.meta.updatedAt = nowIso();

  // 刷新界面（state=本副本工作稿；resolvedState=合并后已生效结果）
  const mergedMe = myReplica();
  hydrating = true;
  setState(reconcile(mergedMe.state, { merge: false }));
  setResolvedState(reconcile(bundle.base, { merge: false }));
  setMeta(reconcile(bundle.meta, { merge: false }));
  hydrating = false;

  const after = JSON.stringify({ revision: bundle.base.revision, pending: pendingSignature(bundle.meta.pendingConflicts) });
  return before !== after;
};

const persistBundle = async (includeBase: boolean) => {
  if (!bundle || hydrating) return;
  const me = myReplica();
  me.lastSeen = nowIso();
  // 始终以界面最新工作稿为准（临界区可能与事务提交并发）
  me.state = clone(unwrap(state));
  bundle.meta.updatedAt = nowIso();
  try {
    await writeSyncBundle(clone(bundle), myWriterId, includeBase);
    lastPersistedMe = clone(me.state);
    setLastSavedAt(new Date());
    channel?.postMessage({ type: 'bundle-written', from: myWriterId });
  } catch (error) {
    // 隐私模式或配额受限时仍保留内存副本，断网/重开浏览器后继续保留
    console.warn('同步账本写入失败，改动保留在本页内存中', error);
  }
};

/**
 * 统一串行同步：跨标签页加锁 → 读磁盘 → 并入外部副本 → 字段级合并 → 写回。
 * 锁保证“读-合并-写”对其他标签页原子，杜绝并发后写覆盖。
 */
const syncNow = async (pull: boolean) => {
  // 先尽快把本页副本独立落盘（不触碰 base/meta），保证未同步本地改动不丢
  void persistBundle(false);
  const job = syncChain.then(async () => {
    const locked = await acquireCrossTabLock(myWriterId);
    try {
      if (!bundle) return;
      // 临界区内永远先拉取磁盘上最新的 base / meta / 他页副本，再合并，避免用过时基线覆盖
      const stored = await readSyncBundle();
      if (stored) await ingestStoredBundle(stored);
      runMerge();
      await persistBundle(true);
    } finally {
      if (locked) releaseCrossTabLock(myWriterId);
    }
  });
  syncChain = job.catch(() => undefined);
  return syncChain;
};

const scheduleSave = () => {
  window.clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => { void syncNow(true); }, 180);
};

const scheduleRemoteMerge = () => {
  window.clearTimeout(mergeTimer);
  mergeTimer = window.setTimeout(() => { void syncNow(true); }, 300);
};

const transaction = (action: string, detail: string, mutator: (draft: CodingState) => void) => {
  if (!bundle) return;
  setUndoStack((items) => [...items.slice(-49), clone(unwrap(state))]);
  setRedoStack([]);
  const next = clone(unwrap(state));
  mutator(next);
  next.revision = unwrap(state).revision + 1;
  next.updatedAt = nowIso();
  next.audit.unshift({ id: `a-${shortId()}`, at: next.updatedAt, action, detail });
  next.audit = next.audit.slice(0, 250);
  setState(reconcile(next, { merge: false }));
  scheduleSave();
};

const buildTreeOrder = (themes: Theme[]) => {
  const children = new Map<string | null, Theme[]>();
  themes.forEach((theme) => children.set(theme.parentId, [...(children.get(theme.parentId) ?? []), theme]));
  const result: Theme[] = [];
  const visit = (parentId: string | null, depth: number) => {
    [...(children.get(parentId) ?? [])].sort((a, b) => a.name.localeCompare(b.name, 'zh-CN')).forEach((theme) => {
      result.push({ ...theme, name: `${'　'.repeat(depth)}${theme.name}` });
      visit(theme.id, depth + 1);
    });
  };
  visit(null, 0);
  return result;
};

const parseTranscript = (raw: string, speakerFallback: string): Array<Pick<Segment, 'time' | 'speaker' | 'text'>> => {
  const rows = raw.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  return rows.map((line, index) => {
    const timed = line.match(/^\[?(\d{1,2}:\d{2}(?::\d{2})?)\]?\s*(?:[-—])?\s*([^:：]{1,24})[:：]\s*(.+)$/);
    if (timed) return { time: timed[1], speaker: timed[2].trim(), text: timed[3].trim() };
    return {
      time: `${String(Math.floor(index / 4)).padStart(2, '0')}:${String((index % 4) * 15).padStart(2, '0')}`,
      speaker: index % 2 === 0 ? speakerFallback : '访谈者',
      text: line
    };
  });
};

const discoverLiveWriters = (): Promise<Set<string>> => new Promise((resolve) => {
  const live = new Set<string>([myWriterId]);
  if (!('BroadcastChannel' in window)) { resolve(live); return; }
  const probe = new BroadcastChannel('sologsb-1019-coding');
  const timer = window.setTimeout(() => { probe.close(); resolve(live); }, 300);
  probe.onmessage = (event: MessageEvent) => {
    if (event.data?.type === 'here') live.add(event.data.from);
  };
  probe.postMessage({ type: 'hello', from: myWriterId });
});

/** 首次启动：建立或迁移合并账本，并认领一个离线副本（断网/重开浏览器后的本地改动由此延续） */
const bootstrap = async (): Promise<void> => {
  const stored = await readSyncBundle();
  if (stored && stored.replicas.length) {
    bundle = stored;
  } else {
    const legacyEnvelope = await readEnvelope();
    const legacyState = readLegacyState<CodingState>();
    bundle = { meta: createSyncMeta(), base: clone(legacyEnvelope?.state ?? legacyState ?? seedState()), replicas: [] };
  }

  const liveWriters = await discoverLiveWriters();
  const orphan = bundle.replicas
    .filter((replica) => !liveWriters.has(replica.writerId))
    .sort((a, b) => (a.lastSeen < b.lastSeen ? 1 : -1))[0];
  if (orphan) {
    myWriterId = orphan.writerId;
  } else if (!bundle.replicas.some((replica) => replica.writerId === myWriterId)) {
    bundle.replicas.push({ writerId: myWriterId, state: clone(bundle.base), forkBase: clone(bundle.base), lastSeen: nowIso() });
  }
  bundle.meta.writerLabels[myWriterId] = `标签页 ${myWriterId.slice(0, 4)}`;

  hydrating = true;
  const me = myReplica();
  setState(reconcile(me.state, { merge: false }));
  setResolvedState(reconcile(bundle.base, { merge: false }));
  setMeta(reconcile(bundle.meta, { merge: false }));
  hydrating = false;
  lastPersistedMe = clone(me.state);
  setStorageReady(true);
  await syncNow(false);
};

export function useCodingStore() {
  const initialize = async () => {
    await new Promise((resolve) => window.setTimeout(resolve, 0));
    try {
      await bootstrap();
    } catch (error) {
      console.error('本地账本初始化失败', error);
    }

    if ('BroadcastChannel' in window) {
      channel = new BroadcastChannel('sologsb-1019-coding');
      channel.onmessage = (event: MessageEvent) => {
        const data = event.data as { type?: string; from?: string } | null;
        if (!data || data.from === myWriterId) return;
        if (data.type === 'hello') { channel?.postMessage({ type: 'here', from: myWriterId }); return; }
        if (data.type === 'here') return;
        if (data.type === 'bundle-written') { setExternalActive(true); scheduleRemoteMerge(); }
      };
      window.setTimeout(() => channel?.postMessage({ type: 'here', from: myWriterId }), 350);
    }

    window.addEventListener('online', () => { setOnline(true); void syncNow(true); });
    window.addEventListener('offline', () => setOnline(false));
    document.addEventListener('visibilitychange', () => { if (!document.hidden) void syncNow(true); });
    // 网络恢复或重开浏览器后的兜底同步
    window.setInterval(() => { if (!document.hidden) void syncNow(true); }, 4000);
  };

  const undo = () => {
    const items = undoStack();
    if (!items.length) return;
    const previous = items[items.length - 1];
    setUndoStack(items.slice(0, -1));
    setRedoStack((redo) => [...redo, clone(unwrap(state))]);
    setState(reconcile(previous, { merge: false }));
    scheduleSave();
  };

  const redo = () => {
    const items = redoStack();
    if (!items.length) return;
    const next = items[items.length - 1];
    setRedoStack(items.slice(0, -1));
    setUndoStack((undoItems) => [...undoItems, clone(unwrap(state))]);
    setState(reconcile(next, { merge: false }));
    scheduleSave();
  };

  const selectSegment = (id: string) => { setState('activeSegmentId', id); scheduleSave(); };
  const selectTranscript = (id: string) => { setState('activeTranscriptId', id); scheduleSave(); };
  const selectTheme = (id: string) => { setState('activeThemeId', id); scheduleSave(); };
  const setCoder = (coder: CoderId, name: string) => {
    transaction('修改编码者', name, (draft) => { if (coder === 'A') draft.coderA = name; else draft.coderB = name; });
  };

  const toggleAssignment = (segmentId: string, coder: CoderId, themeId: string, enabled: boolean) => {
    transaction('调整编码', `${coder === 'A' ? state.coderA : state.coderB} ${enabled ? '添加' : '移除'}主题`, (draft) => {
      const segment = draft.segments.find((item) => item.id === segmentId);
      if (!segment) return;
      const codes = new Set(segment.assignments[coder]);
      if (enabled) codes.add(themeId);
      else codes.delete(themeId);
      segment.assignments[coder] = [...codes];
    });
  };

  const batchAssign = (segmentIds: string[], coder: CoderId, themeId: string) => {
    if (!segmentIds.length) return;
    transaction('批量重编码', `将 ${segmentIds.length} 个片段分配给主题`, (draft) => {
      draft.segments.forEach((segment) => {
        if (segmentIds.includes(segment.id) && !segment.assignments[coder].includes(themeId)) segment.assignments[coder].push(themeId);
      });
    });
  };

  const addTheme = (name: string, parentId: string | null) => {
    const id = `t-${shortId()}`;
    transaction('新建主题', name, (draft) => {
      draft.themes.push({ id, name, parentId, color: parentId ? '#57978c' : '#267365', definition: '', memo: '', examples: [] });
      draft.activeThemeId = id;
    });
    return id;
  };

  const updateTheme = (themeId: string, patch: Partial<Theme>, fieldLabelText: string) => {
    transaction('编辑主题', fieldLabelText, (draft) => {
      const theme = draft.themes.find((item) => item.id === themeId);
      if (theme) Object.assign(theme, patch);
    });
  };

  const deleteTheme = (themeId: string) => {
    const theme = state.themes.find((item) => item.id === themeId);
    if (!theme) return;
    transaction('删除主题', theme.name, (draft) => {
      draft.themes = draft.themes.filter((item) => item.id !== themeId);
      draft.themes.forEach((item) => { if (item.parentId === themeId) item.parentId = null; });
      draft.segments.forEach((segment) => {
        segment.assignments.A = segment.assignments.A.filter((id) => id !== themeId);
        segment.assignments.B = segment.assignments.B.filter((id) => id !== themeId);
      });
      if (draft.activeThemeId === themeId) draft.activeThemeId = draft.themes[0]?.id ?? '';
    });
  };

  const mergeThemes = (sourceId: string, targetId: string) => {
    if (!sourceId || !targetId || sourceId === targetId) return;
    transaction('合并主题', `${state.themes.find((item) => item.id === sourceId)?.name ?? sourceId} → ${state.themes.find((item) => item.id === targetId)?.name ?? targetId}`, (draft) => {
      draft.segments.forEach((segment) => {
        (['A', 'B'] as CoderId[]).forEach((coder) => {
          const codes = new Set(segment.assignments[coder].filter((id) => id !== sourceId));
          if (segment.assignments[coder].includes(sourceId)) codes.add(targetId);
          segment.assignments[coder] = [...codes];
        });
      });
      draft.themes.forEach((theme) => { if (theme.parentId === sourceId) theme.parentId = targetId; });
      draft.themes = draft.themes.filter((theme) => theme.id !== sourceId);
      draft.activeThemeId = targetId;
    });
  };

  const splitTheme = (sourceId: string, newName: string, segmentIds: string[]) => {
    const newId = `t-${shortId()}`;
    transaction('拆分主题', newName, (draft) => {
      const source = draft.themes.find((theme) => theme.id === sourceId);
      if (!source) return;
      draft.themes.push({ ...source, id: newId, name: newName, examples: [] });
      draft.segments.forEach((segment) => {
        if (!segmentIds.includes(segment.id)) return;
        (['A', 'B'] as CoderId[]).forEach((coder) => {
          if (segment.assignments[coder].includes(sourceId)) {
            segment.assignments[coder] = segment.assignments[coder].map((id) => (id === sourceId ? newId : id));
          }
        });
      });
      draft.activeThemeId = newId;
    });
    return newId;
  };

  const updateSegment = (segmentId: string, patch: Pick<Segment, 'speaker' | 'time' | 'text' | 'note'>) => {
    transaction('编辑片段', `片段 ${segmentId}`, (draft) => {
      const segment = draft.segments.find((item) => item.id === segmentId);
      if (segment) Object.assign(segment, patch);
    });
  };

  const importTranscript = (raw: string, title: string, participant: string, sourceName: string) => {
    const transcriptId = `tr-${shortId()}`;
    const rows = parseTranscript(raw, participant);
    transaction('导入转写', `${title}（${rows.length} 个片段）`, (draft) => {
      draft.transcripts.push({ id: transcriptId, title, participant, importedAt: nowIso(), sourceName });
      const start = draft.segments.length;
      const segments: Segment[] = rows.map((row, index) => ({
        id: `s-${shortId()}`,
        transcriptId,
        order: start + index,
        speaker: row.speaker,
        time: row.time,
        text: row.text,
        assignments: { A: [], B: [] },
        note: ''
      }));
      draft.segments.push(...segments);
      draft.activeTranscriptId = transcriptId;
      draft.activeSegmentId = segments[0]?.id ?? draft.activeSegmentId;
    });
  };

  const addExample = (themeId: string, example: string) => {
    const trimmed = example.trim();
    if (!trimmed) return;
    transaction('添加主题示例', trimmed, (draft) => {
      const theme = draft.themes.find((item) => item.id === themeId);
      if (theme && !theme.examples.includes(trimmed)) theme.examples.push(trimmed);
    });
  };

  // —— 冲突显式裁决：研究员选择后才对所有副本生效 ——
  const resolveOneConflict = (conflictId: string, chosenWriterId: string) => {
    if (!bundle) return;
    const conflict = bundle.meta.pendingConflicts.find((item) => item.id === conflictId);
    if (!conflict) return;
    const chosen = conflict.opinions.find((opinion) => opinion.writerId === chosenWriterId) ?? conflict.opinions[0];
    const result = resolveConflictUnit(bundle.base, conflict, chosen.writerId, myWriterId);

    bundle.base = result.state;
    bundle.replicas.forEach((replica) => {
      applyUnit(replica.state, conflict.kind, conflict.entityId, result.record.chosenValue);
      applyUnit(replica.forkBase, conflict.kind, conflict.entityId, result.record.chosenValue);
    });
    bundle.base.audit.unshift({
      id: `a-${shortId()}`,
      at: nowIso(),
      action: '解决合并冲突',
      detail: `${conflict.entityLabel} · ${conflict.fieldLabel} → 采用「${chosen.label}」的结果`
    });
    bundle.meta.pendingConflicts = bundle.meta.pendingConflicts.filter((item) => item.id !== conflictId);
    bundle.meta.resolutions.unshift(result.record);
    bundle.meta.resolutions = bundle.meta.resolutions.slice(0, 200);

    hydrating = true;
    const me = myReplica();
    setState(reconcile(me.state, { merge: false }));
    setResolvedState(reconcile(bundle.base, { merge: false }));
    setMeta(reconcile(bundle.meta, { merge: false }));
    hydrating = false;
    setUndoStack([]);
    setRedoStack([]);
    void syncNow(true);
  };

  /** 导出一律以“字段级合并并完成冲突处理后”的结果（base）为准 */
  const exportCoding = (format: 'json' | 'csv') => {
    const source = bundle?.base ?? unwrap(resolvedState);
    const themeMap = new Map(source.themes.map((theme) => [theme.id, theme]));
    if (format === 'json') {
      return JSON.stringify({
        exportedAt: nowIso(),
        note: '导出内容为字段级合并并完成冲突处理后的结果；未处理冲突不生效',
        pendingConflictCount: bundle?.meta.pendingConflicts.length ?? 0,
        resolutions: bundle?.meta.resolutions ?? [],
        ...clone(source)
      }, null, 2);
    }
    const escape = (value: string) => `"${value.replaceAll('"', '""')}"`;
    const rows = [['片段编号', '时间', '发言人', '原文', '编码者', '主题路径', '备忘录'].map(escape).join(',')];
    source.segments.forEach((segment) => {
      (['A', 'B'] as CoderId[]).forEach((coder) => {
        const name = coder === 'A' ? source.coderA : source.coderB;
        const themeIds = segment.assignments[coder];
        const paths = themeIds.length ? themeIds.map((id) => {
          const names: string[] = [];
          let current = themeMap.get(id);
          while (current) {
            names.unshift(current.name);
            current = current.parentId ? themeMap.get(current.parentId) : undefined;
          }
          return names.join(' / ');
        }) : ['未编码'];
        rows.push([segment.id, segment.time, segment.speaker, segment.text, name, paths.join(' | '), segment.note].map(escape).join(','));
      });
    });
    return `﻿${rows.join('\n')}`;
  };

  const downloadExport = (format: 'json' | 'csv') => {
    const content = exportCoding(format);
    const blob = new Blob([content], { type: format === 'json' ? 'application/json;charset=utf-8' : 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `访谈编码结果-${new Date().toISOString().slice(0, 10)}.${format}`;
    anchor.click();
    URL.revokeObjectURL(url);
  };

  const orderedThemes = () => buildTreeOrder(state.themes);

  /** 冲突意见在界面上的可读值 */
  const renderOpinionValue = (kind: string, value: UnitValue): string => {
    const source = bundle?.base ?? unwrap(resolvedState);
    if (kind === 'segment.assignA' || kind === 'segment.assignB') {
      const ids = Array.isArray(value) ? value : [];
      return ids.length
        ? ids.map((id) => source.themes.find((theme) => theme.id === id)?.name ?? '未知主题').join('、')
        : '未编码';
    }
    if (kind === 'theme.parentId') {
      return value
        ? source.themes.find((theme) => theme.id === String(value))?.name ?? '未知上级主题'
        : '顶级主题';
    }
    if (kind === 'theme.examples') return Array.isArray(value) && value.length ? value.join('；') : '（无示例）';
    if (kind.endsWith('.exists')) return value === false || value === null ? '删除' : '保留';
    if (Array.isArray(value)) return value.length ? value.join('、') : '（空）';
    if (value === null) return '（删除）';
    return String(value ?? '') || '（空）';
  };

  const opinionLabel = (writerId: string) =>
    writerId === myWriterId ? '本标签页' : (bundle?.meta.writerLabels[writerId] ?? `标签页 ${writerId.slice(0, 4)}`);

  const conflictLocation = (conflict: { kind: UnitKind; entityId: string }) =>
    bundle ? entityLabelOf(bundle.base, conflict.kind, conflict.entityId) : '';

  return {
    state,
    resolvedState,
    meta,
    initialize,
    undo,
    redo,
    canUndo: () => undoStack().length > 0,
    canRedo: () => redoStack().length > 0,
    selectSegment,
    selectTranscript,
    selectTheme,
    setCoder,
    toggleAssignment,
    batchAssign,
    addTheme,
    updateTheme,
    deleteTheme,
    mergeThemes,
    splitTheme,
    updateSegment,
    importTranscript,
    addExample,
    resolveOneConflict,
    exportCoding,
    downloadExport,
    orderedThemes,
    renderOpinionValue,
    opinionLabel,
    conflictLocation,
    fieldLabel,
    pendingConflicts: () => meta.pendingConflicts,
    resolutions: () => meta.resolutions,
    storageReady,
    lastSavedAt,
    online,
    externalActive,
    myWriterId: () => myWriterId
  };
}

export type CodingStore = ReturnType<typeof useCodingStore>;
