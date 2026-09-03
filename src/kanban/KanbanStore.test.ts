import { test, after } from 'node:test';
import { equal, ok, throws } from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { HullError } from '../shared/errors';
import { KanbanStore } from './KanbanStore';
import { KANBAN_SCHEMA_VERSION, KANBAN_STORE_ERRORS, type KanbanData } from './types';

const tempDirs: string[] = [];
after(() => {
  for (const d of tempDirs) rmSync(d, { recursive: true, force: true });
});

function makeStore(files: Record<string, string> = {}, opts: { maxAttachmentSizeMB?: number; onWriteError?: (e: Error) => void; cls?: new (o: ConstructorParameters<typeof KanbanStore>[0]) => KanbanStore } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'hull-kanban-'));
  tempDirs.push(dir);
  for (const [name, content] of Object.entries(files)) {
    // 支持嵌套路径（kanban/boards.json）
    const seg = name.split('/');
    const dirs = seg.slice(0, -1);
    let cur = dir;
    for (const d of dirs) {
      cur = join(cur, d);
      if (!existsSync(cur)) mkdirSync(cur);
    }
    writeFileSync(join(dir, name), content);
  }
  const logger = { info() {}, warn() {}, error() {}, dshLog() {} };
  const store = new (opts.cls ?? KanbanStore)({ userDataPath: dir, logger, maxAttachmentSizeMB: opts.maxAttachmentSizeMB, onWriteError: opts.onWriteError });
  cleanup.push(() => store.dispose());
  return { store, dir, filePath: join(dir, 'kanban', 'boards.json') };
}

const cleanup: Array<() => void> = [];
after(() => {
  for (const fn of cleanup) fn();
  for (const d of tempDirs) rmSync(d, { recursive: true, force: true });
});

// ─────────────────────── K1 多项目看板 ───────────────────────
test('K1 多项目看板创建/切换：2 看板独立列/任务', () => {
  const { store } = makeStore();
  const b1 = store.createBoard('项目A');
  const b2 = store.createBoard('项目B');
  equal(store.getBoards().length, 3, '默认看板 + 2 新建');
  // 各 Board 独立列
  store.createTask(b1.id, { title: 'A任务' });
  store.createTask(b2.id, { title: 'B任务' });
  equal(store.getTasks(b1.id).length, 1);
  equal(store.getTasks(b2.id).length, 1);
  equal(store.getTasks(store.getBoards()[0].id).length, 0, '默认看板独立');
  // 默认 6 态模板列
  const cols = store.getBoard(b1.id).columns;
  equal(cols.length, 6);
  ok(cols.some((c) => c.type === 'backlog' && c.id === 'c_backlog'));
});

// ─────────────────────── K2 卡片 CRUD 持久化 ───────────────────────
test('K2 卡片 CRUD 持久化：createTask→updateTask→flushSync→重启完整恢复', () => {
  const { store, filePath } = makeStore();
  const board = store.getBoards()[0];
  const task = store.createTask(board.id, { title: '实现看板拖拽', priority: 'P1' });
  store.updateTask(board.id, task.id, { title: '实现看板拖拽（改）', assignee: 'phper666' });
  store.flushSync(); // 立即写盘
  const raw = JSON.parse(readFileSync(filePath, 'utf8')) as { version: number; boards: unknown[] };
  equal(raw.version, KANBAN_SCHEMA_VERSION);
  equal(raw.boards.length, 1);
  // 重启恢复
  const { store: store2 } = makeStore({ 'kanban/boards.json': readFileSync(filePath, 'utf8') });
  const restored = store2.getTasks(board.id);
  equal(restored.length, 1);
  equal(restored[0].title, '实现看板拖拽（改）');
  equal(restored[0].assignee, 'phper666');
  store2.dispose();
});

// ─────────────────────── K3 原子写失败 ───────────────────────
test('K3 原子写失败：store-io-error，内存态保留，数据不坏', () => {
  const { store, dir } = makeStore({}, { onWriteError: () => {} });
  const board = store.getBoards()[0];
  store.createTask(board.id, { title: '不会丢' });
  // 只读 kanban 目录 → 写 tmp 失败
  const kanbanDir = join(dir, 'kanban');
  chmodSync(kanbanDir, 0o555);
  try {
    throws(() => store.flushSync(), (e: unknown) => (e as { code: string }).code === KANBAN_STORE_ERRORS.ioError);
  } finally {
    chmodSync(kanbanDir, 0o755);
  }
  // 内存态保留
  equal(store.getTasks(board.id).length, 1);
  // 恢复可写
  store.flushSync();
  ok(existsSync(join(dir, 'kanban', 'boards.json')));
  store.dispose();
});

// ─────────────────────── K4 损坏重建 ───────────────────────
test('K4 损坏重建：store-corrupt 备份 corrupt-<ts> + 重建默认看板', () => {
  const { store, dir, filePath } = makeStore({ 'kanban/boards.json': '{broken json' });
  // 损坏 → 重建默认（load 已备份）
  const boards = store.getBoards();
  equal(boards.length, 1);
  equal(boards[0].name, '默认看板');
  ok(readdirSync(join(dir, 'kanban')).some((f) => f.startsWith('boards.json.corrupt-')), '备份存在');
  void filePath;
});

// ─────────────────────── K5 schema 迁移成功 ───────────────────────
test('K5 schema 迁移成功：version=1 数据 + 迁移函数 → version=2', () => {
  // v1 数据加载即触发 v1→v2 迁移（补 startDate:null），看板内容原样保留
  const v1 = JSON.stringify({ version: 1, boards: [{ id: 'b_x', name: '旧板', columns: [], tasks: [], order: 0, createdAt: 'x', updatedAt: 'x' }] });
  const { store } = makeStore({ 'kanban/boards.json': v1 });
  const boards = store.getBoards();
  equal(boards.length, 1);
  equal(boards[0].name, '旧板');
  equal(store.snapshot().version, KANBAN_SCHEMA_VERSION);
});

// ─────────────────────── K6 schema 迁移失败 ───────────────────────
test('K6 schema 迁移失败：迁移抛错 → store-migrate-failed 备份 + 重建', () => {
  // 构造 version 高于当前 → 视为不可迁移，走备份重建
  const v99 = JSON.stringify({ version: 99, boards: [] });
  const { store, dir } = makeStore({ 'kanban/boards.json': v99 });
  equal(store.getBoards().length, 1, '重建默认看板');
  ok(readdirSync(join(dir, 'kanban')).some((f) => f.startsWith('boards.json.corrupt-')), '备份存在');
});

// ─────────────────────── K7 加载性能 ───────────────────────
test('K7 加载性能：构造 ≤5MB（1000+ 卡）冷启动 <500ms', () => {
  const board = {
    id: 'b_big', name: '大板',
    columns: [{ id: 'c_todo', type: 'todo', name: 'Todo', order: 0, color: '#58a6ff', hidden: false }],
    tasks: Array.from({ length: 1200 }, (_, i) => ({
      id: `t_${i}`, parentId: null, columnId: 'c_todo', title: `任务 ${i}`,
      executionMode: 'manual', executionStatus: 'idle', currentExecutionId: null,
      acceptanceCriteria: null, agentSpec: { provider: 'dsh', agent: null, model: null, subagentPolicy: 'auto' },
      dependencies: [], description: null, labels: [], priority: 'P2', assignee: null,
      dueDate: null, order: i, blockedFromColumnId: null, archivedAt: null,
      archivedFromColumnId: null, createdAt: '2026-08-20T00:00:00.000Z', updatedAt: '2026-08-20T00:00:00.000Z',
      timeline: [],
    })),
    order: 0, createdAt: 'x', updatedAt: 'x',
  };
  const big = JSON.stringify({ version: 1, boards: [board] });
  ok(Buffer.byteLength(big) <= 5 * 1024 * 1024, '数据 ≤5MB');
  const start = performance.now();
  const { store } = makeStore({ 'kanban/boards.json': big });
  const elapsed = performance.now() - start;
  equal(store.getTasks('b_big').length, 1200);
  ok(elapsed < 500, `冷启动 ${elapsed.toFixed(1)}ms < 500ms`);
});

// ─────────────────────── K8 子任务级联删除 ───────────────────────
test('K8 子任务级联删除：deleteTask(父) 级联删子任务 + 清依赖引用', () => {
  const { store } = makeStore();
  const board = store.getBoards()[0];
  const parent = store.createTask(board.id, { title: '父卡' });
  const child1 = store.createTask(board.id, { title: '子1', parentId: parent.id });
  const child2 = store.createTask(board.id, { title: '子2', parentId: parent.id, dependencies: [child1.id] });
  void child2;
  store.deleteTask(board.id, parent.id);
  const remaining = store.getTasks(board.id);
  equal(remaining.length, 0, '父+子全部删除');
  // 无孤儿依赖引用
  for (const t of remaining) ok(!t.dependencies.includes(parent.id));
});

// ─────────────────────── K9 DSH_HOME 零接触 ───────────────────────
test('K9 DSH_HOME 零接触：数据落 userData/kanban', () => {
  const { store, dir } = makeStore();
  const board = store.getBoards()[0];
  store.createTask(board.id, { title: 'x' });
  store.flushSync();
  ok(existsSync(join(dir, 'kanban', 'boards.json')));
  // 目录内不应有 dsh 相关写入
  const entries = readdirSync(dir);
  ok(!entries.includes('dsh'), '不写 dsh 目录');
  store.dispose();
});

// ─────────────────────── K10-K13 校验 ───────────────────────
test('K10 createTask 标题空 → validation-error(field=title)', () => {
  const { store } = makeStore();
  const board = store.getBoards()[0];
  throws(() => store.createTask(board.id, { title: '' }), (e: unknown) => (e as { code: string }).code === KANBAN_STORE_ERRORS.validation);
});

test('K11 createTask 标题超长 → validation-error', () => {
  const { store } = makeStore();
  const board = store.getBoards()[0];
  throws(() => store.createTask(board.id, { title: 'x'.repeat(201) }), (e: unknown) => (e as { code: string }).code === KANBAN_STORE_ERRORS.validation);
});

test('K12 createTask auto 缺 AC → validation-error(acceptanceCriteria)', () => {
  const { store } = makeStore();
  const board = store.getBoards()[0];
  throws(
    () => store.createTask(board.id, { title: 'auto任务', executionMode: 'auto', acceptanceCriteria: null }),
    (e: unknown) => (e as { code: string }).code === KANBAN_STORE_ERRORS.validation
  );
});

test('K13 moveTask 目标列不存在 → validation-error(columnId)', () => {
  const { store } = makeStore();
  const board = store.getBoards()[0];
  const task = store.createTask(board.id, { title: 'x' });
  throws(() => store.moveTask(board.id, task.id, 'c_不存在'), (e: unknown) => (e as { code: string }).code === KANBAN_STORE_ERRORS.validation);
});

// ─────────────────────── K14 deleteTask 不存在 ───────────────────────
test('K14 deleteTask 不存在 → store-not-found', () => {
  const { store } = makeStore();
  const board = store.getBoards()[0];
  throws(() => store.deleteTask(board.id, 't_不存在'), (e: unknown) => (e as { code: string }).code === KANBAN_STORE_ERRORS.notFound);
});

// ─────────────────────── K15 updateTask 非法字段 ───────────────────────
test('K15 updateTask 非法字段（直接改 executionStatus）→ validation-error', () => {
  const { store } = makeStore();
  const board = store.getBoards()[0];
  const task = store.createTask(board.id, { title: 'x' });
  throws(
    () => store.updateTask(board.id, task.id, { executionStatus: 'running' } as never),
    (e: unknown) => (e as { code: string }).code === KANBAN_STORE_ERRORS.validation
  );
});

// ─────────────────────── K16/K17 Blocked 进出 ───────────────────────
test('K16 moveTask 进 Blocked → 落入 Blocked 列 + 记 blockedFromColumnId', () => {
  const { store } = makeStore();
  const board = store.getBoards()[0];
  const task = store.createTask(board.id, { title: 'x', columnId: 'c_in_progress' });
  const moved = store.moveTask(board.id, task.id, 'c_blocked');
  equal(moved.columnId, 'c_blocked', '卡片实际进入 Blocked 列（BUG-3 回归）');
  equal(moved.blockedFromColumnId, 'c_in_progress');
  // executionStatus 不变（双轨）
  equal(moved.executionStatus, 'idle');
  // system 事件
  ok(moved.timeline.some((t) => t.type === 'system' && t.content.includes('→')));
  store.dispose();
});

test('K17 moveTask 解除 Blocked → 回来源列；来源列已删/隐藏 → Todo', () => {
  const { store } = makeStore();
  const board = store.getBoards()[0];
  const task = store.createTask(board.id, { title: 'x', columnId: 'c_verify' });
  const blocked = store.moveTask(board.id, task.id, 'c_blocked');
  equal(blocked.columnId, 'c_blocked', '进 Blocked 先落列（BUG-3 回归）');
  // 解除回原列（落点列被忽略，设计语义 P2-4）
  const restored = store.moveTask(board.id, task.id, 'c_done');
  equal(restored.columnId, 'c_verify', '回来源列');
  equal(restored.blockedFromColumnId, null);
  // 隐藏来源列 → Todo
  const custom = store.createBoard('B');
  store.createTask(custom.id, { title: 'y', columnId: 'c_in_progress' });
  store.updateColumn(custom.id, 'c_in_progress', { hidden: true });
  // 构造：进 Blocked 后来源列隐藏
  const t2 = store.createTask(custom.id, { title: 'z', columnId: 'c_in_progress' });
  store.moveTask(custom.id, t2.id, 'c_blocked');
  store.updateColumn(custom.id, 'c_in_progress', { hidden: true });
  const r2 = store.moveTask(custom.id, t2.id, 'c_done');
  equal(r2.columnId, 'c_todo', '来源列隐藏 → Todo');
});

// ─────────────────────── 列原语：createColumn（BUG-1 修复） ───────────────────────
test('createColumn 新建自定义列：追加列尾/type 空/改名隐藏删除全生命周期', () => {
  const { store } = makeStore();
  const board = store.getBoards()[0];
  const col = store.createColumn(board.id, '  待评审  ');
  equal(col.name, '待评审', '列名 trim');
  equal(col.type, null, '非模板列');
  equal(col.hidden, false);
  const cols = store.getBoards()[0].columns;
  equal(cols[cols.length - 1].id, col.id, '追加列尾');
  equal(col.order, Math.max(...cols.slice(0, -1).map((c) => c.order)) + 1, 'order = 最大 +1');
  // 可更新（改名/隐藏）
  store.updateColumn(board.id, col.id, { name: '评审中', hidden: true });
  const updated = store.getBoards()[0].columns.find((c) => c.id === col.id);
  equal(updated?.name, '评审中');
  equal(updated?.hidden, true);
  // 列内卡片 → 删列迁移 Todo
  const task = store.createTask(board.id, { title: 'x', columnId: col.id });
  store.updateColumn(board.id, col.id, { hidden: false });
  store.deleteColumn(board.id, col.id);
  const migrated = store.getBoards()[0].tasks.find((t) => t.id === task.id);
  equal(migrated?.columnId, 'c_todo', '删列卡片迁 Todo');
  // 空名拒绝
  throws(() => store.createColumn(board.id, '  '), (e: unknown) => (e as { code: string }).code === KANBAN_STORE_ERRORS.validation);
  store.dispose();
});


// ─────────────────────── K18 deleteBoard 级联 ───────────────────────
test('K18 deleteBoard：含 ticket 拒删；清空后可删；最后看板不可删', () => {
  const { store } = makeStore();
  const def = store.getBoards()[0];
  const b1 = store.createBoard('A');
  const b2 = store.createBoard('B');
  store.createTask(b1.id, { title: 'x' });
  // 含 ticket → 拒删
  throws(() => store.deleteBoard(b1.id), (e: unknown) => (e as { code: string }).code === KANBAN_STORE_ERRORS.boardNotEmpty);
  // 删掉 ticket 后可删
  const t = store.getTasks(b1.id)[0];
  store.deleteTask(b1.id, t.id);
  store.deleteBoard(b1.id);
  equal(store.getBoards().length, 2, '默认看板 + B');
  // 最后看板不可删：删到只剩 1 个（剩 b2）
  store.deleteBoard(def.id);
  equal(store.getBoards().length, 1, '只剩 b2');
  throws(() => store.deleteBoard(b2.id), (e: unknown) => (e as { code: string }).code === KANBAN_STORE_ERRORS.validation);
});

// ─────────────────────── K19/K20 评论删除权限 ───────────────────────
test('K19 deleteComment user 评论 → 删除成功', () => {
  const { store } = makeStore();
  const board = store.getBoards()[0];
  const task = store.createTask(board.id, { title: 'x' });
  const withComment = store.addComment({ boardId: board.id, taskId: task.id, content: '你好' });
  const commentId = withComment.timeline.find((t) => t.type === 'comment')!.id;
  store.deleteComment(board.id, task.id, commentId);
  const after = store.getTasks(board.id)[0];
  ok(!after.timeline.some((t) => t.id === commentId), '评论已删');
});

test('K20 deleteComment agent 评论 → validation-error（Q-028 只读）', () => {
  const { store } = makeStore();
  const board = store.getBoards()[0];
  const task = store.createTask(board.id, { title: 'x' });
  // 构造 agent 评论
  // 直接注入 agent 评论到 timeline（模拟 B3 回填；executionStatus/agent 评论由 B3 调度层写）
  const storeAny = store as unknown as { data: { boards: { tasks: { timeline: unknown[] }[] }[] } };
  const t = storeAny.data.boards[0].tasks.find((x) => x.timeline === task.timeline) ?? storeAny.data.boards[0].tasks[0];
  t.timeline.push({
    id: 'tl_agent', type: 'comment', content: '执行结果', attachments: [], createdAt: new Date().toISOString(),
    author: 'agent', source: { type: 'agent', agentId: 'a', provider: 'dsh' }, execution: null,
  });
  throws(() => store.deleteComment(board.id, task.id, 'tl_agent'), (e: unknown) => (e as { code: string }).code === KANBAN_STORE_ERRORS.validation);
});

// ─────────────────────── K21 deleteTask 执行中 ───────────────────────
test('K21 deleteTask 执行中 → store-task-executing', () => {
  const { store } = makeStore();
  const board = store.getBoards()[0];
  const task = store.createTask(board.id, { title: 'x' });
  // 注入 running 态（B3 调度层写）
  const storeAny = store as unknown as { data: { boards: { tasks: { id: string; executionStatus: string }[] }[] } };
  storeAny.data.boards[0].tasks.find((t) => t.id === task.id)!.executionStatus = 'running';
  throws(() => store.deleteTask(board.id, task.id), (e: unknown) => (e as { code: string }).code === KANBAN_STORE_ERRORS.taskExecuting);
});

// ─────────────────────── K22 deleteBoard 执行中 ───────────────────────
test('K22 deleteBoard 执行中 → store-task-executing', () => {
  const { store } = makeStore();
  const b = store.createBoard('X');
  store.createBoard('Y');
  const task = store.createTask(b.id, { title: 'x' });
  const storeAny = store as unknown as { data: { boards: { id: string; tasks: { id: string; executionStatus: string }[] }[] } };
  storeAny.data.boards.find((x) => x.id === b.id)!.tasks.find((t) => t.id === task.id)!.executionStatus = 'queued';
  throws(() => store.deleteBoard(b.id), (e: unknown) => (e as { code: string }).code === KANBAN_STORE_ERRORS.taskExecuting);
});

// ─────────────────────── K23/K24 列删除 ───────────────────────
test('K23 deleteColumn 模板列 → validation-error', () => {
  const { store } = makeStore();
  const board = store.getBoards()[0];
  throws(() => store.deleteColumn(board.id, 'c_done'), (e: unknown) => (e as { code: string }).code === KANBAN_STORE_ERRORS.validation);
});

test('K24 deleteColumn 自定义列 → 删除成功，列内卡移入 Todo', () => {
  const { store } = makeStore();
  const custom = store.createBoard('B');
  // 自定义列（store 无公开建列 IPC 原语——B1 契约 createBoard 支持 columns 入参，测试用内部注入补列）
  const customCol: { id: string; type: null; name: string; order: number; color: string; hidden: boolean } = {
    id: 'c_custom1', type: null, name: '自定义', order: 6, color: '#fff', hidden: false,
  };
  const storeAny = store as unknown as { data: { boards: { id: string; columns: { id: string; type: string | null }[] }[] } };
  storeAny.data.boards.find((x) => x.id === custom.id)!.columns.push(customCol);
  store.createTask(custom.id, { title: 'x', columnId: 'c_custom1' });
  store.deleteColumn(custom.id, 'c_custom1');
  const after = store.getTasks(custom.id)[0];
  equal(after.columnId, 'c_todo', '移入 Todo');
});

// ─────────────────────── K25-K27 归档 ───────────────────────
test('K25 archiveTask 非 Done → validation-error', () => {
  const { store } = makeStore();
  const board = store.getBoards()[0];
  const task = store.createTask(board.id, { title: 'x', columnId: 'c_todo' });
  throws(() => store.archiveTask(board.id, task.id), (e: unknown) => (e as { code: string }).code === KANBAN_STORE_ERRORS.validation);
});

test('K26 archiveTask→restoreTask：归档回原列/ Done，清归档字段', () => {
  const { store } = makeStore();
  const board = store.getBoards()[0];
  const task = store.createTask(board.id, { title: 'x', columnId: 'c_done' });
  const archived = store.archiveTask(board.id, task.id);
  ok(archived.archivedAt, '归档时间非空');
  equal(archived.archivedFromColumnId, 'c_done');
  // 恢复回原列
  const restored = store.restoreTask(board.id, task.id);
  equal(restored.columnId, 'c_done');
  equal(restored.archivedAt, null);
  equal(restored.archivedFromColumnId, null);
  // 原列已删 → 回 Done（此处 done 未删，走原列）
});

test('K27 purgeTask 彻底删除：仅归档区，级联清理', () => {
  const { store } = makeStore();
  const board = store.getBoards()[0];
  // 非归档 → 拒绝
  const t = store.createTask(board.id, { title: 'x', columnId: 'c_done' });
  throws(() => store.purgeTask(board.id, t.id), (e: unknown) => (e as { code: string }).code === KANBAN_STORE_ERRORS.validation);
  // 归档后彻底删除
  store.archiveTask(board.id, t.id);
  store.purgeTask(board.id, t.id);
  equal(store.getTasks(board.id).length, 0, '归档任务已清');
});

// ─────────────────────── K28 deleteBoard 含归档拒删 ───────────────────────
test('K28 deleteBoard 含归档 ticket → store-board-not-empty', () => {
  const { store } = makeStore();
  const b = store.createBoard('X');
  store.createBoard('Y');
  const task = store.createTask(b.id, { title: 'x', columnId: 'c_done' });
  store.archiveTask(b.id, task.id);
  throws(() => store.deleteBoard(b.id), (e: unknown) => (e as { code: string }).code === KANBAN_STORE_ERRORS.boardNotEmpty);
});

// ─────────────────────── K29/K30 依赖与 AC 门控 ───────────────────────
test('K29 updateTask dependencies 非法引用 → validation-error', () => {
  const { store } = makeStore();
  const board = store.getBoards()[0];
  const p1 = store.createTask(board.id, { title: '父1' });
  const p2 = store.createTask(board.id, { title: '父2' });
  const c1 = store.createTask(board.id, { title: '子1', parentId: p1.id });
  const c2 = store.createTask(board.id, { title: '子2', parentId: p2.id });
  throws(() => store.updateTask(board.id, c1.id, { dependencies: [c2.id] }), (e: unknown) => (e as { code: string }).code === KANBAN_STORE_ERRORS.validation);
});

test('K30 updateTask 切 auto 缺 AC → validation-error（CON-R018 门控）', () => {
  const { store } = makeStore();
  const board = store.getBoards()[0];
  const task = store.createTask(board.id, { title: 'x' });
  throws(() => store.updateTask(board.id, task.id, { executionMode: 'auto', acceptanceCriteria: null }), (e: unknown) => (e as { code: string }).code === KANBAN_STORE_ERRORS.validation);
});

// ─────────────────────── K31 updateTask 已删任务 ───────────────────────
test('K31 updateTask 已删任务 → store-not-found', () => {
  const { store } = makeStore();
  const board = store.getBoards()[0];
  throws(() => store.updateTask(board.id, 't_不存在', { title: 'x' }), (e: unknown) => (e as { code: string }).code === KANBAN_STORE_ERRORS.notFound);
});

// ═══════════════════════ T2 startDate 字段 + schema v2 迁移（feishu-t2 契约） ═══════════════════════

/** 构造 v1 多板多列多任务数据（任务无 startDate 字段，CON-R-timeline-004 三层遍历对象）。
 * 返回纯 JSON 形状（非 Task 类型）：v1 数据本就无 startDate，经文件注入走 load/migrate 路径。 */
function makeV1Data() {
  const tl = (id: string, type: 'system' | 'comment', content: string) => ({
    id, type, content, attachments: [], createdAt: '2026-01-02T00:00:00.000Z',
    author: type === 'system' ? 'system' : 'user',
    source: type === 'system' ? { type: 'system' } : { type: 'user', provider: 'dsh' },
    execution: null,
  });
  const col = (id: string, type: string, order: number) => ({ id, type, name: type, order, color: '#58a6ff', hidden: false });
  const task = (id: string, columnId: string, timeline: ReturnType<typeof tl>[], extra: Record<string, unknown> = {}) => ({
    id, parentId: null, columnId, title: `任务${id}`, executionMode: 'manual', executionStatus: 'idle',
    currentExecutionId: null, acceptanceCriteria: null,
    agentSpec: { provider: 'dsh', agent: null, model: null, subagentPolicy: 'auto' },
    dependencies: [], description: null, labels: [], priority: 'P2', assignee: null,
    dueDate: '2026-03-01', order: 0, blockedFromColumnId: null, archivedAt: null, archivedFromColumnId: null,
    createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', timeline, ...extra,
  });
  return {
    version: 1,
    boards: [
      {
        id: 'b_v1a', name: 'V1板A', order: 0,
        createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
        columns: [col('c_todo', 'todo', 0), col('c_done', 'done', 1)],
        tasks: [
          task('t_v1_1', 'c_todo', [tl('tl_a1', 'system', '任务创建'), tl('tl_a2', 'comment', '备注')]),
          task('t_v1_2', 'c_done', [tl('tl_b1', 'system', '任务创建')], { priority: 'P0' }),
        ],
      },
      {
        id: 'b_v1b', name: 'V1板B', order: 1,
        createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
        columns: [col('c_todo2', 'todo', 0)],
        tasks: [task('t_v1_3', 'c_todo2', [])],
      },
    ],
  };
}

/** T2-1/V1：v1 数据迁移成功——三层遍历补 startDate:null、version 升 2、落盘 v2、数据零丢失 */
test('T2-1 v1 数据迁移成功：全任务补 startDate=null、version 升 2、落盘 v2、零丢失', () => {
  const v1 = JSON.stringify(makeV1Data());
  const { store, filePath } = makeStore({ 'kanban/boards.json': v1 });
  const snap = store.snapshot();
  equal(snap.version, 2, 'KANBAN_SCHEMA_VERSION 升 2');
  const all = snap.boards.flatMap((b) => b.tasks);
  equal(all.length, 3);
  for (const t of all) ok('startDate' in t && t.startDate === null, `每任务补 startDate:null（${t.id}）`);
  // 只加不动：标题/timeline/dueDate/priority 原样保留
  const t1 = all.find((t) => t.id === 't_v1_1')!;
  equal(t1.timeline.length, 2, 'timeline 条目数不变');
  equal(t1.timeline[1].content, '备注');
  equal(t1.dueDate, '2026-03-01');
  equal(all.find((t) => t.id === 't_v1_2')!.priority, 'P0');
  // 迁移成功即落盘为 v2（load 路径 flushNow）
  store.flushSync();
  equal(JSON.parse(readFileSync(filePath, 'utf8')).version, 2);
});

/** T2-2/V2：迁移幂等——v2 数据重复加载/migrate 直调不重复加字段不报错，已有值原样保留 */
test('T2-2 迁移幂等：重复 migrate 无 diff，已有 startDate 原样跳过', () => {
  const data = makeV1Data();
  (data.boards[0].tasks[0] as { startDate?: string | null }).startDate = '2026-08-25'; // 预置已有值
  data.version = 2;
  const { store } = makeStore({ 'kanban/boards.json': JSON.stringify(data) });
  equal(store.snapshot().version, 2);
  equal(store.getTasks('b_v1a').find((t) => t.id === 't_v1_1')!.startDate, '2026-08-25', '重启加载原值保留');
  // migrate() 直调两次 → 无 diff（幂等）
  const once = store.migrate(store.snapshot());
  const twice = store.migrate(once);
  equal(JSON.stringify(twice), JSON.stringify(once));
  equal(twice.boards[0].tasks[0].startDate, '2026-08-25', '直调不覆盖已有值');
});

/** T2-3：迁移失败兜底——migrate 抛错 → corrupt-<ts> 备份 + 默认看板重建，无错误码外泄 */
test('T2-3 迁移失败兜底：备份 corrupt-<ts> + 重建默认看板（load 路径静默恢复）', () => {
  class FailingMigrateStore extends KanbanStore {
    override migrate(_data: KanbanData): KanbanData {
      throw new HullError(KANBAN_STORE_ERRORS.migrateFailed, 'mock 迁移失败');
    }
  }
  const { store, dir } = makeStore({ 'kanban/boards.json': JSON.stringify(makeV1Data()) }, { cls: FailingMigrateStore });
  // 构造器不抛错；renderer 收到默认看板（无错误码）
  const boards = store.getBoards();
  equal(boards.length, 1);
  equal(boards[0].name, '默认看板');
  ok(readdirSync(join(dir, 'kanban')).some((f) => f.startsWith('boards.json.corrupt-')), '备份存在');
});

/** T2-4/V3：version 过新拒绝——备份含原 version=3 数据 + 默认看板重建 */
test('T2-4 version 过新：corrupt 备份保留原数据 + 默认看板重建，无错误码返回', () => {
  const v3 = JSON.stringify({ version: 3, boards: [{ id: 'b_new', name: '未来板', columns: [], tasks: [], order: 0, createdAt: 'x', updatedAt: 'x' }] });
  const { store, dir } = makeStore({ 'kanban/boards.json': v3 });
  equal(store.getBoards().length, 1);
  equal(store.getBoards()[0].name, '默认看板');
  const backup = readdirSync(join(dir, 'kanban')).find((f) => f.startsWith('boards.json.corrupt-'));
  ok(backup, '备份存在');
  equal(JSON.parse(readFileSync(join(dir, 'kanban', backup!), 'utf8')).version, 3, '备份含原 version=3 数据');
});

/** T2-5/T2-6：createTask 带 startDate 持久化 + 不带向后兼容（null） */
test('T2-5/6 createTask startDate：带值持久化重启保持 + 不传向后兼容 null', () => {
  const { store, filePath } = makeStore();
  const board = store.getBoards()[0];
  const t1 = store.createTask(board.id, { title: '带开始日期', startDate: '2026-08-25' });
  equal(t1.startDate, '2026-08-25');
  const t2 = store.createTask(board.id, { title: '不带开始日期' }); // 既有调用零影响
  equal(t2.startDate, null);
  store.flushSync();
  const raw = JSON.parse(readFileSync(filePath, 'utf8')) as { boards: Array<{ tasks: Array<{ id: string; startDate: string | null }> }> };
  equal(raw.boards[0].tasks.find((t) => t.id === t1.id)!.startDate, '2026-08-25', '落盘含该字段');
  equal(raw.boards[0].tasks.find((t) => t.id === t2.id)!.startDate, null);
  // 重启保持
  const { store: s2 } = makeStore({ 'kanban/boards.json': readFileSync(filePath, 'utf8') });
  equal(s2.getTasks(board.id).find((t) => t.id === t1.id)!.startDate, '2026-08-25');
  s2.dispose();
});

/** T2-7/T2-8：updateTask 设/清生效 + 不传保持原值（部分更新语义同 dueDate） */
test('T2-7/8 updateTask startDate：设/清生效 + 不传保持 + updatedAt 刷新', () => {
  const { store, filePath } = makeStore();
  const board = store.getBoards()[0];
  const t = store.createTask(board.id, { title: 'X', startDate: '2026-08-01' });
  const u1 = store.updateTask(board.id, t.id, { startDate: '2026-09-01' });
  equal(u1.startDate, '2026-09-01');
  ok(u1.updatedAt >= t.updatedAt, 'updatedAt 刷新');
  const u2 = store.updateTask(board.id, t.id, { priority: 'P1' });
  equal(u2.startDate, '2026-09-01', '部分更新：不传不变');
  const u3 = store.updateTask(board.id, t.id, { startDate: null });
  equal(u3.startDate, null, '显式 null 清空');
  store.flushSync();
  const raw = JSON.parse(readFileSync(filePath, 'utf8')) as { boards: Array<{ tasks: Array<{ id: string; startDate: string | null }> }> };
  equal(raw.boards[0].tasks.find((x) => x.id === t.id)!.startDate, null, '清空落盘同步');
});

/** T2-9：脏数据读取归一化——v2 文件手工脏 startDate → 加载置 null 不阻塞（CON-R-timeline-007） */
test('T2-9 脏数据读取归一化：startDate:"not-a-date" 加载置 null，其余任务正常', () => {
  const dirty = makeV1Data();
  dirty.version = 2;
  (dirty.boards[0].tasks[0] as { startDate?: unknown }).startDate = 'not-a-date';
  (dirty.boards[0].tasks[1] as { startDate?: unknown }).startDate = '2026-02-30'; // 格式对但日历不存在
  const { store } = makeStore({ 'kanban/boards.json': JSON.stringify(dirty) });
  const tasks = store.getTasks('b_v1a');
  equal(tasks.find((t) => t.id === 't_v1_1')!.startDate, null, '非法串归一化 null');
  equal(tasks.find((t) => t.id === 't_v1_2')!.startDate, null, '不存在日期归一化 null');
  equal(tasks.length, 2, '不阻塞加载');
});

/** T2-10：startDate > dueDate 存储层照存不报错（展示层以 dueDate 为准属 T1 渲染行为） */
test('T2-10 startDate>dueDate 照存：存储层不校验不报错', () => {
  const { store } = makeStore();
  const board = store.getBoards()[0];
  const t = store.createTask(board.id, { title: 'Y', startDate: '2026-10-01', dueDate: '2026-09-01' });
  equal(t.startDate, '2026-10-01');
  equal(t.dueDate, '2026-09-01');
});

/** T2-11：startDate 非 string/null 类型拒参 → validation-error（field=startDate 经 message 标识） */
test('T2-11 类型错误拒参：createTask/updateTask startDate 非 string|null → validation-error', () => {
  const { store } = makeStore();
  const board = store.getBoards()[0];
  const t = store.createTask(board.id, { title: 'Z' });
  throws(() => store.createTask(board.id, { title: 'W', startDate: 123 as unknown as string }), (e: unknown) => {
    const err = e as { code: string; message: string };
    return err.code === KANBAN_STORE_ERRORS.validation && /startDate/.test(err.message);
  });
  throws(() => store.updateTask(board.id, t.id, { startDate: true as unknown as string }), (e: unknown) => {
    const err = e as { code: string; message: string };
    return err.code === KANBAN_STORE_ERRORS.validation && /startDate/.test(err.message);
  });
});

/** T2-13：IPC 写入非法日期串归一化——写入侧存 null 不拒绝（类型错误仍拒见 T2-11） */
test('T2-13 非法日期串归一化：createTask/updateTask 非法串 → 响应与落盘均 null', () => {
  const { store, filePath } = makeStore();
  const board = store.getBoards()[0];
  const t = store.createTask(board.id, { title: 'W', startDate: 'not-a-date' });
  equal(t.startDate, null, 'createTask 非法串 → null');
  const u = store.updateTask(board.id, t.id, { startDate: '2026-13-99' });
  equal(u.startDate, null, 'updateTask 非法月日 → null');
  store.flushSync();
  const raw = JSON.parse(readFileSync(filePath, 'utf8')) as { boards: Array<{ tasks: Array<{ id: string; startDate: string | null }> }> };
  equal(raw.boards[0].tasks.find((x) => x.id === t.id)!.startDate, null, '落盘 null');
});
