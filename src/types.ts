export type CoderId = 'A' | 'B';

export interface Theme {
  id: string;
  name: string;
  parentId: string | null;
  color: string;
  definition: string;
  memo: string;
  examples: string[];
}

export interface Segment {
  id: string;
  transcriptId: string;
  order: number;
  speaker: string;
  time: string;
  text: string;
  assignments: Record<CoderId, string[]>;
  note: string;
}

export interface Transcript {
  id: string;
  title: string;
  participant: string;
  importedAt: string;
  sourceName: string;
}

export interface AuditEntry {
  id: string;
  at: string;
  action: string;
  detail: string;
}

export interface CodingState {
  revision: number;
  updatedAt: string;
  activeTranscriptId: string;
  activeSegmentId: string;
  activeThemeId: string;
  coderA: string;
  coderB: string;
  transcripts: Transcript[];
  segments: Segment[];
  themes: Theme[];
  audit: AuditEntry[];
}

export interface PersistedEnvelope {
  revision: number;
  updatedAt: string;
  writerId: string;
  state: CodingState;
}

/* ------------------------------------------------------------------ */
/* 字段级同步：每个变更单元独立记录、独立合并、独立冲突                  */
/* ------------------------------------------------------------------ */

/** 变更单元上承载的 JSON 可序列化值：字符串、字符串数组、实体快照或删除标记 null */
export type UnitValue = unknown;

/** 一个标签页（客户端）对某个变更单元的追加式修改记录 */
export interface ChangeEntry {
  /** 同一客户端内单调递增的序号，用于断网期间的增量对账与裁剪 */
  seq: number;
  /** 变更单元键，例如 field:theme:t-1:name、field:segment:s-1:assign:A */
  unit: string;
  value: UnitValue;
  at: string;
}

/** 标签页修订流：只追加的变更日志，由所属标签页维护 */
export interface ClientRecord {
  clientId: string;
  label: string;
  createdAt: string;
  lastWriteAt: string;
  /** 该客户端曾经写入的最大序号 */
  lastSeq: number;
  changes: ChangeEntry[];
}

/** 研究员对某个冲突单元的明确裁决 */
export interface Resolution {
  value: UnitValue;
  /** 裁决采用的候选来自哪个标签页；采用基线时为 null */
  clientId: string | null;
  at: string;
  /** 裁决时被搁置的其余候选，作为双方结果都保留过的凭据 */
  discarded: UnitValue[];
}

export interface ResolutionLogEntry {
  id: string;
  at: string;
  unit: string;
  /** 人类可读的单元说明 */
  label: string;
  kept: UnitValue;
  discarded: UnitValue[];
}

/** 全局共享的同步元数据，保存在 IndexedDB，所有标签页共用 */
export interface SyncMeta {
  /** 基线折叠版本，单调递增；越高代表已合入的内容越多 */
  baseRev: number;
  baseUpdatedAt: string;
  /** 基线变更单元快照：unit -> value，包含全部存活实体的完整字段 */
  base: Record<string, UnitValue>;
  /** 未决单元的显式裁决，研究员选择后才写入并在下一次对账时折叠 */
  resolutions: Record<string, Resolution>;
  /** 已完成裁决的历史凭据（被搁置的一方仍可查） */
  resolutionLog: ResolutionLogEntry[];
  /** 已折叠进共享基线的审计记录 */
  audit: AuditEntry[];
}

/** 标签页持久化记录：自己的追加日志 + 最近一次派生出的工作状态 */
export interface ClientRecord extends ClientRecordInfo {
  /** 未被折叠的变更：只包含仍处于未决（冲突）单元上的记录会在对账后保留 */
  changes: ChangeEntry[];
  /** 本标签页操作产生、等待折叠进共享审计的事件 */
  events: AuditEntry[];
  /** 最近派生的工作状态，便于重开后在对账完成前先渲染 */
  state: CodingState | null;
}

export interface ClientRecordInfo {
  clientId: string;
  label: string;
  createdAt: string;
  lastWriteAt: string;
  /** 该客户端曾经写入的最大序号，单调递增 */
  lastSeq: number;
}

export type ConflictScope = 'theme' | 'segment' | 'transcript' | 'meta';

export interface ConflictCandidate {
  clientId: string;
  value: UnitValue;
  at: string;
}

/** 待处理冲突：同一变更单元上两份或多份互不相同的结果全部保留 */
export interface PendingConflict {
  unit: string;
  scope: ConflictScope;
  /** 主题/片段/访谈 id；meta 类为空 */
  entityId: string;
  /** 字段键（name/definition/assign:A/note/__entity__ 等） */
  field: string;
  /** 字段中文名 */
  fieldLabel: string;
  /** 基线值（可能不存在，例如新建实体） */
  base: UnitValue;
  /** 除基线外互不相同的各方结果，双方（多方）都在此保留 */
  candidates: ConflictCandidate[];
}
