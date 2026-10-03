import { createSignal } from 'solid-js';
import { createStore, reconcile as reconcileStore, unwrap } from 'solid-js/store';
import { seedState } from '../data/seed';
import type {
  AuditEntry,
  ChangeEntry,
  ClientRecord,
  CoderId,
  CodingState,
  PendingConflict,
  Segment,
  SyncMeta,
  Theme,
  UnitValue
} from '../types';
import {
  compareSetMeta,
  deleteClient,
  putClient,
  readAllClients,
  readLegacyEnvelope,
  readMeta,
  writeMeta
} from '../utils/db';
import { describeUnit, diffUnits, flattenState, makeMetaFromState, reconcile as reconcileMeta, reconstructState } from '../utils/sync';

const LEGACY_STORAGE_KEY = 'sologsb-1019-state-v1';
const MIRROR_STORAGE_KEY = 'sologsb-1019-state-v2';
const CHANNEL_NAME = 'sologsb-1019-coding-v2';
const HEARTBEAT_MS = 4000;
const POLL_MS = 1500;
const DEAD_AFTER_MS = 9000;
const AUDIT_LIMIT = 250;

type ChannelMessage =
  | { type: 'hello'; clientId: string }
  | { type: 'here'; clientId: string }
  | { type: 'claim'; clientId: string; nonce: string }
  | { type: 'deny'; clientId: string; nonce: string }
  | { type: 'changed'; clientId: string };

const newId = (prefix: string) => `${prefix}-${crypto.randomUUID()}`;
const shortLabel = () => `标签页 ${crypto.randomUUID().slice(0, 4)}`;
const cloneState = (s: CodingState): CodingState => structuredClone(unwrap(s));

const loadFallbackState = (): CodingState => {
  try {
    const raw = localStorage.getItem(LEGACY_STORAGE_KEY);
    if (raw) return JSON.parse(raw) as CodingState;
  } catch {
    localStorage.removeItem(LEGACY_STORAGE_KEY);
  }
  return seedState();
};

const [state, setState] = createStore<CodingState>(loadFallbackState());
const [conflicts, setConflicts] = createSignal<PendingConflict[]>([]);
const [storageReady, setStorageReady] = createSignal(false);
const [lastSavedAt, setLastSavedAt] = createSignal<Date | null>(null);
const [baseRev, setBaseRev] = createSignal(0);
const [clientInfo, setClientInfo] = createSignal<{ id: string; label: string }>({ id: '', label: '' });
const [undoStack, setUndoStack] = createSignal<Array<Record<string, UnitValue>>>([]);
const [redoStack, setRedoStack] = createSignal<Array<Record<string, UnitValue>>>([]);

let metaRef: SyncMeta;
const clientsRef = new Map<string, ClientRecord>();
let ownId = '';
let currentFlat: Record<string, UnitValue> = flattenState(state);
let lastSignature = '';
let channel: BroadcastChannel | null = null;
let persistChain: Promise<void> = Promise.resolve();
let ownDirty = false;
let flushTimer: number | undefined;
let initialized = false;

/* ------------------------------------------------------------------ */
/* 内存对账与渲染                                                       */
/* ------------------------------------------------------------------ */

const isDead = (record: ClientRecord, now = Date.now()) => now - new Date(record.lastWriteAt).getTime() > DEAD_AFTER_MS;

const applyResultToMemory = (result: ReturnType<typeof reconcileMeta>) => {
  metaRef = result.meta;
  const nowIso = new Date().toISOString();

  Object.entries(result.clearEventIds).forEach(([clientId, ids]) => {
    const record = clientsRef.get(clientId);
    if (!record || (clientId !== ownId && !isDead(record))) return;
    const remove = new Set(ids);
    record.events = record.events.filter((event) => !remove.has(event.id));
  });

  Object.entries(result.prune).forEach(([clientId, items]) => {
    const record = clientsRef.get(clientId);
    if (!record || (clientId !== ownId && !isDead(record))) return;
    const seqs = new Set(items.map((item) => item.seq));
    record.changes = record.changes.filter((entry) => !seqs.has(entry.seq));
  });

  // 清理已经没有任何未同步内容的死亡标签页记录
  [...clientsRef.values()].forEach((record) => {
    if (record.clientId !== ownId && isDead(record) && !record.changes.length && !record.events.length) {
      clientsRef.delete(record.clientId);
      void persistChain.then(() => deleteClient(record.clientId));
    }
  });

  const skeleton: CodingState = {
    ...cloneState(state),
    revision: state.revision,
    updatedAt: state.updatedAt,
    audit: result.meta.audit
  };
  const next = reconstructState(result.effective, skeleton);
  const signature = JSON.stringify(result.effective);
  if (signature !== lastSignature) {
    next.revision = state.revision + 1;
    next.updatedAt = nowIso;
    lastSignature = signature;
  } else {
    next.revision = state.revision;
    next.updatedAt = state.updatedAt;
  }
  // 选中项可能因合并而失效，回退到仍存在的实体
  if (!next.themes.some((theme) => theme.id === next.activeThemeId)) next.activeThemeId = next.themes[0]?.id ?? '';
  if (!next.segments.some((segment) => segment.id === next.activeSegmentId)) next.activeSegmentId = next.segments[0]?.id ?? '';
  if (!next.transcripts.some((transcript) => transcript.id === next.activeTranscriptId)) next.activeTranscriptId = next.transcripts[0]?.id ?? '';

  currentFlat = result.effective;
  setState(reconcileStore(next, { merge: false }));
  setConflicts(result.conflicts);
  setBaseRev(result.meta.baseRev);
};

const runLocalReconcile = () => {
  const result = reconcileMeta(metaRef, [...clientsRef.values()], new Date().toISOString());
  applyResultToMemory(result);
};

/* ------------------------------------------------------------------ */
/* 持久化                                                               */
/* ------------------------------------------------------------------ */

const ownRecord = (): ClientRecord => {
  const record = clientsRef.get(ownId);
  if (!record) throw new Error('当前标签页记录尚未初始化');
  return record;
};

const persistOwn = () => {
  if (!ownId) return;
  ownDirty = false;
  const record = structuredClone(ownRecord());
  record.state = cloneState(state);
  try {
    localStorage.setItem(MIRROR_STORAGE_KEY, JSON.stringify(record.state));
  } catch {
    /* 容量受限时保留 IndexedDB 即可 */
  }
  persistChain = persistChain
    .then(() => putClient(record))
    .then(() => { setLastSavedAt(new Date()); })
    .catch((error) => console.warn('保存标签页修订失败', error));
};

const scheduleOwnPersist = () => {
  ownDirty = true;
  window.clearTimeout(flushTimer);
  flushTimer = window.setTimeout(persistOwn, 120);
};

/** 与磁盘上的共享元数据对账，CAS 重试防止跨标签页覆盖 */
const commit = async () => {
  if (ownDirty) persistOwn();
  await persistChain.catch(() => undefined);

  for (let attempt = 0; attempt < 8; attempt += 1) {
    const freshMeta = await readMeta();
    if (!freshMeta) return;
    const freshClients = await readAllClients();
    const nowMs = Date.now();
    const nowIso = new Date(nowMs).toISOString();

    freshClients.forEach((record) => {
      if (record.clientId !== ownId) clientsRef.set(record.clientId, record);
    });

    const result = reconcileMeta(freshMeta, freshClients, nowIso);

    // 仅写自己或已死亡标签页的裁剪结果，避免覆盖存活标签页的新增日志
    const writes: Promise<void>[] = [];
    const writableClients = new Set<string>([ownId]);
    freshClients.forEach((record) => { if (isDead(record, nowMs)) writableClients.add(record.clientId); });

    const applyPruning = () => {
      Object.entries(result.clearEventIds).forEach(([clientId, ids]) => {
        if (!writableClients.has(clientId)) return;
        const record = clientsRef.get(clientId);
        if (!record) return;
        const idSet = new Set(ids);
        record.events = record.events.filter((event) => !idSet.has(event.id));
      });
      Object.entries(result.prune).forEach(([clientId, items]) => {
        if (!writableClients.has(clientId)) return;
        const record = clientsRef.get(clientId);
        if (!record) return;
        const seqs = new Set(items.map((item) => item.seq));
        record.changes = record.changes.filter((entry) => !seqs.has(entry.seq));
      });
      writableClients.forEach((clientId) => {
        const record = clientsRef.get(clientId);
        if (!record) return;
        if (clientId === ownId) {
          scheduleOwnPersist();
        } else if (!record.changes.length && !record.events.length) {
          clientsRef.delete(clientId);
          writes.push(deleteClient(clientId));
        } else {
          writes.push(putClient(structuredClone(record)));
        }
      });
    };

    applyPruning();
    applyResultToMemory(result);

    if (!result.folded) {
      await Promise.all(writes);
      return;
    }

    const ok = await compareSetMeta(freshMeta.baseRev, result.meta);
    await Promise.all(writes);
    if (ok) {
      scheduleOwnPersist();
      return;
    }
    // CAS 失败：有别的标签页先折叠了，带着最新元数据重新对账
  }
};

let commitTimer: number | undefined;
const scheduleCommit = () => {
  window.clearTimeout(commitTimer);
  commitTimer = window.setTimeout(() => { void commit(); }, 240);
};

const editingElementFocused = () => {
  const active = document.activeElement;
  if (!active) return false;
  return /^(INPUT|TEXTAREA|SELECT)$/.test(active.tagName) || (active as HTMLElement).isContentEditable;
};

/* ------------------------------------------------------------------ */
/* 本地事务：把一次操作转成若干独立变更单元                              */
/* ------------------------------------------------------------------ */

const appendChanges = (changed: Record<string, UnitValue>, at: string) => {
  const record = ownRecord();
  Object.entries(changed).forEach(([unit, value]) => {
    record.lastSeq += 1;
    const entry: ChangeEntry = { seq: record.lastSeq, unit, value: value ?? null, at };
    record.changes.push(entry);
  });
  record.lastWriteAt = at;
};

const transaction = (action: string, detail: string, mutator: (draft: CodingState) => void) => {
  setUndoStack((items) => [...items.slice(-49), currentFlat]);
  setRedoStack([]);
  const at = new Date().toISOString();
  const draft = cloneState(state);
  mutator(draft);
  const changed = diffUnits(currentFlat, flattenState(draft));
  if (!Object.keys(changed).length) return;

  appendChanges(changed, at);
  const event: AuditEntry = { id: newId('e'), at, action, detail };
  ownRecord().events.push(event);

  runLocalReconcile();
  scheduleOwnPersist();
  scheduleCommit();
  channel?.postMessage({ type: 'changed', clientId: ownId } as ChannelMessage);
};

const restoreSnapshot = (snapshot: Record<string, UnitValue>, action: string, detail: string) => {
  const at = new Date().toISOString();
  // 撤销/重做只针对当前有效结果逐单元回退，未决冲突单元不会被静默改写
  const changed = diffUnits(currentFlat, snapshot);
  if (!Object.keys(changed).length) return;
  appendChanges(changed, at);
  ownRecord().events.push({ id: newId('e'), at, action, detail });
  runLocalReconcile();
  scheduleOwnPersist();
  scheduleCommit();
  channel?.postMessage({ type: 'changed', clientId: ownId } as ChannelMessage);
};

/* ------------------------------------------------------------------ */
/* 初始化：迁移、认领遗留修订、握手                                      */
/* ------------------------------------------------------------------ */

const ensureMeta = async (): Promise<SyncMeta> => {
  const existing = await readMeta();
  if (existing) return existing;

  let seed = seedState();
  const legacy = await readLegacyEnvelope();
  if (legacy?.state) seed = legacy.state;
  else {
    try {
      const raw = localStorage.getItem(LEGACY_STORAGE_KEY);
      if (raw) seed = JSON.parse(raw) as CodingState;
    } catch {
      /* 忽略损坏的本地缓存 */
    }
  }
  const meta = makeMetaFromState(seed, new Date().toISOString());
  await writeMeta(meta);
  return meta;
};

const wait = (ms: number) => new Promise((resolve) => window.setTimeout(resolve, ms));

const acquireIdentity = async (): Promise<ClientRecord> => {
  const records = await readAllClients();
  records.forEach((record) => clientsRef.set(record.clientId, structuredClone(record)));

  const liveIds = new Set<string>();
  const contestedClaims = new Set<string>();
  const helloId = newId('tab');
  const nonce = newId('n');

  const reply = (event: MessageEvent<ChannelMessage>) => {
    const message = event.data;
    if (!message) return;
    if (message.type === 'hello') {
      liveIds.add(message.clientId);
      channel?.postMessage({ type: 'here', clientId: ownId || helloId } as ChannelMessage);
    } else if (message.type === 'here') {
      liveIds.add(message.clientId);
    } else if (message.type === 'claim' && message.nonce !== nonce) {
      contestedClaims.add(message.clientId);
    }
  };
  channel?.addEventListener('message', reply);
  channel?.postMessage({ type: 'hello', clientId: helloId } as ChannelMessage);
  await wait(350);

  // eslint-disable-next-line no-constant-condition
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const stale = records
      .filter((record) => !liveIds.has(record.clientId) && isDead(record))
      .sort((a, b) => (a.lastWriteAt < b.lastWriteAt ? 1 : -1))[0];
    if (!stale) break;

    channel?.postMessage({ type: 'claim', clientId: stale.clientId, nonce } as ChannelMessage);
    await wait(220);
    if (contestedClaims.has(stale.clientId)) {
      const index = records.indexOf(stale);
      if (index >= 0) records.splice(index, 1);
      continue;
    }
    ownId = stale.clientId;
    stale.lastWriteAt = new Date().toISOString();
    if (stale.state) {
      setState(reconcileStore(stale.state, { merge: false }));
      currentFlat = flattenState(stale.state);
      lastSignature = JSON.stringify(currentFlat);
    }
    channel?.removeEventListener('message', reply);
    return stale;
  }

  ownId = helloId;
  const now = new Date().toISOString();
  const record: ClientRecord = {
    clientId: ownId,
    label: shortLabel(),
    createdAt: now,
    lastWriteAt: now,
    lastSeq: 0,
    changes: [],
    events: [],
    state: cloneState(state)
  };
  channel?.removeEventListener('message', reply);
  await putClient(record);
  return record;
};

/* ------------------------------------------------------------------ */
/* 主题树辅助                                                           */
/* ------------------------------------------------------------------ */

const buildTreeOrder = (themes: Theme[]) => {
  const children = new Map<string | null, Theme[]>();
  themes.forEach((theme) => children.set(theme.parentId, [...(children.get(theme.parentId) ?? []), theme]));
  const result: Theme[] = [];
  const visit = (parentId: string | null, depth: number, seen: Set<string>) => {
    [...(children.get(parentId) ?? [])].sort((a, b) => a.name.localeCompare(b.name, 'zh-CN')).forEach((theme) => {
      if (seen.has(theme.id)) return; // 跨页层级冲突可能临时形成环，跳过防止死循环
      seen.add(theme.id);
      result.push({ ...theme, name: `${'　'.repeat(depth)}${theme.name}` });
      visit(theme.id, depth + 1, seen);
    });
  };
  visit(null, 0, new Set());
  // 因层级环未能从根访问到的主题，扁平地补在末尾，确保仍可见可选
  const visited = new Set(result.map((theme) => theme.id));
  themes.forEach((theme) => {
    if (!visited.has(theme.id)) result.push({ ...theme, name: `${'　'.repeat(0)}${theme.name}` });
  });
  return result;
};

const parseTranscript = (raw: string, speakerFallback: string): Array<Pick<Segment, 'time' | 'speaker' | 'text'>> => {
  const rows = raw.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  return rows.map((line, index) => {
    const timed = line.match(/^\[?(\d{1,2}:\d{2}(?::\d{2})?)\]?\s*(?:[-—])?\s*([^:：]{1,24})[:：]\s*(.+)$/);
    if (timed) return { time: timed[1], speaker: timed[2].trim(), text: timed[3].trim() };
    return { time: `${String(Math.floor(index / 4)).padStart(2, '0')}:${String((index % 4) * 15).padStart(2, '0')}`, speaker: index % 2 === 0 ? speakerFallback : '访谈者', text: line };
  });
};

/* ------------------------------------------------------------------ */
/* 导出：只输出冲突处理后的结果；存在未决冲突时拒绝导出                  */
/* ------------------------------------------------------------------ */

const exportCoding = (format: 'json' | 'csv'): string => {
  if (conflicts().length) {
    throw new Error(`还有 ${conflicts().length} 个未处理的字段级冲突，请在“合并冲突”中逐项选择后再导出。`);
  }
  if (format === 'json') return JSON.stringify({ exportedAt: new Date().toISOString(), ...cloneState(state) }, null, 2);
  const themeMap = new Map(state.themes.map((theme) => [theme.id, theme]));
  const escape = (value: string) => `"${value.replaceAll('"', '""')}"`;
  const rows = [['片段编号', '时间', '发言人', '原文', '编码者', '主题路径', '备忘录'].map(escape).join(',')];
  state.segments.forEach((segment) => {
    (['A', 'B'] as CoderId[]).forEach((coder) => {
      const name = coder === 'A' ? state.coderA : state.coderB;
      const themeIds = segment.assignments[coder];
      const paths = themeIds.length ? themeIds.map((id) => {
        const names: string[] = [];
        const seen = new Set<string>();
        let current = themeMap.get(id);
        while (current && !seen.has(current.id)) {
          seen.add(current.id);
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

export function useCodingStore() {
  const initialize = async () => {
    if (initialized) return;
    initialized = true;
    await new Promise((resolve) => window.setTimeout(resolve, 0));

    if ('BroadcastChannel' in window) {
      channel = new BroadcastChannel(CHANNEL_NAME);
      channel.onmessage = (event: MessageEvent<ChannelMessage>) => {
        const message = event.data;
        if (!message || message.clientId === ownId) return;
        if (message.type === 'changed') scheduleCommit();
      };
    }

    metaRef = await ensureMeta();
    const own = await acquireIdentity();
    clientsRef.set(own.clientId, own);
    setClientInfo({ id: own.clientId, label: own.label });
    ownId = own.clientId;

    // 首次以共享基线 + 所有标签页日志（含自己未折叠的离线改动）派生权威工作状态
    runLocalReconcile();
    lastSignature = JSON.stringify(currentFlat);
    scheduleOwnPersist();
    void commit();
    setStorageReady(true);

    window.setInterval(() => {
      if (!ownId) return;
      const record = ownRecord();
      record.lastWriteAt = new Date().toISOString();
      persistOwn();
    }, HEARTBEAT_MS);
    window.setInterval(() => {
      if (!editingElementFocused()) void commit();
    }, POLL_MS);
    window.addEventListener('online', () => { void commit(); });
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') persistOwn();
    });
    window.addEventListener('beforeunload', () => {
      ownRecord().lastWriteAt = new Date().toISOString();
      persistOwn();
    });
  };

  const undo = () => {
    const items = undoStack();
    if (!items.length) return;
    const snapshot = items[items.length - 1];
    setUndoStack(items.slice(0, -1));
    setRedoStack((redo) => [...redo, currentFlat]);
    restoreSnapshot(snapshot, '撤销', '回退到上一个字段状态');
  };

  const redo = () => {
    const items = redoStack();
    if (!items.length) return;
    const snapshot = items[items.length - 1];
    setRedoStack(items.slice(0, -1));
    setUndoStack((undoItems) => [...undoItems, currentFlat]);
    restoreSnapshot(snapshot, '重做', '重新应用字段改动');
  };

  const selectSegment = (id: string) => setState('activeSegmentId', id);
  const selectTranscript = (id: string) => setState('activeTranscriptId', id);
  const selectTheme = (id: string) => setState('activeThemeId', id);

  const setCoder = (coder: CoderId, name: string) => {
    transaction('修改编码者姓名', `${coder === 'A' ? '编码者 A' : '编码者 B'}：${name}`, (draft) => {
      if (coder === 'A') draft.coderA = name;
      else draft.coderB = name;
    });
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
    const id = newId('t');
    transaction('新建主题', name, (draft) => {
      draft.themes.push({ id, name, parentId, color: parentId ? '#57978c' : '#267365', definition: '', memo: '', examples: [] });
      draft.activeThemeId = id;
    });
    return id;
  };

  const updateTheme = (themeId: string, patch: Partial<Theme>, fieldLabel: string) => {
    transaction('编辑主题', fieldLabel, (draft) => {
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
    const newIdValue = newId('t');
    transaction('拆分主题', newName, (draft) => {
      const source = draft.themes.find((theme) => theme.id === sourceId);
      if (!source) return;
      draft.themes.push({ ...source, id: newIdValue, name: newName, examples: [] });
      draft.segments.forEach((segment) => {
        if (!segmentIds.includes(segment.id)) return;
        (['A', 'B'] as CoderId[]).forEach((coder) => {
          if (segment.assignments[coder].includes(sourceId)) {
            segment.assignments[coder] = segment.assignments[coder].map((id) => (id === sourceId ? newIdValue : id));
          }
        });
      });
      draft.activeThemeId = newIdValue;
    });
    return newIdValue;
  };

  const updateSegment = (segmentId: string, patch: Pick<Segment, 'speaker' | 'time' | 'text' | 'note'>) => {
    transaction('编辑片段', `片段 ${segmentId}`, (draft) => {
      const segment = draft.segments.find((item) => item.id === segmentId);
      if (segment) Object.assign(segment, patch);
    });
  };

  const importTranscript = (raw: string, title: string, participant: string, sourceName: string) => {
    const transcriptId = newId('tr');
    const rows = parseTranscript(raw, participant);
    transaction('导入转写', `${title}（${rows.length} 个片段）`, (draft) => {
      draft.transcripts.push({ id: transcriptId, title, participant, importedAt: new Date().toISOString(), sourceName });
      const start = draft.segments.length;
      const segments: Segment[] = rows.map((row, index) => ({
        id: newId('s'),
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

  const downloadExport = (format: 'json' | 'csv') => {
    let content: string;
    try {
      content = exportCoding(format);
    } catch (error) {
      window.alert((error as Error).message);
      return;
    }
    const blob = new Blob([content], { type: format === 'json' ? 'application/json;charset=utf-8' : 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `访谈编码结果-${new Date().toISOString().slice(0, 10)}.${format}`;
    anchor.click();
    URL.revokeObjectURL(url);
  };

  /* ---------------- 冲突裁决 ---------------- */

  const clientLabel = (clientId: string | null) => {
    if (!clientId) return '原值';
    if (clientId === ownId) return '本标签页';
    return clientsRef.get(clientId)?.label ?? `标签页 ${clientId.slice(0, 4)}`;
  };

  const resolveConflict = async (unit: string, chooseClientId: string | null) => {
    // 先以当前内存中的冲突信息确定候选，再在 CAS 循环里以磁盘为准重新计算
    const known = conflicts().find((item) => item.unit === unit);
    if (!known) return;
    const at = new Date().toISOString();

    for (let attempt = 0; attempt < 8; attempt += 1) {
      const freshMeta = await readMeta();
      if (!freshMeta) return;
      const freshClients = await readAllClients();
      const probe = reconcileMeta(freshMeta, freshClients, at);
      const current = probe.conflicts.find((item) => item.unit === unit);
      if (!current) {
        applyResultToMemory(probe);
        return;
      }
      const chosen = chooseClientId === null ? undefined : current.candidates.find((candidate) => candidate.clientId === chooseClientId);
      const value = chosen ? chosen.value : (Object.prototype.hasOwnProperty.call(freshMeta.base, unit) ? freshMeta.base[unit] : null);
      const chosenClientId = chosen ? chosen.clientId : null;
      const discarded = current.candidates
        .filter((candidate) => candidate.clientId !== chosenClientId)
        .map((candidate) => candidate.value);
      const descriptor = describeUnit(unit);

      const withResolution: SyncMeta = {
        ...freshMeta,
        resolutions: { ...freshMeta.resolutions, [unit]: { value, clientId: chosenClientId, at, discarded } },
        resolutionLog: [
          ...freshMeta.resolutionLog,
          { id: newId('r'), at, unit, label: current.fieldLabel, kept: value, discarded }
        ],
        audit: [
          {
            id: newId('resolve'),
            at,
            action: '解决字段级冲突',
            detail: `${descriptor.fieldLabel}：研究员选择了${chosenClientId ? (chosenClientId === ownId ? '本标签页' : '另一标签页') : '保留原值'}的结果，另一份结果已归档但不再生效`
          },
          ...freshMeta.audit
        ].slice(0, AUDIT_LIMIT)
      };

      const result = reconcileMeta(withResolution, freshClients, at);
      const nowMs = Date.now();
      const writes: Promise<void>[] = [];
      Object.entries(result.prune).forEach(([clientId, items]) => {
        const record = freshClients.find((item) => item.clientId === clientId);
        const dead = record && isDead(record, nowMs);
        if (clientId !== ownId && !dead) return;
        const target = clientsRef.get(clientId);
        if (!target) return;
        const seqs = new Set(items.map((item) => item.seq));
        target.changes = target.changes.filter((entry) => !seqs.has(entry.seq));
        if (clientId === ownId) {
          scheduleOwnPersist();
        } else if (!target.changes.length && !target.events.length) {
          clientsRef.delete(clientId);
          writes.push(deleteClient(clientId));
        } else writes.push(putClient(structuredClone(target)));
      });

      const ok = await compareSetMeta(freshMeta.baseRev, result.meta);
      await Promise.all(writes);
      if (ok) {
        applyResultToMemory(result);
        scheduleOwnPersist();
        channel?.postMessage({ type: 'changed', clientId: ownId } as ChannelMessage);
        // 级联折叠（如删除/保留裁决牵动的同实体字段）继续对账一轮
        void commit();
        return;
      }
    }
  };

  /** 一键采用某个标签页在所有未决单元上的候选（仍逐项落档，可在操作记录中追溯） */
  const adoptAllFromClient = async (clientId: string) => {
    const units = conflicts()
      .filter((item) => item.candidates.some((candidate) => candidate.clientId === clientId))
      .map((item) => item.unit);
    for (const unit of units) {
      // eslint-disable-next-line no-await-in-loop
      await resolveConflict(unit, clientId);
    }
    // 再对账一轮，让保留/删除裁决引发的级联折叠尽快收敛
    await commit();
  };

  const orderedThemes = () => buildTreeOrder(state.themes);

  return {
    state,
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
    exportCoding,
    downloadExport,
    orderedThemes,
    conflicts,
    resolveConflict,
    adoptAllFromClient,
    clientLabel,
    clientInfo,
    storageReady,
    lastSavedAt,
    baseRev
  };
}

export type CodingStore = ReturnType<typeof useCodingStore>;
