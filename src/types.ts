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

// —— 字段级同步模型 ——
// 每个“变更单元”（主题的名称/层级/定义/示例，片段的 A 判断/B 判断/备忘…）
// 都是独立合并单位：不同单元互不影响，同一单元意见不一致时两份结果都保留。

export type UnitKind =
  | 'theme.exists'
  | 'theme.name'
  | 'theme.parentId'
  | 'theme.definition'
  | 'theme.memo'
  | 'theme.examples'
  | 'segment.exists'
  | 'segment.assignA'
  | 'segment.assignB'
  | 'segment.note'
  | 'segment.speaker'
  | 'segment.time'
  | 'segment.text'
  | 'segment.order'
  | 'segment.transcriptId'
  | 'transcript.exists'
  | 'transcript.title'
  | 'transcript.participant'
  | 'transcript.sourceName'
  | 'project.coderA'
  | 'project.coderB';

export type UnitValue = string | string[] | boolean | number | null;

/** 某一条冲突意见：来自哪个副本（标签页），值是什么 */
export interface ConflictOpinion {
  writerId: string;
  label: string;
  value: UnitValue;
}

/** 未处理冲突：同一单元出现 ≥2 种不同意见，两份结果都保留，等研究者选择 */
export interface PendingConflict {
  id: string;
  kind: UnitKind;
  entityId: string;
  entityLabel: string;
  fieldLabel: string;
  baseValue: UnitValue;
  opinions: ConflictOpinion[];
  createdAt: string;
}

/** 已明确选择的处理结果 */
export interface Resolution {
  id: string;
  conflictId: string;
  kind: UnitKind;
  entityId: string;
  chosenValue: UnitValue;
  rejectedValues: UnitValue[];
  writerId: string;
  at: string;
}

export interface ResolutionRecord extends Resolution {
  entityLabel: string;
  fieldLabel: string;
}

/** 全局同步账本：所有标签页共用，IndexedDB 持久化（断网/重开浏览器后保留） */
export interface SyncMeta {
  version: number;
  updatedAt: string;
  pendingConflicts: PendingConflict[];
  resolutions: ResolutionRecord[];
  writerLabels: Record<string, string>;
}

/** 一个标签页（写作副本）的文档，断线期间本地改动留在其中 */
export interface ReplicaDoc {
  writerId: string;
  /** 本副本当前工作状态（含尚未合并的本地改动） */
  state: CodingState;
  /** 本副本上次采纳的合并基线，用于三方合并判定“本副本改了哪些单元” */
  forkBase: CodingState;
  lastSeen: string;
}

export interface SyncBundle {
  meta: SyncMeta;
  base: CodingState;
  replicas: ReplicaDoc[];
}

/** 兼容旧版本一次性快照 */
export interface PersistedEnvelope {
  revision: number;
  updatedAt: string;
  writerId: string;
  state: CodingState;
}
