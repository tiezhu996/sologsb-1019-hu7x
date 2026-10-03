import type {
  AuditEntry,
  ChangeEntry,
  ClientRecord,
  CodingState,
  ConflictCandidate,
  PendingConflict,
  SyncMeta,
  Theme,
  UnitValue
} from '../types';

/* ------------------------------------------------------------------ */
/* 变更单元键约定                                                       */
/*   theme:<id>:<field>      field = name|parentId|color|definition   */
/*                            |memo|examples|alive                     */
/*   segment:<id>:<field>    field = transcriptId|order|speaker|time   */
/*                            |text|assignA|assignB|note|alive          */
/*   transcript:<id>:<field> field = title|participant|importedAt      */
/*                            |sourceName|alive                         */
/*   meta:coderA | meta:coderB                                         */
/* ------------------------------------------------------------------ */

const THEME_FIELDS = ['name', 'parentId', 'color', 'definition', 'memo', 'examples', 'alive'] as const;
const SEGMENT_FIELDS = ['transcriptId', 'order', 'speaker', 'time', 'text', 'assignA', 'assignB', 'note', 'alive'] as const;
const TRANSCRIPT_FIELDS = ['title', 'participant', 'importedAt', 'sourceName', 'alive'] as const;

const FIELD_LABELS: Record<string, string> = {
  name: '名称',
  parentId: '层级',
  color: '颜色',
  definition: '操作定义',
  memo: '研究备忘录',
  examples: '示例',
  alive: '删除标记',
  transcriptId: '所属访谈',
  order: '排序',
  speaker: '发言人',
  time: '时间码',
  text: '原文',
  assignA: '编码者 A 的主题判断',
  assignB: '编码者 B 的主题判断',
  note: '编码备忘',
  title: '访谈标题',
  participant: '受访者',
  importedAt: '导入时间',
  sourceName: '来源文件',
  coderA: '编码者 A 姓名',
  coderB: '编码者 B 姓名'
};

const UNIT_PATTERN = /^(theme|segment|transcript):([^:]+):(.+)$/;
const META_PATTERN = /^meta:(coderA|coderB)$/;

export const deepEqual = (a: UnitValue, b: UnitValue): boolean => {
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((item, index) => deepEqual(item, b[index]));
  }
  if (typeof a === 'object' && typeof b === 'object') {
    const ka = Object.keys(a as object);
    const kb = Object.keys(b as object);
    return ka.length === kb.length && ka.every((key) => deepEqual((a as Record<string, UnitValue>)[key], (b as Record<string, UnitValue>)[key]));
  }
  return false;
};

const normalize = (field: string, value: UnitValue): UnitValue => {
  // 主题判断语义上是集合：相同集合不同顺序不应算作分歧
  if ((field === 'assignA' || field === 'assignB' || field === 'examples') && Array.isArray(value)) {
    return [...(value as string[])].map((item) => item.trim()).filter(Boolean).sort();
  }
  if (typeof value === 'string') return value;
  return value;
};

/** 把一份完整工作状态摊平为变更单元映射 */
export const flattenState = (state: CodingState): Record<string, UnitValue> => {
  const units: Record<string, UnitValue> = {};
  state.themes.forEach((theme) => {
    units[`theme:${theme.id}:name`] = theme.name;
    units[`theme:${theme.id}:parentId`] = theme.parentId;
    units[`theme:${theme.id}:color`] = theme.color;
    units[`theme:${theme.id}:definition`] = theme.definition;
    units[`theme:${theme.id}:memo`] = theme.memo;
    units[`theme:${theme.id}:examples`] = [...theme.examples];
    units[`theme:${theme.id}:alive`] = true;
  });
  state.segments.forEach((segment) => {
    units[`segment:${segment.id}:transcriptId`] = segment.transcriptId;
    units[`segment:${segment.id}:order`] = segment.order;
    units[`segment:${segment.id}:speaker`] = segment.speaker;
    units[`segment:${segment.id}:time`] = segment.time;
    units[`segment:${segment.id}:text`] = segment.text;
    units[`segment:${segment.id}:assignA`] = [...segment.assignments.A].sort();
    units[`segment:${segment.id}:assignB`] = [...segment.assignments.B].sort();
    units[`segment:${segment.id}:note`] = segment.note;
    units[`segment:${segment.id}:alive`] = true;
  });
  state.transcripts.forEach((transcript) => {
    units[`transcript:${transcript.id}:title`] = transcript.title;
    units[`transcript:${transcript.id}:participant`] = transcript.participant;
    units[`transcript:${transcript.id}:importedAt`] = transcript.importedAt;
    units[`transcript:${transcript.id}:sourceName`] = transcript.sourceName;
    units[`transcript:${transcript.id}:alive`] = true;
  });
  units['meta:coderA'] = state.coderA;
  units['meta:coderB'] = state.coderB;
  return units;
};

/** 对比两份摊平结果，返回发生变化的单元。
 *  实体被删除时：alive 单元发 false（墓碑），其余字段单元发 null；
 *  其他缺失单元发 null。 */
export const diffUnits = (
  before: Record<string, UnitValue>,
  after: Record<string, UnitValue>
): Record<string, UnitValue> => {
  const changed: Record<string, UnitValue> = {};
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  keys.forEach((key) => {
    const field = key.split(':').pop() ?? key;
    const existed = Object.prototype.hasOwnProperty.call(before, key);
    const exists = Object.prototype.hasOwnProperty.call(after, key);
    let next: UnitValue;
    if (!exists && existed && field === 'alive') next = false;
    else if (!exists) next = null;
    else next = after[key];
    if (!deepEqual(normalize(field, before[key]), normalize(field, next))) changed[key] = next;
  });
  return changed;
};

export interface UnitDescriptor {
  scope: PendingConflict['scope'];
  entityId: string;
  field: string;
  fieldLabel: string;
}

export const describeUnit = (unit: string): UnitDescriptor => {
  const meta = META_PATTERN.exec(unit);
  if (meta) return { scope: 'meta', entityId: '', field: meta[1], fieldLabel: FIELD_LABELS[meta[1]] ?? meta[1] };
  const match = UNIT_PATTERN.exec(unit);
  if (match) {
    const [, scope, entityId, field] = match;
    return { scope: scope as PendingConflict['scope'], entityId, field, fieldLabel: FIELD_LABELS[field] ?? field };
  }
  return { scope: 'meta', entityId: '', field: unit, fieldLabel: unit };
};

const validField = (scope: string, field: string): boolean => {
  if (scope === 'theme') return (THEME_FIELDS as readonly string[]).includes(field);
  if (scope === 'segment') return (SEGMENT_FIELDS as readonly string[]).includes(field);
  return (TRANSCRIPT_FIELDS as readonly string[]).includes(field);
};

/** 从变更单元映射重建工作状态；结构性字段沿用骨架（修订号、审计、当前选中项） */
export const reconstructState = (
  units: Record<string, UnitValue>,
  skeleton: CodingState
): CodingState => {
  type EntityRow = Record<string, UnitValue> & { __id: string };
  const themeRows = new Map<string, EntityRow>();
  const segmentRows = new Map<string, EntityRow>();
  const transcriptRows = new Map<string, EntityRow>();

  Object.entries(units).forEach(([unit, value]) => {
    const match = UNIT_PATTERN.exec(unit);
    if (!match) return;
    const [, scope, id, field] = match;
    if (!validField(scope, field)) return;
    const bucket = scope === 'theme' ? themeRows : scope === 'segment' ? segmentRows : transcriptRows;
    const row = bucket.get(id) ?? ({ __id: id } as EntityRow);
    row[field] = value;
    bucket.set(id, row);
  });

  const nextThemes: Theme[] = [...themeRows.values()]
    .filter((row) => row.alive !== false && row.alive != null)
    .map((row) => ({
      id: row.__id,
      name: String(row.name ?? ''),
      parentId: (row.parentId as string | null) ?? null,
      color: String(row.color ?? '#267365'),
      definition: String(row.definition ?? ''),
      memo: String(row.memo ?? ''),
      examples: Array.isArray(row.examples) ? (row.examples as string[]) : []
    }));

  const nextTranscripts = [...transcriptRows.values()]
    .filter((row) => row.alive !== false && row.alive != null)
    .map((row) => ({
      id: row.__id,
      title: String(row.title ?? '未命名访谈'),
      participant: String(row.participant ?? ''),
      importedAt: String(row.importedAt ?? ''),
      sourceName: String(row.sourceName ?? '')
    }));

  const nextSegments = [...segmentRows.values()]
    .filter((row) => row.alive !== false && row.alive != null)
    .map((row) => ({
      id: row.__id,
      transcriptId: String(row.transcriptId ?? ''),
      order: typeof row.order === 'number' ? row.order : 0,
      speaker: String(row.speaker ?? ''),
      time: String(row.time ?? ''),
      text: String(row.text ?? ''),
      assignments: {
        A: Array.isArray(row.assignA) ? (row.assignA as string[]) : [],
        B: Array.isArray(row.assignB) ? (row.assignB as string[]) : []
      },
      note: String(row.note ?? '')
    }))
    .sort((a, b) => a.order - b.order);

  return {
    ...skeleton,
    revision: skeleton.revision,
    updatedAt: skeleton.updatedAt,
    coderA: String(units['meta:coderA'] ?? skeleton.coderA),
    coderB: String(units['meta:coderB'] ?? skeleton.coderB),
    themes: nextThemes,
    transcripts: nextTranscripts,
    segments: nextSegments,
    audit: skeleton.audit
  };
};

export const makeMetaFromState = (state: CodingState, now: string): SyncMeta => ({
  baseRev: 1,
  baseUpdatedAt: now,
  base: flattenState(state),
  resolutions: {},
  resolutionLog: [],
  audit: state.audit.map((entry) => ({ ...entry }))
});

export interface ReconcileResult {
  meta: SyncMeta;
  /** 已按裁决/自动合并/未决暂定规则取值的有效单元映射 */
  effective: Record<string, UnitValue>;
  conflicts: PendingConflict[];
  /** 各标签页可从自己追加日志中剪掉的条目（已折叠或已被裁决搁置） */
  prune: Record<string, Array<{ unit: string; seq: number }>>;
  /** 各标签页已折叠进共享审计的本地事件，可从其 events 中清除 */
  clearEventIds: Record<string, string[]>;
  /** 是否发生了任何折叠（元数据需要写回） */
  folded: boolean;
}

interface LatestEntry {
  clientId: string;
  entry: ChangeEntry;
}

/**
 * 三方（实际是多方）字段级对账：
 *  - 不同变更单元：互不影响，各自自动合并；
 *  - 同一单元仅一方偏离基线：自动合入；
 *  - 同一单元存在两份或以上互不相同且都偏离基线的结果：保留为未决冲突，
 *    双方结果都留在 candidates 中，等待研究员显式裁决。
 */
export const reconcile = (meta: SyncMeta, clients: ClientRecord[], now: string): ReconcileResult => {
  const base: Record<string, UnitValue> = { ...meta.base };
  const prune: ReconcileResult['prune'] = {};
  const clearEventIds: Record<string, string[]> = {};
  const markPrune = (clientId: string, unit: string, seq: number) => {
    (prune[clientId] ??= []).push({ unit, seq });
  };

  /* 1. 折叠各标签页的本地审计事件（按 id 去重） */
  const mergedAudit = [...meta.audit];
  const seenAudit = new Set(mergedAudit.map((entry) => entry.id));
  const pendingEvents: AuditEntry[] = [];
  clients.forEach((client) => {
    (client.events ?? []).forEach((event) => {
      if (seenAudit.has(event.id)) {
        (clearEventIds[client.clientId] ??= []).push(event.id);
        return;
      }
      seenAudit.add(event.id);
      pendingEvents.push(event);
      (clearEventIds[client.clientId] ??= []).push(event.id);
    });
  });
  pendingEvents.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : a.id.localeCompare(b.id)));
  mergedAudit.unshift(...pendingEvents);

  /* 2. 应用研究员已经作出的裁决。
        裁决在所有相关标签页把陈旧日志剪掉之前保持“已决”状态，
        防止被搁置的一方候选在下一轮对账时自动折叠复活。 */
  const remainingResolutions: SyncMeta['resolutions'] = {};
  const settledUnits = new Set<string>();
  const foldedUnits = new Set<string>();
  // 上一轮已裁决“保留（alive=true）”的实体：删除方残留的字段 null 一律搁置，不再挂起
  const keepResolvedEntities = new Set<string>();
  // 上一轮已裁决“删除（alive=false）”的实体：编辑方残留结果按过期处理
  const deleteResolvedEntities = new Set<string>();
  Object.entries(meta.resolutions).forEach(([unit, resolution]) => {
    let staleRemaining = 0;
    const descriptor0 = describeUnit(unit);
    const entityKey0 = descriptor0.scope === 'meta' ? '' : `${descriptor0.scope}:${descriptor0.entityId}`;
    clients.forEach((client) => {
      client.changes.forEach((entry) => {
        if (entry.unit !== unit) {
          // alive 裁决为“保留”时，删除方残留的同实体字段 null 是陈旧日志：剪除并继续持有裁决一轮
          if (
            descriptor0.field === 'alive' && resolution.value === true && entityKey0 &&
            entry.unit.startsWith(`${entityKey0}:`) && entry.unit !== unit && entry.value === null
          ) {
            markPrune(client.clientId, entry.unit, entry.seq);
            staleRemaining += 1;
          }
          // alive 裁决为“删除”时，编辑方对同实体的残留修改同样是陈旧日志
          if (
            descriptor0.field === 'alive' && resolution.value === false && entityKey0 &&
            entry.unit.startsWith(`${entityKey0}:`) && entry.unit !== unit
          ) {
            markPrune(client.clientId, entry.unit, entry.seq);
            staleRemaining += 1;
          }
          return;
        }
        const matchesKept = deepEqual(entry.value, resolution.value);
        const matchesDiscarded = resolution.discarded.some((value) => deepEqual(value, entry.value));
        if (matchesKept || matchesDiscarded) markPrune(client.clientId, unit, entry.seq);
        if (matchesDiscarded) staleRemaining += 1;
      });
    });
    base[unit] = resolution.value;
    settledUnits.add(unit);
    if (descriptor0.field === 'alive') {
      if (resolution.value === true) keepResolvedEntities.add(entityKey0);
      if (resolution.value === false) deleteResolvedEntities.add(entityKey0);
    }
    // 仍有存活标签页持有被搁置候选时，保留裁决，等其下一轮对账自行剪枝
    if (staleRemaining > 0) remainingResolutions[unit] = resolution;
  });

  /* 3. 汇总每个标签页在每个单元上的最新一条变更 */
  const latest = new Map<string, LatestEntry[]>();
  clients.forEach((client) => {
    const latestByUnit = new Map<string, ChangeEntry>();
    client.changes.forEach((entry) => {
      const previous = latestByUnit.get(entry.unit);
      if (!previous || entry.seq > previous.seq) latestByUnit.set(entry.unit, entry);
      if (previous) markPrune(client.clientId, entry.unit, previous.seq);
    });
    latestByUnit.forEach((entry, unit) => {
      latest.set(unit, [...(latest.get(unit) ?? []), { clientId: client.clientId, entry }]);
    });
  });

  /* 4. 逐单元合并（跳过已决单元） */
  const conflicts: PendingConflict[] = [];
  const conflictUnits = new Set<string>();
  const allUnits = new Set([...Object.keys(base), ...latest.keys()]);

  // 预计算每个实体被哪些标签页改动，以及谁请求删除（alive:false）
  const entityClients = new Map<string, Set<string>>();
  const deleteRequesters = new Map<string, Array<{ clientId: string; at: string }>>();
  latest.forEach((entries, unit) => {
    const descriptor = describeUnit(unit);
    if (descriptor.scope === 'meta') return;
    const entityKey = `${descriptor.scope}:${descriptor.entityId}`;
    const set = entityClients.get(entityKey) ?? new Set<string>();
    entries.forEach(({ clientId, entry }) => {
      set.add(clientId);
      if (descriptor.field === 'alive' && entry.value === false) {
        const list = deleteRequesters.get(entityKey) ?? [];
        list.push({ clientId, at: entry.at });
        deleteRequesters.set(entityKey, list);
      }
    });
    entityClients.set(entityKey, set);
  });
  // 一方删除、其他方同期编辑 → 删除不能单方生效，整体进入冲突（已裁决的实体不再重复挂起）
  const pendingDeleteEntities = new Set<string>();
  deleteRequesters.forEach((requesters, entityKey) => {
    if (keepResolvedEntities.has(entityKey) || deleteResolvedEntities.has(entityKey)) return;
    const editors = [...(entityClients.get(entityKey) ?? [])].filter((id) => !requesters.some((r) => r.clientId === id));
    if (editors.length) pendingDeleteEntities.add(entityKey);
  });

  allUnits.forEach((unit) => {
    if (settledUnits.has(unit)) return;
    const entries = latest.get(unit) ?? [];
    const descriptor = describeUnit(unit);
    const entityKey = descriptor.scope === 'meta' ? '' : `${descriptor.scope}:${descriptor.entityId}`;
    const hasBase = Object.prototype.hasOwnProperty.call(base, unit);
    const baseValue = base[unit];

    // 实体已被裁决删除（墓碑在基线）、或上一轮刚裁决删除时，迟到的字段级编辑按过期处理
    if (
      descriptor.scope !== 'meta' && descriptor.field !== 'alive' &&
      (base[`${entityKey}:alive`] === false || deleteResolvedEntities.has(entityKey))
    ) {
      entries.forEach(({ clientId, entry }) => markPrune(clientId, unit, entry.seq));
      return;
    }

    // 上一轮裁决“保留”：删除方残留的字段 null 直接剪除，让编辑方改动正常合入
    if (descriptor.scope !== 'meta' && descriptor.field !== 'alive' && keepResolvedEntities.has(entityKey)) {
      entries.forEach(({ clientId, entry }) => {
        if (entry.value === null) markPrune(clientId, unit, entry.seq);
      });
    }

    // 删除尚在冲突中：删除方写入的字段 null 先挂起，保持基线值，等 alive 单元裁决；
    // 若删除方之外还有人改了同一字段，则把删除方的 null 也作为候选，双方结果都保留
    if (descriptor.scope !== 'meta' && descriptor.field !== 'alive' && pendingDeleteEntities.has(entityKey)) {
      const requesterIds = new Set(deleteRequesters.get(entityKey)!.map((r) => r.clientId));
      const nonDeleteEditors = entries.filter(({ clientId }) => !requesterIds.has(clientId));
      if (nonDeleteEditors.length === 0) return;
    }

    // 与基线一致的旧结果直接剪除（删除挂起字段上删除方的 null 例外保留）
    entries.forEach(({ clientId, entry }) => {
      if (pendingDeleteEntities.has(entityKey) && entry.value === null) return;
      if (hasBase && deepEqual(normalize(descriptor.field, entry.value), normalize(descriptor.field, baseValue))) {
        markPrune(clientId, unit, entry.seq);
      }
    });

    const differing = entries.filter(({ entry }) =>
      !(hasBase && deepEqual(normalize(descriptor.field, entry.value), normalize(descriptor.field, baseValue))));
    let distinct: ConflictCandidate[] = [];
    differing.forEach(({ clientId, entry }) => {
      if (pendingDeleteEntities.has(entityKey) && entry.value === null) {
        if (!distinct.some((candidate) => candidate.value === null)) distinct.push({ clientId, value: null, at: entry.at });
        return;
      }
      const normalized = normalize(descriptor.field, entry.value);
      const existing = distinct.find((candidate) => deepEqual(normalize(descriptor.field, candidate.value), normalized));
      if (existing) return;
      distinct.push({ clientId, value: entry.value, at: entry.at });
    });

    // alive 单元上“删除 vs 同期编辑”：只保留删除(false)候选，再为每个编辑方补一份隐式“保留(true)”
    if (descriptor.field === 'alive' && pendingDeleteEntities.has(entityKey)) {
      const requesterIds = new Set(deleteRequesters.get(entityKey)!.map((r) => r.clientId));
      const deleteCandidates = distinct.filter((candidate) => candidate.value === false);
      const keepCandidates: ConflictCandidate[] = [...entityClients.get(entityKey)!]
        .filter((clientId) => !requesterIds.has(clientId))
        .map((clientId) => ({ clientId, value: true, at: entries[0]?.entry.at ?? '' }));
      distinct = [...deleteCandidates, ...keepCandidates];
    }

    if (distinct.length === 0) return;
    if (distinct.length === 1) {
      // 仅一方偏离基线：自动合并该单元（删除在无并发编辑时立即生效）
      base[unit] = distinct[0].value;
      foldedUnits.add(unit);
      entries.forEach(({ clientId, entry }) => markPrune(clientId, unit, entry.seq));
      return;
    }

    // 同一单元有两份或以上互不相同的结果：双方（多方）都保留，不生效
    conflictUnits.add(unit);
    entries.forEach(({ clientId, entry }) => {
      const candidate = distinct.find((item) => item.clientId === clientId);
      if (!candidate && hasBase) markPrune(clientId, unit, entry.seq);
    });
    conflicts.push({
      unit,
      scope: descriptor.scope,
      entityId: descriptor.entityId,
      field: descriptor.field,
      fieldLabel: descriptor.fieldLabel,
      base: hasBase ? baseValue : undefined,
      candidates: distinct.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : a.clientId.localeCompare(b.clientId)))
    });
  });

  /* 6. 审计与基线版本 */
  const foldedEventCount = pendingEvents.length;
  const hadResolutions = Object.keys(meta.resolutions).length > 0;
  const folded = hadResolutions || foldedUnits.size > 0 || foldedEventCount > 0;
  const nextMeta: SyncMeta = {
    ...meta,
    base,
    resolutions: remainingResolutions,
    baseRev: folded ? meta.baseRev + 1 : meta.baseRev,
    baseUpdatedAt: folded ? now : meta.baseUpdatedAt,
    audit: mergedAudit.slice(0, 250)
  };

  if (foldedUnits.size > 0) {
    const labels = [...foldedUnits].slice(0, 3).map((unit) => describeUnit(unit).fieldLabel);
    const rest = foldedUnits.size - labels.length;
    nextMeta.audit.unshift({
      id: `merge-${nextMeta.baseRev}`,
      at: now,
      action: '自动合并其他标签页修订',
      detail: `按变更单元自动合并 ${foldedUnits.size} 项改动（${labels.join('、')}${rest ? ` 等 ${rest} 项` : ''}），未覆盖任何一页的内容`
    });
  }
  conflicts.forEach((conflict) => {
    const id = `conflict:${conflict.unit}`;
    if (!seenAudit.has(id)) {
      nextMeta.audit.unshift({
        id,
        at: now,
        action: '检出字段级冲突',
        detail: `${conflict.fieldLabel}存在 ${conflict.candidates.length} 份不同结果，已全部保留，等待研究员选择`
      });
    }
  });
  nextMeta.audit = nextMeta.audit.slice(0, 250);

  /* 7. 有效取值：已决/自动合并取基线；未决单元暂取基线值，基线缺失时取第一份候选 */
  const effective: Record<string, UnitValue> = { ...base };
  conflicts.forEach((conflict) => {
    if (Object.prototype.hasOwnProperty.call(effective, conflict.unit)) return;
    effective[conflict.unit] = conflict.candidates[0]?.value;
  });

  return { meta: nextMeta, effective, conflicts, prune, clearEventIds, folded };
};

/* ------------------------------------------------------------------ */
/* 冲突展示辅助                                                         */
/* ------------------------------------------------------------------ */

export interface ValueRenderContext {
  themeName: (id: string) => string | undefined;
  transcriptTitle: (id: string) => string | undefined;
}

/** 把候选值渲染为人类可读文本 */
export const renderValue = (unit: string, value: UnitValue, ctx: ValueRenderContext): string => {
  const descriptor = describeUnit(unit);
  if (value === undefined || value === null) return '（无值）';
  if (descriptor.field === 'alive') return value === false ? '删除该项' : '保留该项';
  if (descriptor.field === 'parentId') {
    if (!value) return '一级主题（无上级）';
    return ctx.themeName(value as string) ?? `主题 ${value}`;
  }
  if (descriptor.field === 'transcriptId') return ctx.transcriptTitle(value as string) ?? `访谈 ${value}`;
  if (descriptor.field === 'assignA' || descriptor.field === 'assignB') {
    const ids = Array.isArray(value) ? (value as string[]) : [];
    if (!ids.length) return '未编码';
    return ids.map((id) => ctx.themeName(id) ?? `未知主题 ${id}`).join('、');
  }
  if (descriptor.field === 'examples') {
    const items = Array.isArray(value) ? (value as string[]) : [];
    return items.length ? items.join('；') : '（无示例）';
  }
  if (value === '') return '（清空）';
  if (Array.isArray(value)) return value.join('、');
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
};
