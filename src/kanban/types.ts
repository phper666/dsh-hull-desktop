/**
 * B1 看板数据模型（feishu-b1-m2-kanban-api-contract.md JSON Schema）
 * 字段唯一事实源 = B1 契约；本文件为 TS 类型镜像。
 */

/** schema 版本（B1 契约 + T2 增量：v2 起 Task 携带 startDate；不兼容演进递增 + 迁移函数） */
export const KANBAN_SCHEMA_VERSION = 2;

/** 模板列类型（6 态；仅模板列有 type，唯一不可删） */
export type ColumnType = 'backlog' | 'todo' | 'in_progress' | 'verify' | 'done' | 'blocked';

/** 执行模式（CON-R018） */
export type ExecutionMode = 'manual' | 'auto';

/** 执行生命周期（Q-013 8 态；与 columnId 双轨解耦） */
export type ExecutionStatus =
  | 'idle'
  | 'queued'
  | 'running'
  | 'paused'
  | 'interrupted'
  | 'cancelled'
  | 'failed'
  | 'succeeded';

/** 优先级（P0/P1/P2/无，默认 P2） */
export type Priority = 'P0' | 'P1' | 'P2' | '无';

/** timeline 来源类型（CON-R025） */
export type SourceType = 'user' | 'agent' | 'system';

/** timeline 条目类型 */
export type TimelineType = 'comment' | 'execution' | 'system';

/** 子 agent 策略（CON-R030） */
export type SubagentPolicy = 'auto' | 'restricted';

export interface AgentSpec {
  /** 默认 'dsh'，预留多 agent 平台 */
  provider: string;
  agent: string | null;
  model: string | null;
  /** 默认 'auto' */
  subagentPolicy: SubagentPolicy;
}

export interface AcceptanceCriteria {
  what: string;
  expected: string;
  verify: string;
  context?: string;
}

export interface Attachment {
  name: string;
  size: number;
  /** 相对路径 kanban/attachments/tl_<uuid>/<file> */
  path: string;
}

export interface ExecutionRecord {
  status: 'queued' | 'running' | 'succeeded' | 'failed' | 'paused' | 'interrupted' | 'cancelled';
  command: string;
  /** ISO 8601 UTC（Q-025：执行开始即写） */
  startedAt: string;
  /** ISO 8601 UTC（Q-025：完成补） */
  finishedAt: string | null;
  exitCode: number | null;
  /** 相对路径 kanban/executions/e_<uuid>.log */
  outputPath: string | null;
  selfCheck: { passed: boolean; evidence?: string } | null;
}

export interface TimelineItem {
  id: string;
  type: TimelineType;
  content: string;
  attachments: Attachment[];
  createdAt: string;
  author: string | null;
  source: { type: SourceType; agentId?: string; provider?: string };
  /** type=execution 时携带 */
  execution: ExecutionRecord | null;
}

export interface Task {
  id: string;
  /** 非空即子任务（指向父任务 id）；单层嵌套 */
  parentId: string | null;
  columnId: string;
  title: string;
  executionMode: ExecutionMode;
  executionStatus: ExecutionStatus;
  currentExecutionId: string | null;
  acceptanceCriteria: AcceptanceCriteria | null;
  agentSpec: AgentSpec;
  dependencies: string[];
  description: string | null;
  labels: string[];
  priority: Priority;
  assignee: string | null;
  dueDate: string | null;
  /** 计划开始日期（ISO YYYY-MM-DD，与 dueDate 同型可空；T2 契约 FR-3/Q-052） */
  startDate: string | null;
  order: number;
  /** Blocked 来源列；解除时恢复（来源列已删/隐藏则回 Todo） */
  blockedFromColumnId: string | null;
  /** 空=未归档；非空=在归档区（CON-R033） */
  archivedAt: string | null;
  /** 归档前所在列；恢复用（回原列或 Done） */
  archivedFromColumnId: string | null;
  createdAt: string;
  updatedAt: string;
  timeline: TimelineItem[];
}

export interface Column {
  id: string;
  /** 仅模板列有；唯一不可删 */
  type: ColumnType | null;
  name: string;
  order: number;
  /** 十六进制色值 */
  color: string;
  /** 隐藏=过滤，数据保留（Q-027） */
  hidden: boolean;
}

export interface Board {
  id: string;
  name: string;
  columns: Column[];
  tasks: Task[];
  order: number;
  createdAt: string;
  updatedAt: string;
}

/** boards.json 顶层（多项目看板 CON-R031） */
export interface KanbanData {
  version: number;
  boards: Board[];
}

/** 附件默认上限（CON-R024：maxAttachmentSizeMB 默认 10） */
export const DEFAULT_MAX_ATTACHMENT_SIZE_MB = 10;

/** 默认 6 态模板列（B1 契约最小 boards.json 示例） */
export const DEFAULT_COLUMNS: ReadonlyArray<Readonly<Column>> = [
  { id: 'c_backlog', type: 'backlog', name: 'Backlog', order: 0, color: '#8b949e', hidden: false },
  { id: 'c_todo', type: 'todo', name: 'Todo', order: 1, color: '#58a6ff', hidden: false },
  { id: 'c_in_progress', type: 'in_progress', name: 'In Progress', order: 2, color: '#d29922', hidden: false },
  { id: 'c_verify', type: 'verify', name: 'Verify', order: 3, color: '#a371f7', hidden: false },
  { id: 'c_done', type: 'done', name: 'Done', order: 4, color: '#3fb950', hidden: false },
  { id: 'c_blocked', type: 'blocked', name: 'Blocked', order: 5, color: '#f85149', hidden: false },
];

/** B1 看板错误码（KANBAN_STORE_ERROR 7 错误码） */
export const KANBAN_STORE_ERRORS = {
  ioError: 'store-io-error',
  corrupt: 'store-corrupt',
  migrateFailed: 'store-migrate-failed',
  notFound: 'store-not-found',
  taskExecuting: 'store-task-executing',
  boardNotEmpty: 'store-board-not-empty',
  validation: 'validation-error',
} as const;

/**
 * B5 导出/导入错误码（KANBAN_EXPORT_ERROR + KANBAN_IMPORT_ERROR，feishu-b5-m2 契约 §公共异常集）。
 * validation-error / store-io-error / store-not-found 与 B1 同码复用。
 */
export const KANBAN_B5_ERRORS = {
  exportIo: 'export-io-error',
  exportNotFound: 'export-not-found',
  importInvalidJson: 'import-invalid-json',
  importCorrupt: 'import-corrupt',
  importVersionNewer: 'import-version-newer',
  importVersionOlder: 'import-version-older',
  importModeInvalid: 'import-mode-invalid',
  validation: 'validation-error',
  ioError: 'store-io-error',
  notFound: 'store-not-found',
} as const;

/** 导入模式枚举（B5 契约 §导入模式枚举） */
export type ImportMode = 'merge' | 'replace';

/** 导入成功响应（B5 契约 §ImportResult） */
export interface ImportResult {
  applied: { mode: ImportMode; boardsImported: number; tasksImported: number };
  ids: { preserved: string[]; regenerated: string[] };
}
