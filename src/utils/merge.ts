import type {
  CodingState,
  ConflictOpinion,
  PendingConflict,
  Resolution,
  ResolutionRecord,
  Segment,
  SyncMeta,
  Theme,
  Transcript,
  UnitKind,
  UnitValue
} from '../types';

// —— 变更单元（unit）抽取 ——
// 单元键形如 `theme.name:t-1`、`segment.assignA:s-002`、`project.coderA:`。

export interface UnitKey {
  kind: UnitKind;
  entityId: string;
}

const keyOf = (kind: UnitKind, entityId = ''): string => `${kind}:${entityId}`;
export const parseKey = (key: string): UnitKey => {
  const index = key.indexOf(':');
  return { kind: key.slice(0, index) as UnitKind, entityId: key.slice(index + 1) };
};

const FIELD_LABELS: Partial<Record<UnitKind, string>> = {
  'theme.exists': '主题是否存在',
  'theme.name': '主题名称',
  'theme.parentId': '主题层级',
  'theme.definition': '操作定义',
  'theme.memo': '研究备忘录',
  'theme.examples': '典型示例',
  'segment.exists': '片段是否存在',
  'segment.assignA': '编码者 A 的主题判断',
  'segment.assignB': '编码者 B 的主题判断',
  'segment.note': '片段编码备忘',
  'segment.speaker': '发言人',
  'segment.time': '时间码',
  'segment.text': '片段原文',
  'segment.order': '片段顺序',
  'segment.transcriptId': '所属访谈',
  'transcript.exists': '访谈是否存在',
  'transcript.title': '访谈标题',
  'transcript.participant': '受访者',
  'transcript.sourceName': '转写来源',
  'project.coderA': '编码者 A 姓名',
  'project.coderB': '编码者 B 姓名'
};

export const fieldLabel = (kind: UnitKind): string => FIELD_LABELS[kind] ?? kind;

const sameValue = (a: UnitValue, b: UnitValue): boolean => {
  if (Array.isArray(a) || Array.isArray(b)) {
    const aa = Array.isArray(a) ? a : [a];
    const bb = Array.isArray(b) ? b : [b];
    return aa.length === bb.length && aa.every((item, index) => item === bb[index]);
  }
  return a === b;
};

/** 从整份状态抽取出全部变更单元的键值表 */
export const extractUnits = (state: CodingState): Map<string, UnitValue> => {
  const units = new Map<string, UnitValue>();
  units.set(keyOf('project.coderA'), state.coderA);
  units.set(keyOf('project.coderB'), state.coderB);

  state.transcripts.forEach((transcript) => {
    units.set(keyOf('transcript.exists', transcript.id), true);
    units.set(keyOf('transcript.title', transcript.id), transcript.title);
    units.set(keyOf('transcript.participant', transcript.id), transcript.participant);
    units.set(keyOf('transcript.sourceName', transcript.id), transcript.sourceName);
  });

  state.themes.forEach((theme) => {
    units.set(keyOf('theme.exists', theme.id), true);
    units.set(keyOf('theme.name', theme.id), theme.name);
    units.set(keyOf('theme.parentId', theme.id), theme.parentId ?? '');
    units.set(keyOf('theme.definition', theme.id), theme.definition);
    units.set(keyOf('theme.memo', theme.id), theme.memo);
    units.set(keyOf('theme.examples', theme.id), [...theme.examples]);
  });

  state.segments.forEach((segment) => {
    units.set(keyOf('segment.exists', segment.id), true);
    units.set(keyOf('segment.assignA', segment.id), [...segment.assignments.A]);
    units.set(keyOf('segment.assignB', segment.id), [...segment.assignments.B]);
    units.set(keyOf('segment.note', segment.id), segment.note);
    units.set(keyOf('segment.speaker', segment.id), segment.speaker);
    units.set(keyOf('segment.time', segment.id), segment.time);
    units.set(keyOf('segment.text', segment.id), segment.text);
    units.set(keyOf('segment.order', segment.id), segment.order);
    units.set(keyOf('segment.transcriptId', segment.id), segment.transcriptId);
  });

  return units;
};

const findTheme = (state: CodingState, id: string): Theme | undefined =>
  state.themes.find((theme) => theme.id === id);
const findSegment = (state: CodingState, id: string): Segment | undefined =>
  state.segments.find((segment) => segment.id === id);
const findTranscript = (state: CodingState, id: string): Transcript | undefined =>
  state.transcripts.find((transcript) => transcript.id === id);

/** 冲突在界面上显示的对象名 */
export const entityLabelOf = (state: CodingState, kind: UnitKind, entityId: string): string => {
  if (kind.startsWith('theme')) return findTheme(state, entityId)?.name ?? `主题 ${entityId}`;
  if (kind.startsWith('segment')) {
    const segment = findSegment(state, entityId);
    return segment ? `片段 ${segment.time} · ${segment.speaker}` : `片段 ${entityId}`;
  }
  if (kind.startsWith('transcript')) return findTranscript(state, entityId)?.title ?? `访谈 ${entityId}`;
  return '项目设置';
};

export interface MergeInput {
  base: CodingState;
  /** 各写作副本：键为 writerId */
  branches: Map<string, CodingState>;
  /** 各副本最近一次完成同步时的基线（共同祖先），用于判断该副本是否真的改过某单元 */
  forkBases?: Map<string, CodingState>;
  writerLabels: Record<string, string>;
  /** 已存在但尚未处理的冲突（可能上一轮已生成，值仍然冲突时继续保留） */
  existingPending: PendingConflict[];
}

export interface AutoMergedUnit {
  key: string;
  kind: UnitKind;
  entityId: string;
  value: UnitValue;
  /** 相对共同祖先修改了该单元的副本（它们保留原值即可，不应被合并值回写覆盖） */
  changedWriters: string[];
}

export interface MergeOutput {
  merged: CodingState;
  pendingConflicts: PendingConflict[];
  /** 自动达成一致的单元（含只有一个副本改动的情况），值应同步到所有副本并推进基线 */
  autoMerged: AutoMergedUnit[];
  /** 无人改动的基线单元，仅用于补齐落后/新上线副本，不推进修订号 */
  catchupUnits: AutoMergedUnit[];
}

const dedupeOpinions = (opinions: ConflictOpinion[]): ConflictOpinion[] => {
  const seen = new Map<string, ConflictOpinion>();
  opinions.forEach((opinion) => {
    const digest = JSON.stringify(opinion.value);
    if (!seen.has(digest)) seen.set(digest, opinion);
  });
  return [...seen.values()];
};

const mergeOpinions = (oldOnes: ConflictOpinion[], newOnes: ConflictOpinion[]): ConflictOpinion[] => {
  const latest = new Map<string, ConflictOpinion>();
  [...oldOnes, ...newOnes].forEach((opinion) => latest.set(opinion.writerId, opinion));
  return dedupeOpinions([...latest.values()]);
};

/**
 * 字段级三方合并：
 * - 只有一个副本相对基线修改了某单元 → 直接采纳（不同单元自动合并）；
 * - 多个副本修改为相同值 → 采纳该值；
 * - 多个副本修改为不同值 → 生成/保留待处理冲突，当前值不生效；
 * - 单元在某副本被删除而另一副本修改 → 同样视为冲突（删除也是一种意见）。
 */
export const mergeStates = (input: MergeInput): MergeOutput => {
  const { base, branches, writerLabels } = input;
  const baseUnits = extractUnits(base);
  const branchUnits = new Map<string, Map<string, UnitValue>>();
  const forkUnits = new Map<string, Map<string, UnitValue>>();
  branches.forEach((state, writerId) => {
    branchUnits.set(writerId, extractUnits(state));
    forkUnits.set(writerId, extractUnits(input.forkBases?.get(writerId) ?? input.base));
  });

  const allKeys = new Set<string>(baseUnits.keys());
  branchUnits.forEach((units) => units.forEach((_value, key) => allKeys.add(key)));

  // 合并结果先整体复制基线，随后逐单元套用
  const merged: CodingState = structuredClone(base);
  const autoMerged: AutoMergedUnit[] = [];
  const catchupUnits: AutoMergedUnit[] = [];
  const carryOver = new Map<string, PendingConflict>();
  input.existingPending.forEach((conflict) => carryOver.set(`${conflict.kind}:${conflict.entityId}`, conflict));
  const nextPending: PendingConflict[] = [];
  const touchedKeys = new Set<string>();

  allKeys.forEach((key) => {
    const { kind, entityId } = parseKey(key);
    const baseValue: UnitValue | undefined = baseUnits.get(key);

    // 投票规则：以每个副本自己的共同祖先（forkBase）为准，
    // 只有工作稿与该祖先不同时它才对这个单元发表意见。
    // 这样别的副本后来合入的改动，不会被“停留在旧祖先、什么都没做”的副本误投反对票。
    const opinions: ConflictOpinion[] = [];
    branchUnits.forEach((units, writerId) => {
      const ancestor = forkUnits.get(writerId)!;
      const ownExisted = units.has(key);
      const ancestorExisted = ancestor.has(key);
      const own = units.get(key);
      const ancestorValue = ancestor.get(key);
      if (ownExisted === ancestorExisted && (ancestorExisted ? sameValue(own as UnitValue, ancestorValue as UnitValue) : true)) return;
      opinions.push({
        writerId,
        label: writerLabels[writerId] ?? `标签页 ${writerId.slice(0, 4)}`,
        value: ownExisted ? (own as UnitValue) : null
      });
    });

    if (!opinions.length) {
      // 无人改动：基线值即共识。作为追赶单元下发给落后副本补齐，但不改变基线、不增修订号。
      if (baseUnits.has(key)) catchupUnits.push({ key, kind, entityId, value: baseValue as UnitValue, changedWriters: [] });
      return;
    }
    touchedKeys.add(key);

    const distinct = new Map<string, ConflictOpinion>();
    opinions.forEach((opinion) => {
      const digest = JSON.stringify(opinion.value);
      if (!distinct.has(digest)) distinct.set(digest, opinion);
    });

    if (distinct.size === 1) {
      // 意见一致（或只有一个副本改动）：自动合并，任何旧冲突随之解除
      const value = opinions[0].value;
      applyUnit(merged, kind, entityId, value);
      autoMerged.push({ key, kind, entityId, value, changedWriters: opinions.map((opinion) => opinion.writerId) });
      carryOver.delete(key);
      return;
    }

    // 意见不一致：两份结果都保留为待处理冲突，当前值不生效
    const referenceState = branches.get(opinions[0].writerId) ?? base;
    const previous = carryOver.get(key);
    const keptOpinions = dedupeOpinions(opinions);
    const conflict: PendingConflict = previous
      ? { ...previous, opinions: mergeOpinions(previous.opinions, keptOpinions), entityLabel: entityLabelOf(referenceState, kind, entityId) }
      : {
          id: `c-${crypto.randomUUID()}`,
          kind,
          entityId,
          entityLabel: entityLabelOf(referenceState, kind, entityId),
          fieldLabel: fieldLabel(kind),
          baseValue: baseUnits.has(key) ? (baseValue as UnitValue) : null,
          opinions: keptOpinions,
          createdAt: new Date().toISOString()
        };
    carryOver.delete(key);
    nextPending.push(conflict);
  });

  // 既有的待处理冲突：若对应单元已不再有分歧（例如对方撤销了改动），解除；
  // 若仍然冲突（上面 nextPending 已重建）则以新记录为准；其余原样保留。
  const rebuiltKeys = new Set(nextPending.map((conflict) => `${conflict.kind}:${conflict.entityId}`));
  carryOver.forEach((conflict, key) => {
    if (touchedKeys.has(key) && !rebuiltKeys.has(key)) return;
    // 校验意见中的写入者是否还存在；副本被关闭后其本地改动已并入分支集合，保留意见
    nextPending.push(conflict);
  });

  const producedAutoMerges = autoMerged.length > 0;
  const signatureOf = (list: PendingConflict[]) =>
    list.map((conflict) => `${conflict.kind}:${conflict.entityId}:${conflict.opinions.map((opinion) => `${opinion.writerId}=${JSON.stringify(opinion.value)}`).join('|')}`).sort().join(';;');
  const conflictsChanged = signatureOf(nextPending) !== signatureOf(input.existingPending);
  if (producedAutoMerges || conflictsChanged) {
    merged.revision = base.revision + 1;
    merged.updatedAt = new Date().toISOString();
  } else {
    merged.revision = base.revision;
    merged.updatedAt = base.updatedAt;
  }

  // 审计记录合流（不属于合并单元，按时间倒序拼接去重）
  const auditIds = new Set(merged.audit.map((entry) => entry.id));
  branches.forEach((branch) => {
    branch.audit.slice(0, 60).forEach((entry) => {
      if (!auditIds.has(entry.id)) { merged.audit.unshift(entry); auditIds.add(entry.id); }
    });
  });
  merged.audit.sort((a, b) => (a.at < b.at ? 1 : -1));
  merged.audit = merged.audit.slice(0, 250);

  return { merged, pendingConflicts: nextPending, autoMerged, catchupUnits };
};

/** 把一个单元值写回整份状态（按实体 id 定位，必要时随实体一起创建） */
export const applyUnit = (state: CodingState, kind: UnitKind, entityId: string, value: UnitValue): void => {
  if (kind === 'project.coderA') { state.coderA = String(value); return; }
  if (kind === 'project.coderB') { state.coderB = String(value); return; }

  if (kind.startsWith('transcript')) {
    let transcript = state.transcripts.find((item) => item.id === entityId);
    if (kind === 'transcript.exists') {
      if (value === false || value === null) state.transcripts = state.transcripts.filter((item) => item.id !== entityId);
      else if (!transcript) state.transcripts.push({ id: entityId, title: '未命名访谈', participant: '', importedAt: new Date().toISOString(), sourceName: '' });
      return;
    }
    if (!transcript) return;
    if (kind === 'transcript.title') transcript.title = String(value);
    if (kind === 'transcript.participant') transcript.participant = String(value);
    if (kind === 'transcript.sourceName') transcript.sourceName = String(value);
    return;
  }

  if (kind.startsWith('theme')) {
    let theme = state.themes.find((item) => item.id === entityId);
    if (kind === 'theme.exists') {
      if (value === false || value === null) {
        state.themes = state.themes.filter((item) => item.id !== entityId);
        state.themes.forEach((item) => { if (item.parentId === entityId) item.parentId = null; });
        state.segments.forEach((segment) => {
          segment.assignments.A = segment.assignments.A.filter((id) => id !== entityId);
          segment.assignments.B = segment.assignments.B.filter((id) => id !== entityId);
        });
      } else if (!theme) {
        state.themes.push({ id: entityId, name: '未命名主题', parentId: null, color: '#267365', definition: '', memo: '', examples: [] });
      }
      return;
    }
    if (!theme) return;
    if (kind === 'theme.name') theme.name = String(value);
    if (kind === 'theme.parentId') theme.parentId = value ? String(value) : null;
    if (kind === 'theme.definition') theme.definition = String(value);
    if (kind === 'theme.memo') theme.memo = String(value);
    if (kind === 'theme.examples') theme.examples = Array.isArray(value) ? value.map(String) : [];
    return;
  }

  if (kind.startsWith('segment')) {
    let segment = state.segments.find((item) => item.id === entityId);
    if (kind === 'segment.exists') {
      if (value === false || value === null) state.segments = state.segments.filter((item) => item.id !== entityId);
      else if (!segment) return;
      return;
    }
    if (!segment) return;
    if (kind === 'segment.assignA') segment.assignments.A = Array.isArray(value) ? value.map(String) : [];
    if (kind === 'segment.assignB') segment.assignments.B = Array.isArray(value) ? value.map(String) : [];
    if (kind === 'segment.note') segment.note = String(value);
    if (kind === 'segment.speaker') segment.speaker = String(value);
    if (kind === 'segment.time') segment.time = String(value);
    if (kind === 'segment.text') segment.text = String(value);
    if (kind === 'segment.order') segment.order = Number(value);
    if (kind === 'segment.transcriptId') segment.transcriptId = String(value);
  }
};

/** 研究员对一条冲突作出明确选择后，把选中值落到状态，并记录处理结果 */
export const resolveConflict = (
  state: CodingState,
  conflict: PendingConflict,
  chosenWriterId: string,
  resolverWriterId: string
): { state: CodingState; record: ResolutionRecord } => {
  const opinion = conflict.opinions.find((item) => item.writerId === chosenWriterId) ?? conflict.opinions[0];
  const next = structuredClone(state);
  applyUnit(next, conflict.kind, conflict.entityId, opinion.value);
  next.revision = state.revision + 1;
  next.updatedAt = new Date().toISOString();
  const record: ResolutionRecord = {
    id: `r-${crypto.randomUUID()}`,
    conflictId: conflict.id,
    kind: conflict.kind,
    entityId: conflict.entityId,
    chosenValue: opinion.value,
    rejectedValues: conflict.opinions.filter((item) => item.writerId !== opinion.writerId).map((item) => item.value),
    writerId: resolverWriterId,
    at: next.updatedAt,
    entityLabel: conflict.entityLabel,
    fieldLabel: conflict.fieldLabel
  };
  return { state: next, record };
};

export const createSyncMeta = (): SyncMeta => ({
  version: 1,
  updatedAt: new Date().toISOString(),
  pendingConflicts: [],
  resolutions: [],
  writerLabels: {}
});

export type { Resolution };
