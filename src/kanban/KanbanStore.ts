/**
 * B1 看板数据模型与持久化（feishu-b1-m2-kanban-api-contract.md 冻结契约）
 *
 * 持久化模式复用 M1 SettingsProvider：原子写（temp+rename）+ 损坏备份重建 +
 * schema version 迁移。差异：看板变更内存态 + 防抖 500ms 写盘；写失败内存态保留。
 *
 * 核心职责：
 * - boards.json（<userData>/kanban/boards.json）读写 + 原子写 + 损坏重建 + 迁移
 * - 16 个 IPC 原语的数据层实现（B2/B3 消费；B3 同主进程直调）
 * - 业务规则：双轨（moveTask 不改 executionStatus）、Blocked 进出自动记/还原、
 *   删除守卫（running/queued 禁删 / board 含 ticket 拒删 / 最后看板不可删）、
 *   Q-028 评论删除权限、CON-R033 归档规则、dependencies 同父约束、auto 缺 AC 门控
 *
 * 红线：数据落 <userData>/kanban/boards.json，不触 DSH_HOME（CON-R002）。
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

import { HullError } from '../shared/errors';
import { NOOP_LOGGER, type RuntimeLogger } from '../shared/types';
import {
  DEFAULT_COLUMNS,
  DEFAULT_MAX_ATTACHMENT_SIZE_MB,
  KANBAN_B5_ERRORS,
  KANBAN_SCHEMA_VERSION,
  KANBAN_STORE_ERRORS,
  type AcceptanceCriteria,
  type Attachment,
  type Board,
  type Column,
  type ExecutionMode,
  type ImportMode,
  type ImportResult,
  type KanbanData,
  type Priority,
  type SubagentPolicy,
  type Task,
  type TimelineItem,
} from './types';

const ERR = KANBAN_STORE_ERRORS;

/** 看板目录名（<userData>/kanban/） */
const KANBAN_DIR = 'kanban';
/** boards.json 文件名 */
const BOARDS_FILE = 'boards.json';
/** 变更防抖写盘延迟（共识 §9：500ms） */
const DEBOUNCE_MS = 500;

/** 任务创建入参（B1 契约 createTask） */
export interface CreateTaskInput {
  title: string;
  columnId?: string;
  parentId?: string;
  executionMode?: ExecutionMode;
  acceptanceCriteria?: AcceptanceCriteria | null;
  dependencies?: string[];
  priority?: Priority;
  assignee?: string | null;
  dueDate?: string | null;
  labels?: string[];
  description?: string | null;
}

/** 任务部分更新字段（updateTask 白名单；系统管理字段不在内） */
export interface UpdateTaskPatch {
  title?: string;
  description?: string | null;
  labels?: string[];
  priority?: Priority;
  assignee?: string | null;
  dueDate?: string | null;
  acceptanceCriteria?: AcceptanceCriteria | null;
  executionMode?: ExecutionMode;
  dependencies?: string[];
}
/** 评论/附件入参（addComment） */
export interface AddCommentInput {
  boardId: string;
  taskId: string;
  content: string;
  attachments?: Attachment[];
}

export interface KanbanStoreOptions {
  /** Electron userData 目录（boards.json 落点 <userData>/kanban/boards.json） */
  userDataPath: string;
  /** 附件单文件上限（MB；CON-R024 默认 10） */
  maxAttachmentSizeMB?: number;
  /** 日志注入（默认 no-op） */
  logger?: RuntimeLogger;
  /** 测试注入：写盘失败钩子（原子写失败路径） */
  onWriteError?: (err: Error) => void;
}

function newId(prefix: string): string {
  return `${prefix}_${randomUUID()}`;
}

function nowIso(): string {
  return new Date().toISOString();
}

/** 生成默认看板（空看板自动建 6 态模板列，CON-R017） */
function makeDefaultBoard(name: string, order: number): Board {
  const ts = nowIso();
  return {
    id: newId('b'),
    name,
    columns: DEFAULT_COLUMNS.map((c) => ({ ...c })),
    tasks: [],
    order,
    createdAt: ts,
    updatedAt: ts,
  };
}

function makeDefaultData(): KanbanData {
  return { version: KANBAN_SCHEMA_VERSION, boards: [makeDefaultBoard('默认看板', 0)] };
}

export class KanbanStore {
  private readonly dir: string;
  private readonly filePath: string;
  private readonly logger: RuntimeLogger;
  private readonly maxAttachmentSizeMB: number;
  private readonly onWriteError?: (err: Error) => void;

  private data: KanbanData;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(options: KanbanStoreOptions) {
    this.dir = join(options.userDataPath, KANBAN_DIR);
    this.filePath = join(this.dir, BOARDS_FILE);
    this.logger = options.logger ?? NOOP_LOGGER;
    this.maxAttachmentSizeMB = options.maxAttachmentSizeMB ?? DEFAULT_MAX_ATTACHMENT_SIZE_MB;
    this.onWriteError = options.onWriteError;
    if (!existsSync(this.dir)) mkdirSync(this.dir, { recursive: true });
    this.data = this.load();
  }

  /** 销毁：清防抖 timer（测试/退出时调用，防异步写泄漏） */
  dispose(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
  }

  /** 内部：加载 boards.json（损坏 → 备份 corrupt-<ts> + 重建默认；version 不兼容 → 迁移/备份重建） */
  private load(): KanbanData {
    if (!existsSync(this.filePath)) return makeDefaultData();
    let raw: string;
    try {
      raw = readFileSync(this.filePath, 'utf8');
    } catch (err) {
      this.logger.warn(`boards.json 读取失败: ${(err as Error).message}（重建默认）`);
      return makeDefaultData();
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      return this.backupAndRebuild(`boards.json 解析失败: ${(err as Error).message}`);
    }
    const obj = parsed as Partial<KanbanData>;
    if (typeof obj.version !== 'number' || !Array.isArray(obj.boards)) {
      return this.backupAndRebuild('boards.json 缺 version/boards，视为损坏');
    }
    const version = obj.version;
    if (version < KANBAN_SCHEMA_VERSION) {
      try {
        const migrated = this.migrate({ version, boards: obj.boards as Board[] });
        this.data = migrated;
        this.flushNow();
        return migrated;
      } catch (err) {
        return this.backupAndRebuild(`boards.json 迁移失败: ${(err as Error).message}`);
      }
    }
    if (version > KANBAN_SCHEMA_VERSION) {
      // 更高版本文件：无法降级，走备份重建兜底
      return this.backupAndRebuild(`boards.json version ${version} 高于当前，重建默认`);
    }
    return { version, boards: obj.boards as Board[] };
  }

  /** 损坏/迁移失败兜底：备份 corrupt-<ts> + 重建默认看板（CON-R017） */
  private backupAndRebuild(reason: string): KanbanData {
    this.logger.warn(`${reason}（备份并重建默认看板）`);
    try {
      const ts = Date.now();
      renameSync(this.filePath, `${this.filePath}.corrupt-${ts}`);
    } catch {
      /* 备份失败无害 */
    }
    return makeDefaultData();
  }

  /**
   * schema 迁移（CON-R017）：version < 当前 → 逐版迁移到当前。
   * B1 契约当前仅 version=1；v1→当前无迁移函数（不兼容演进递增时才写）。
   * 未来新增迁移：在此按版本号递增补 transform（B5 契约 P2-B5-2 复用此 migrate）。
   */
  migrate(data: KanbanData): KanbanData {
    let current = { ...data, boards: data.boards.map((b) => ({ ...b, tasks: b.tasks.map((t) => ({ ...t })) })) };
    // v1 → v2 等：预留迁移链（YAGNI——当前无迁移函数）
    if (current.version > KANBAN_SCHEMA_VERSION) {
      throw new HullError(ERR.migrateFailed, `boards.json version ${current.version} 高于当前 schema`);
    }
    current.version = KANBAN_SCHEMA_VERSION;
    return current;
  }

  /** 立即原子写（temp+rename） */
  private flushNow(): void {
    try {
      writeFileSync(`${this.filePath}.tmp`, JSON.stringify(this.data), 'utf8');
      renameSync(`${this.filePath}.tmp`, this.filePath);
    } catch (err) {
      const e = err as Error;
      this.onWriteError?.(e);
      // 写失败 → 内存态保留，下次成功写重试（CON-R017）
      throw new HullError(ERR.ioError, `boards.json 写入失败: ${e.message}`);
    }
  }

  /** 防抖写盘（500ms；立即 flush 用于测试/迁移场景） */
  private scheduleFlush(): void {
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      this.flushNow();
    }, DEBOUNCE_MS);
  }

  /** 测试钩子：同步写盘（B1 K3/K2 断言持久化） */
  flushSync(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    this.flushNow();
  }

  // ─────────────────────────── 查询原语 ───────────────────────────

  getBoards(): Board[] {
    return this.data.boards.map((b) => structuredClone(b));
  }

  getBoard(boardId: string): Board {
    const board = this.data.boards.find((b) => b.id === boardId);
    if (!board) throw new HullError(ERR.notFound, '看板不存在（已删除）');
    return structuredClone(board);
  }

  getTasks(boardId: string): Task[] {
    const board = this.findBoard(boardId);
    return board.tasks.map((t) => structuredClone(t));
  }

  // ─────────────────────────── 看板原语 ───────────────────────────

  createBoard(name: string, columns?: Column[]): Board {
    if (!name || name.trim().length === 0) throw new HullError(ERR.validation, '看板名不能为空');
    if (name.length > 200) throw new HullError(ERR.validation, '看板名超长（≤200）');
    const order = this.data.boards.length > 0 ? Math.max(...this.data.boards.map((b) => b.order)) + 1 : 0;
    const board: Board = columns?.length
      ? {
          id: newId('b'),
          name,
          columns: columns.map((c) => ({ ...c })),
          tasks: [],
          order,
          createdAt: nowIso(),
          updatedAt: nowIso(),
        }
      : makeDefaultBoard(name, order);
    this.data.boards.push(board);
    this.scheduleFlush();
    return structuredClone(board);
  }

  updateBoard(boardId: string, patch: { name?: string; order?: number }): Board {
    const board = this.findBoard(boardId);
    if (patch.name !== undefined) {
      if (!patch.name.trim()) throw new HullError(ERR.validation, '看板名不能为空');
      if (patch.name.length > 200) throw new HullError(ERR.validation, '看板名超长（≤200）');
      board.name = patch.name;
    }
    if (patch.order !== undefined) board.order = patch.order;
    board.updatedAt = nowIso();
    this.scheduleFlush();
    return structuredClone(board);
  }

  deleteBoard(boardId: string): void {
    const board = this.findBoard(boardId);
    if (this.data.boards.length <= 1) {
      throw new HullError(ERR.validation, '最后一个看板不可删除（可改名）');
    }
    // 执行态守卫优先：看板内任务 running/queued 禁删（store-task-executing）
    const executing = board.tasks.some((t) => t.executionStatus === 'running' || t.executionStatus === 'queued');
    if (executing) {
      throw new HullError(ERR.taskExecuting, '看板内任务执行中，不可删除');
    }
    // CON-R033：看板含 ticket（含归档）→ 拒删
    if (board.tasks.length > 0) {
      throw new HullError(ERR.boardNotEmpty, '看板含 ticket（含归档），先清空全部 ticket');
    }
    this.data.boards = this.data.boards.filter((b) => b.id !== boardId);
    this.scheduleFlush();
  }

  // ─────────────────────────── 任务原语 ───────────────────────────

  createTask(boardId: string, input: CreateTaskInput): Task {
    const board = this.findBoard(boardId);
    this.validateTitle(input.title);
    const parentId = input.parentId ?? null;
    if (parentId) {
      // 单层嵌套：父卡必须是该看板内的顶层任务（非子任务）
      const parent = board.tasks.find((t) => t.id === parentId);
      if (!parent) throw new HullError(ERR.notFound, '父任务不存在');
      if (parent.parentId) throw new HullError(ERR.validation, '子任务不可再嵌套');
    }
    const columnId = input.columnId ?? 'c_todo';
    if (!board.columns.some((c) => c.id === columnId)) throw new HullError(ERR.validation, '目标列不存在');
    const executionMode: ExecutionMode = input.executionMode ?? 'manual';
    // CON-R018：auto 缺 AC 必填项门控
    if (executionMode === 'auto') this.validateAc(input.acceptanceCriteria);
    const dependencies = this.validateDependencies(board, parentId, input.dependencies ?? []);
    const now = nowIso();
    const task: Task = {
      id: newId('t'),
      parentId,
      columnId,
      title: input.title,
      executionMode,
      executionStatus: 'idle',
      currentExecutionId: null,
      acceptanceCriteria: input.acceptanceCriteria ?? null,
      agentSpec: { provider: 'dsh', agent: null, model: null, subagentPolicy: 'auto' as SubagentPolicy },
      dependencies,
      description: input.description ?? null,
      labels: input.labels ?? [],
      priority: input.priority ?? 'P2',
      assignee: input.assignee ?? null,
      dueDate: input.dueDate ?? null,
      order: this.nextOrder(board, columnId),
      blockedFromColumnId: null,
      archivedAt: null,
      archivedFromColumnId: null,
      createdAt: now,
      updatedAt: now,
      timeline: [this.systemEvent(`任务创建`)],
    };
    board.tasks.push(task);
    this.scheduleFlush();
    return structuredClone(task);
  }

  updateTask(boardId: string, taskId: string, patch: UpdateTaskPatch): Task {
    const board = this.findBoard(boardId);
    const task = this.findTask(board, taskId);
    if (patch.title !== undefined) {
      this.validateTitle(patch.title);
      task.title = patch.title;
    }
    if (patch.description !== undefined) task.description = patch.description;
    if (patch.labels !== undefined) task.labels = patch.labels;
    if (patch.priority !== undefined) task.priority = patch.priority;
    if (patch.assignee !== undefined) task.assignee = patch.assignee;
    if (patch.dueDate !== undefined) task.dueDate = patch.dueDate;
    if (patch.executionMode !== undefined) {
      // 切 auto 缺 AC 门控（CON-R018）
      if (patch.executionMode === 'auto') this.validateAc(patch.acceptanceCriteria ?? task.acceptanceCriteria);
      task.executionMode = patch.executionMode;
    }
    if (patch.acceptanceCriteria !== undefined) task.acceptanceCriteria = patch.acceptanceCriteria;
    if (patch.dependencies !== undefined) {
      task.dependencies = this.validateDependencies(board, task.parentId, patch.dependencies);
    }
    // 系统管理字段（executionStatus/currentExecutionId/timeline）不可经 updateTask 直接改（B3 调度层写）
    const sys = patch as unknown as Record<string, unknown>;
    if (
      'executionStatus' in sys ||
      'currentExecutionId' in sys ||
      'timeline' in sys ||
      'id' in sys ||
      'createdAt' in sys ||
      'columnId' in sys ||
      'archivedAt' in sys ||
      'archivedFromColumnId' in sys ||
      'blockedFromColumnId' in sys
    ) {
      throw new HullError(ERR.validation, 'executionStatus/currentExecutionId/timeline 为系统管理字段');
    }
    task.updatedAt = nowIso();
    this.scheduleFlush();
    return structuredClone(task);
  }

  /**
   * 移动任务到列（B1 契约 §8）：不改 executionStatus（双轨解耦 Q-013）；
   * 进 Blocked 自动记 blockedFromColumnId；解除 Blocked 自动还原来源列。
   */
  moveTask(boardId: string, taskId: string, toColumnId: string): Task {
    const board = this.findBoard(boardId);
    const task = this.findTask(board, taskId);
    const target = board.columns.find((c) => c.id === toColumnId);
    if (!target) throw new HullError(ERR.validation, '目标列不存在');
    const from = task.columnId;
    if (from === toColumnId) return structuredClone(task);
    // Blocked 语义（P2-4）
    if (toColumnId === 'c_blocked') {
      task.blockedFromColumnId = task.blockedFromColumnId ?? task.columnId;
    } else if (task.blockedFromColumnId) {
      // 解除 Blocked：来源列非隐藏 → 回来源列；已删/隐藏 → 回 Todo
      const src = board.columns.find((c) => c.id === task.blockedFromColumnId);
      if (src && !src.hidden && src.id !== 'c_blocked') {
        task.columnId = src.id;
      } else {
        task.columnId = 'c_todo';
      }
      task.blockedFromColumnId = null;
    } else {
      task.columnId = toColumnId;
    }
    task.updatedAt = nowIso();
    task.timeline.push(this.systemEvent(`${from}→${task.columnId}`));
    this.scheduleFlush();
    return structuredClone(task);
  }

  /**
   * 删除任务（级联子任务 + 评论/附件引用；Q-019）。
   * 执行态守卫：任务或子任务 running/queued → 禁删（store-task-executing）。
   */
  deleteTask(boardId: string, taskId: string): void {
    const board = this.findBoard(boardId);
    const task = this.findTask(board, taskId);
    const all = [task, ...board.tasks.filter((t) => t.parentId === taskId)];
    for (const t of all) {
      if (t.executionStatus === 'running' || t.executionStatus === 'queued') {
        throw new HullError(ERR.taskExecuting, '任务执行中，不可删除');
      }
    }
    const removed = new Set(all.map((t) => t.id));
    board.tasks = board.tasks.filter((t) => !removed.has(t.id));
    // 清理其他子任务 dependencies 对该任务的引用（Q-019）
    for (const t of board.tasks) {
      if (t.dependencies.some((d) => removed.has(d))) {
        t.dependencies = t.dependencies.filter((d) => !removed.has(d));
        t.updatedAt = nowIso();
      }
    }
    this.scheduleFlush();
  }

  // ─────────────────────────── 评论原语 ───────────────────────────

  addComment(input: AddCommentInput): Task {
    const board = this.findBoard(input.boardId);
    const task = this.findTask(board, input.taskId);
    if (!input.content || !input.content.trim()) throw new HullError(ERR.validation, '评论内容不能为空');
    if (input.attachments) {
      for (const a of input.attachments) {
        if (a.size > this.maxAttachmentSizeMB * 1024 * 1024) {
          throw new HullError(ERR.validation, `附件超限（≤${this.maxAttachmentSizeMB}MB）`);
        }
      }
    }
    const item: TimelineItem = {
      id: newId('tl'),
      type: 'comment',
      content: input.content,
      attachments: input.attachments ?? [],
      createdAt: nowIso(),
      author: 'user',
      source: { type: 'user', provider: 'dsh' },
      execution: null,
    };
    task.timeline.push(item);
    task.updatedAt = nowIso();
    this.scheduleFlush();
    return structuredClone(task);
  }

  /** 删除评论（Q-028：仅 user 评论可删；agent 评论只读不可删） */
  deleteComment(boardId: string, taskId: string, commentId: string): void {
    const board = this.findBoard(boardId);
    const task = this.findTask(board, taskId);
    const item = task.timeline.find((t) => t.id === commentId);
    if (!item) throw new HullError(ERR.notFound, '评论不存在（已删除）');
    if (item.type !== 'comment' || item.source.type !== 'user') {
      throw new HullError(ERR.validation, 'agent/system 条目只读，不可删除');
    }
    task.timeline = task.timeline.filter((t) => t.id !== commentId);
    task.updatedAt = nowIso();
    this.scheduleFlush();
  }

  // ─────────────────────────── 列原语 ───────────────────────────

  updateColumn(boardId: string, columnId: string, patch: { name?: string; order?: number; color?: string; hidden?: boolean }): Column {
    const board = this.findBoard(boardId);
    const col = board.columns.find((c) => c.id === columnId);
    if (!col) throw new HullError(ERR.notFound, '列不存在');
    if (patch.name !== undefined) {
      if (!patch.name.trim()) throw new HullError(ERR.validation, '列名不能为空');
      if (patch.name.length > 200) throw new HullError(ERR.validation, '列名超长（≤200）');
      col.name = patch.name;
    }
    if (patch.order !== undefined) col.order = patch.order;
    if (patch.color !== undefined) col.color = patch.color;
    if (patch.hidden !== undefined) col.hidden = patch.hidden;
    board.updatedAt = nowIso();
    this.scheduleFlush();
    return structuredClone(col);
  }

  /** 删除自定义列（列内卡片移入 Todo）；模板列拒绝 */
  deleteColumn(boardId: string, columnId: string): void {
    const board = this.findBoard(boardId);
    const col = board.columns.find((c) => c.id === columnId);
    if (!col) throw new HullError(ERR.notFound, '列不存在');
    if (col.type) throw new HullError(ERR.validation, '模板列不可删除');
    board.columns = board.columns.filter((c) => c.id !== columnId);
    for (const t of board.tasks) {
      if (t.columnId === columnId) t.columnId = 'c_todo';
    }
    board.updatedAt = nowIso();
    this.scheduleFlush();
  }

  // ─────────────────────────── 归档原语（CON-R033） ───────────────────────────

  /** 归档 Done ticket → 归档区 */
  archiveTask(boardId: string, taskId: string): Task {
    const board = this.findBoard(boardId);
    const task = this.findTask(board, taskId);
    if (task.columnId !== 'c_done') {
      throw new HullError(ERR.validation, '仅 Done 列任务可归档');
    }
    task.archivedAt = nowIso();
    task.archivedFromColumnId = task.columnId;
    task.updatedAt = nowIso();
    task.timeline.push(this.systemEvent('已归档'));
    this.scheduleFlush();
    return structuredClone(task);
  }

  /** 恢复归档 ticket（回原列 archivedFromColumnId，已删/隐藏则回 Done） */
  restoreTask(boardId: string, taskId: string, toColumnId?: string): Task {
    const board = this.findBoard(boardId);
    const task = this.findTask(board, taskId);
    if (!task.archivedAt) throw new HullError(ERR.validation, '任务未归档');
    let target = toColumnId;
    if (target === undefined) {
      const src = task.archivedFromColumnId ? board.columns.find((c) => c.id === task.archivedFromColumnId) : undefined;
      target = src && !src.hidden ? src.id : 'c_done';
    }
    if (!board.columns.some((c) => c.id === target)) throw new HullError(ERR.validation, '恢复目标列不存在');
    task.columnId = target;
    task.archivedAt = null;
    task.archivedFromColumnId = null;
    task.updatedAt = nowIso();
    task.timeline.push(this.systemEvent('已恢复'));
    this.scheduleFlush();
    return structuredClone(task);
  }

  /** 彻底删除归档 ticket（级联清 timeline/附件/executions log 引用） */
  purgeTask(boardId: string, taskId: string): void {
    const board = this.findBoard(boardId);
    const task = this.findTask(board, taskId);
    if (!task.archivedAt) throw new HullError(ERR.validation, '仅归档区任务可彻底删除');
    // 级联清理：归档任务无子任务（Done 后归档），清自身 timeline + 附件引用
    board.tasks = board.tasks.filter((t) => t.id !== taskId);
    this.scheduleFlush();
  }

  // ─────────────────────────── 校验与工具 ───────────────────────────

  private findBoard(boardId: string): Board {
    const board = this.data.boards.find((b) => b.id === boardId);
    if (!board) throw new HullError(ERR.notFound, '看板不存在（已删除）');
    return board;
  }

  private findTask(board: Board, taskId: string): Task {
    const task = board.tasks.find((t) => t.id === taskId);
    if (!task) throw new HullError(ERR.notFound, '任务不存在（已删除）');
    return task;
  }

  private validateTitle(title: string): void {
    if (!title || title.trim().length === 0) throw new HullError(ERR.validation, '标题不能为空');
    if (title.length > 200) throw new HullError(ERR.validation, '标题超长（≤200）');
  }

  /** CON-R018：auto 模式 AC 四字段强校验必填 */
  private validateAc(ac: AcceptanceCriteria | null | undefined): void {
    if (!ac || !ac.what?.trim() || !ac.expected?.trim() || !ac.verify?.trim()) {
      throw new HullError(ERR.validation, 'auto 模式需填完整验收标准（what/expected/verify）');
    }
  }

  /** Q-014：dependencies 仅子任务可声明（同父下）且引用存在 */
  private validateDependencies(board: Board, parentId: string | null, deps: string[]): string[] {
    if (!parentId) {
      if (deps.length > 0) throw new HullError(ERR.validation, '仅子任务可声明依赖');
      return [];
    }
    for (const d of deps) {
      const dep = board.tasks.find((t) => t.id === d);
      if (!dep) throw new HullError(ERR.validation, `依赖任务不存在: ${d}`);
      if (dep.parentId !== parentId) throw new HullError(ERR.validation, '依赖仅限同父子任务');
      if (d === parentId) throw new HullError(ERR.validation, '依赖不能指向父任务');
    }
    return deps;
  }

  private nextOrder(board: Board, columnId: string): number {
    const inColumn = board.tasks.filter((t) => t.columnId === columnId);
    return inColumn.length > 0 ? Math.max(...inColumn.map((t) => t.order)) + 1 : 0;
  }

  private systemEvent(content: string): TimelineItem {
    return {
      id: newId('tl'),
      type: 'system',
      content,
      attachments: [],
      createdAt: nowIso(),
      author: 'system',
      source: { type: 'system' },
      execution: null,
    };
  }

  /** B5 导出快照（boards.json 裸快照） */
  snapshot(): KanbanData {
    return structuredClone(this.data);
  }

  /** 看板数据目录（<userData>/kanban；B5 传输层默认导出路径） */
  getDataDir(): string {
    return this.dir;
  }

  // ─────────────────────────── B5 导出/导入（校验/重映射/应用） ───────────────────────────

  /**
   * 导出快照（单看板/全看板）。boardId 缺省 = 全看板；空 boards 合法。
   * 校验 boardId 格式（b_<uuid>，B5 契约 export 异常集）。
   */
  exportSnapshot(boardId?: string): KanbanData {
    let boards: Board[];
    if (boardId !== undefined) {
      if (typeof boardId !== 'string' || !/^b_[0-9a-fA-F-]{36}$/.test(boardId)) {
        throw new HullError(ERR_B5.validation, 'boardId 格式非法');
      }
      const board = this.data.boards.find((b) => b.id === boardId);
      if (!board) throw new HullError(ERR_B5.exportNotFound, '看板不存在（已删除）');
      boards = [board];
    } else {
      boards = this.data.boards;
    }
    return { version: this.data.version, boards: structuredClone(boards) };
  }

  /**
   * 导入（合并/替换），两段式：校验全过 → 原子应用（B5 契约 P0-B5-1）。
   * - 校验阶段在导入文件原始 id 空间执行：JSON/版本/结构/字段/附件上限/跨现有看板引用。
   * - merge：冲突板重 id + 内部引用重映射 → 重申 B1 完整校验（P1-B5-1）→ 追加。
   * - replace：先备份 boards.preimport-<ts> 再整文件替换。
   * 任何失败 → HullError（import 系 / validation-error / store-io-error），现有数据零改动。
   */
  importData(data: KanbanData, mode: ImportMode): ImportResult {
    if (mode !== 'merge' && mode !== 'replace') {
      throw new HullError(ERR_B5.importModeInvalid, 'mode 非法（merge/replace）');
    }
    const validated = this.validateImportData(data);
    const boardsImported = validated.boards.length;
    const tasksImported = validated.boards.reduce((n, b) => n + b.tasks.length, 0);
    let next: KanbanData;
    let preserved: string[] = [];
    let regenerated: string[] = [];
    if (mode === 'merge') {
      const { boards: remapped, regenerated: regen } = this.remapMerge(validated.boards);
      // P1-B5-1：重映射后重申 B1 完整校验（重映射可能产生跨父依赖等约束违例）
      this.validateBoardsStructure(remapped);
      preserved = remapped.filter((b) => !regen.includes(b.id)).map((b) => b.id);
      regenerated = regen;
      next = { version: this.data.version, boards: [...this.data.boards, ...remapped] };
    } else {
      // replace：先备份 boards.preimport-<ts> 再整文件替换（CON-R017；失败后备份可手动还原 P2-B5-3）
      this.backupPreimport();
      next = { version: this.data.version, boards: validated.boards };
      preserved = validated.boards.map((b) => b.id);
    }
    this.applyData(next);
    return {
      applied: { mode, boardsImported, tasksImported },
      ids: { preserved, regenerated },
    };
  }

  /**
   * 导入校验阶段（原始 id 空间）：顶层结构 → version 兼容 → 文件内部引用 →
   * 结构完整性 → B1 schema 字段 → 附件上限 → 跨现有看板引用拒绝。
   */
  validateImportData(data: KanbanData): { boards: Board[]; conflicts: Set<string> } {
    if (data === null || typeof data !== 'object') {
      throw new HullError(ERR_B5.importCorrupt, '文件损坏，非看板导出文件');
    }
    const obj = data as Partial<KanbanData>;
    if (typeof obj.version !== 'number' || !Array.isArray(obj.boards)) {
      throw new HullError(ERR_B5.importCorrupt, '文件损坏，缺 version/boards 或类型错误');
    }
    // version 兼容：过新拒绝；过旧走 B1 migrate()（P2-B5-2 复用，无迁移函数可到当前则拒绝）
    let version = obj.version;
    if (version > KANBAN_SCHEMA_VERSION) {
      throw new HullError(ERR_B5.importVersionNewer, `导出文件 version ${version} 高于当前，请升级壳`);
    }
    let boards: Board[];
    if (version < KANBAN_SCHEMA_VERSION) {
      try {
        boards = this.migrate({ version, boards: obj.boards as Board[] }).boards;
      } catch {
        throw new HullError(ERR_B5.importVersionOlder, `导出文件 version ${version} 过旧，无法迁移`);
      }
    } else {
      boards = obj.boards as Board[];
    }
    // ① 文件内部引用完整性 + ③ 结构完整性（columnId/parentId/dependencies/archivedFromColumnId/blockedFromColumnId 指向文件内；currentExecutionId 仅格式校验 🔴-1）
    this.validateBoardsStructure(boards);
    // ④ B1 schema 字段合法性 + ⑤ 附件上限（CON-R024）
    const allTasks = boards.flatMap((b) => b.tasks);
    for (const t of allTasks) this.validateImportedTask(t);
    // ② 跨现有看板引用（P0-B5-1）：导入任务引用现有看板**任务** id（文件内无法解析的悬挂引用）→ 一律拒绝。
    // currentExecutionId 不查（🔴-1）：Q-023 下 markSucceeded 不清 currentExecutionId（B3 e_<seq> 记录引用），
    // 不一定指向文件内 timeline，跨板拒绝语义不适用，仅格式校验。
    // 注：columnId 不查——结构校验已保证指向文件内列，模板列 id（c_todo 等）为全看板共享约定，非跨板引用。
    const fileTaskIds = new Set<string>(allTasks.map((t) => t.id));
    const existingIds = new Set<string>(this.data.boards.flatMap((b) => [b.id, ...b.columns.map((c) => c.id), ...b.tasks.map((t) => t.id)]));
    for (const t of allTasks) {
      if (t.parentId && !fileTaskIds.has(t.parentId) && existingIds.has(t.parentId)) {
        throw new HullError(ERR_B5.validation, `跨现有看板引用被拒绝（parentId=${t.parentId}）`);
      }
      for (const d of t.dependencies) {
        if (!fileTaskIds.has(d) && existingIds.has(d)) throw new HullError(ERR_B5.validation, `跨现有看板引用被拒绝（dependencies=${d}）`);
      }
    }
    // merge 冲突集合：导入板 id 与现有看板 id 重复
    const existingBoardIds = new Set(this.data.boards.map((b) => b.id));
    const conflicts = new Set<string>(boards.filter((b) => existingBoardIds.has(b.id)).map((b) => b.id));
    return { boards, conflicts };
  }

  /** 结构完整性 + 文件内部引用：列/父任务/依赖/归档来源列/Blocked 来源列均指向文件内，B1 约束（dependencies 仅子任务、同父、非父自身）。currentExecutionId 仅格式校验（🔴-1，Q-023 记录引用可不指向文件内 timeline） */
  private validateBoardsStructure(boards: Board[]): void {
    for (const b of boards) {
      const colIds = new Set(b.columns.map((c) => c.id));
      const allTaskIds = new Set(b.tasks.map((t) => t.id));
      for (const t of b.tasks) {
        // parentId：非空 → 指向文件内任务
        if (t.parentId !== null && t.parentId !== undefined && !allTaskIds.has(t.parentId)) {
          throw new HullError(ERR_B5.validation, `父任务引用不存在（task=${t.id}, parentId=${t.parentId}）`);
        }
        // columnId 指向文件内列
        if (!colIds.has(t.columnId)) {
          throw new HullError(ERR_B5.validation, `任务列引用不存在（task=${t.id}, columnId=${t.columnId}）`);
        }
        // 单层嵌套：parent 非子任务
        const parent = b.tasks.find((x) => x.id === t.parentId);
        if (parent?.parentId) {
          throw new HullError(ERR_B5.validation, '子任务不可再嵌套（task=' + t.id + '）');
        }
        // dependencies：仅子任务声明、指向文件内、同父下、非父自身
        if (t.parentId === null || t.parentId === undefined) {
          if (t.dependencies.length > 0) {
            throw new HullError(ERR_B5.validation, `仅子任务可声明依赖（task=${t.id}）`);
          }
        } else {
          for (const d of t.dependencies) {
            if (!allTaskIds.has(d)) {
              throw new HullError(ERR_B5.validation, `依赖任务不存在（task=${t.id}, dep=${d}）`);
            }
            const dep = b.tasks.find((x) => x.id === d);
            if (!dep || dep.parentId !== t.parentId) {
              throw new HullError(ERR_B5.validation, '依赖仅限同父子任务（task=' + t.id + '）');
            }
            if (d === t.parentId) {
              throw new HullError(ERR_B5.validation, '依赖不能指向父任务（task=' + t.id + '）');
            }
          }
        }
        // 归档/Blocked 来源列：非空 → 指向文件内列；currentExecutionId → 仅格式校验（null 合法 / 非空须 /^(e_|tl_)/，🔴-1：Q-023 下 succeeded 卡保留 e_<seq> 记录引用，不要求指向文件内 timeline）
        if (t.archivedFromColumnId !== null && t.archivedFromColumnId !== undefined && !colIds.has(t.archivedFromColumnId)) {
          throw new HullError(ERR_B5.validation, `归档来源列不存在（task=${t.id}）`);
        }
        if (t.blockedFromColumnId !== null && t.blockedFromColumnId !== undefined && !colIds.has(t.blockedFromColumnId)) {
          throw new HullError(ERR_B5.validation, `Blocked 来源列不存在（task=${t.id}）`);
        }
        if (t.currentExecutionId !== null && t.currentExecutionId !== undefined) {
          if (!/^(e_|tl_)/.test(t.currentExecutionId)) {
            throw new HullError(ERR_B5.validation, `currentExecutionId 格式非法（须 e_/tl_ 前缀，task=${t.id}）`);
          }
        }
      }
    }
  }

  /** B1 schema 字段校验（导入路径；附件上限 CON-R024） */
  private validateImportedTask(t: Task): void {
    if (!t.id || typeof t.id !== 'string') throw new HullError(ERR_B5.validation, '任务 id 非法');
    if (!t.title || t.title.trim().length === 0) throw new HullError(ERR_B5.validation, '任务标题不能为空');
    if (t.title.length > 200) throw new HullError(ERR_B5.validation, '任务标题超长（≤200）');
    if (t.executionMode === 'auto') this.validateAc(t.acceptanceCriteria);
    for (const tl of t.timeline ?? []) {
      for (const a of tl.attachments ?? []) {
        if (a.size > this.maxAttachmentSizeMB * 1024 * 1024) {
          throw new HullError(ERR_B5.validation, `附件超限（≤${this.maxAttachmentSizeMB}MB）`);
        }
      }
    }
  }

  /** merge：仅冲突板重 id + 内部全部 id（列/任务/timeline）重映射 + 引用（parentId/dependencies/currentExecutionId/blockedFromColumnId/archivedFromColumnId）同步重映射；非冲突板保留原 id。返回 { boards, regenerated } */
  private remapMerge(boards: Board[]): { boards: Board[]; regenerated: string[] } {
    const boardIdMap = new Map<string, string>();
    for (const b of boards) {
      if (this.data.boards.some((x) => x.id === b.id)) {
        boardIdMap.set(b.id, newId('b'));
      }
    }
    const remapped = boards.map((b) => {
      // 非冲突板：原样返回（id 保留，引用无需重映射）
      if (!boardIdMap.has(b.id)) return structuredClone(b);
      const newBoardId = boardIdMap.get(b.id)!;
      const colMap = new Map<string, string>();
      const taskMap = new Map<string, string>();
      const tlMap = new Map<string, string>();
      const columns = b.columns.map((c) => {
        const next = colMap.get(c.id) ?? newId('c');
        colMap.set(c.id, next);
        return { ...c, id: next };
      });
      const tasks = b.tasks.map((t) => {
        const nextTask = taskMap.get(t.id) ?? newId('t');
        taskMap.set(t.id, nextTask);
        const timeline = t.timeline.map((tl) => {
          const nextTl = tlMap.get(tl.id) ?? newId('tl');
          tlMap.set(tl.id, nextTl);
          return { ...tl, id: nextTl };
        });
        return { ...t, id: nextTask, timeline };
      });
      return {
        ...b,
        id: newBoardId,
        columns,
        tasks: tasks.map((t) => ({
          ...t,
          parentId: t.parentId ? taskMap.get(t.parentId) ?? t.parentId : null,
          columnId: colMap.get(t.columnId) ?? t.columnId,
          dependencies: t.dependencies.map((d) => taskMap.get(d) ?? d),
          currentExecutionId: t.currentExecutionId ? tlMap.get(t.currentExecutionId) ?? t.currentExecutionId : null,
          blockedFromColumnId: t.blockedFromColumnId ? colMap.get(t.blockedFromColumnId) ?? t.blockedFromColumnId : null,
          archivedFromColumnId: t.archivedFromColumnId ? colMap.get(t.archivedFromColumnId) ?? t.archivedFromColumnId : null,
        })),
      };
    });
    return { boards: remapped, regenerated: [...boardIdMap.values()] };
  }

  /** 应用阶段：整文件原子写（temp+rename，复用 B1 flushNow 语义；失败 store-io-error 原数据不破坏） */
  private applyData(data: KanbanData): void {
    const prev = this.data;
    this.data = data;
    try {
      this.flushNow();
    } catch (err) {
      this.data = prev; // 写失败回滚内存态，现有数据零改动（CON-R017）
      throw err;
    }
  }

  /** replace 备份：boards.preimport-<ts>.json（B5 契约 §落盘；与 B1 损坏备份 boards.json.corrupt-<ts> 命名区分） */
  private backupPreimport(): void {
    try {
      const ts = Date.now();
      writeFileSync(`${this.filePath}.preimport-${ts}`, JSON.stringify(this.data), 'utf8');
    } catch (err) {
      // 备份失败 → 拒绝整个 replace（无备份即不可还原，CON-R017 保护）
      throw new HullError(ERR_B5.ioError, `replace 备份失败，已中止导入: ${(err as Error).message}`);
    }
  }
}

const ERR_B5 = KANBAN_B5_ERRORS;
