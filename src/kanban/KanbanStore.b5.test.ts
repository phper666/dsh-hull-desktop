import { test, after } from 'node:test';
import { deepEqual, equal, ok, throws } from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { KanbanStore } from './KanbanStore';
import { KanbanTransfer, exportFileName } from './KanbanTransfer';
import { KANBAN_B5_ERRORS, KANBAN_SCHEMA_VERSION, type Board, type KanbanData, type Task } from './types';

const tempDirs: string[] = [];
after(() => {
  for (const d of tempDirs) rmSync(d, { recursive: true, force: true });
});

function makeStore(files: Record<string, string> = {}, opts: { maxAttachmentSizeMB?: number } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'hull-kanban-b5-'));
  tempDirs.push(dir);
  for (const [name, content] of Object.entries(files)) {
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
  const store = new KanbanStore({ userDataPath: dir, logger, ...opts });
  cleanup.push(() => store.dispose());
  return { store, dir, filePath: join(dir, 'kanban', 'boards.json') };
}

const cleanup: Array<() => void> = [];
after(() => {
  for (const fn of cleanup) fn();
  for (const d of tempDirs) rmSync(d, { recursive: true, force: true });
});

/** 构造一个含 1 父卡 + 1 子卡（依赖）+ 附件 + 归档任务的看板数据 */
function sampleBoard(id: string, name: string): Board {
  const now = '2026-08-21T00:00:00.000Z';
  return {
    id,
    name,
    order: 0,
    createdAt: now,
    updatedAt: now,
    columns: [
      { id: 'c_todo', type: 'todo', name: 'Todo', order: 0, color: '#58a6ff', hidden: false },
      { id: 'c_done', type: 'done', name: 'Done', order: 1, color: '#3fb950', hidden: false },
    ],
    tasks: [
      {
        id: 't_parent', parentId: null, columnId: 'c_todo', title: '父卡', executionMode: 'manual',
        executionStatus: 'idle', currentExecutionId: null, acceptanceCriteria: null,
        agentSpec: { provider: 'dsh', agent: null, model: null, subagentPolicy: 'auto' },
        dependencies: [], description: null, labels: [], priority: 'P2', assignee: null,
        dueDate: null, order: 0, blockedFromColumnId: null, archivedAt: null, archivedFromColumnId: null,
        createdAt: now, updatedAt: now, timeline: [],
      },
      {
        id: 't_child', parentId: 't_parent', columnId: 'c_todo', title: '子卡', executionMode: 'manual',
        executionStatus: 'idle', currentExecutionId: null, acceptanceCriteria: null,
        agentSpec: { provider: 'dsh', agent: null, model: null, subagentPolicy: 'auto' },
        dependencies: [], description: null, labels: [], priority: 'P2', assignee: null,
        dueDate: null, order: 1, blockedFromColumnId: null, archivedAt: null, archivedFromColumnId: null,
        createdAt: now, updatedAt: now,
        timeline: [
          { id: 'tl_c', type: 'comment', content: '带附件', attachments: [{ name: 'a.txt', size: 100, path: 'kanban/attachments/tl_c/a.txt' }], createdAt: now, author: 'user', source: { type: 'user' }, execution: null },
        ],
      },
      {
        id: 't_arch', parentId: null, columnId: 'c_done', title: '已归档', executionMode: 'manual',
        executionStatus: 'succeeded', currentExecutionId: null, acceptanceCriteria: null,
        agentSpec: { provider: 'dsh', agent: null, model: null, subagentPolicy: 'auto' },
        dependencies: [], description: null, labels: [], priority: 'P2', assignee: null,
        dueDate: null, order: 0, blockedFromColumnId: null, archivedAt: now, archivedFromColumnId: 'c_done',
        createdAt: now, updatedAt: now, timeline: [],
      },
    ],
  };
}

function sampleData(...boards: Board[]): KanbanData {
  return { version: KANBAN_SCHEMA_VERSION, boards };
}

function readSnapshot(filePath: string): KanbanData {
  return JSON.parse(readFileSync(filePath, 'utf8')) as KanbanData;
}

/** 从 store 导出全量数据（模拟 exportSnapshot） */
function storeSnapshot(store: KanbanStore): KanbanData {
  return store.snapshot();
}

// ─────────────────────── X1/X2 导出 ───────────────────────

test('X1 全看板导出快照：{version, boards[]} 完整数据（含归档/附件引用）', () => {
  const { store } = makeStore();
  const b1 = store.createBoard('项目A');
  const b2 = store.createBoard('项目B');
  const t1 = store.createTask(b1.id, { title: '任务1' });
  store.addComment({ boardId: b1.id, taskId: t1.id, content: '评论', attachments: [{ name: 'x.png', size: 1, path: 'kanban/attachments/tl_x/x.png' }] });
  const done = store.createTask(b1.id, { title: '完成', columnId: 'c_done' });
  store.archiveTask(b1.id, done.id);
  const snap = store.exportSnapshot();
  equal(snap.version, KANBAN_SCHEMA_VERSION);
  equal(snap.boards.length, 3, '默认 + A + B');
  equal(snap.boards[1].tasks.length, 2);
  // 归档保留
  const archived = snap.boards[1].tasks.find((t) => t.id === done.id)!;
  ok(archived.archivedAt, 'archivedAt 保留');
  equal(archived.archivedFromColumnId, 'c_done', 'archivedFromColumnId 保留');
  // 附件引用携带
  const comment = snap.boards[1].tasks.find((t) => t.id === t1.id)!.timeline.find((x) => x.type === 'comment')!;
  equal(comment.attachments.length, 1);
  // 快照深拷贝：改快照不影响 store
  snap.boards[1].tasks[0].title = '被改';
  equal(store.getTasks(b1.id)[0].title, '任务1');
});

test('X2 单看板导出快照：boards[] 仅 1 项；boardId 缺省=全看板', () => {
  const { store } = makeStore();
  const b1 = store.createBoard('项目A');
  store.createBoard('项目B');
  const snap = store.exportSnapshot(b1.id);
  equal(snap.boards.length, 1);
  equal(snap.boards[0].id, b1.id);
  equal(store.exportSnapshot().boards.length, 3);
});

test('X6 导出看板不存在 → export-not-found；boardId 格式非法 → validation-error', () => {
  const { store } = makeStore();
  const ghost = 'b_00000000-0000-4000-8000-000000000000';
  throws(() => store.exportSnapshot(ghost), (e: unknown) => (e as { code: string }).code === KANBAN_B5_ERRORS.exportNotFound);
  throws(() => store.exportSnapshot('bad-format'), (e: unknown) => (e as { code: string }).code === KANBAN_B5_ERRORS.validation);
});

test('X7 导出路径不可写 → export-io-error（KanbanTransfer 原子写失败）', async () => {
  const { store, dir } = makeStore();
  const transfer = new KanbanTransfer({ userDataPath: dir, store, dialog: { showSaveDialog: async () => ({ canceled: false, filePath: join(dir, 'ro', 'out.json') }) } });
  // ro 目录不可写（父路径不存在 + 只读）
  const roDir = join(dir, 'ro');
  mkdirSync(roDir);
  // 用目录路径作为目标文件 → 写失败
  const transfer2 = new KanbanTransfer({ userDataPath: dir, store, dialog: { showSaveDialog: async () => ({ canceled: false, filePath: roDir }) } });
  const result = await transfer2.exportBoard().catch((e: unknown) => e);
  equal((result as { code: string }).code, KANBAN_B5_ERRORS.exportIo);
  void transfer;
});

// ─────────────────────── X5 导出取消 ───────────────────────

test('X5 导出取消：保存对话框取消 → {cancelled:true}，无文件生成', async () => {
  const { store, dir } = makeStore();
  const target = join(dir, 'should-not-exist.json');
  const transfer = new KanbanTransfer({ userDataPath: dir, store, dialog: { showSaveDialog: async () => ({ canceled: true }) } });
  const result = await transfer.exportBoard();
  deepEqual(result, { cancelled: true });
  ok(!existsSync(target));
});

// ─────────────────────── X1/X2 导出文件（KanbanTransfer） ───────────────────────

test('X1b KanbanTransfer.exportBoard 全看板：文件生成 + ExportResult counts 正确', async () => {
  const { store, dir } = makeStore();
  const b1 = store.createBoard('项目A');
  store.createBoard('项目B');
  const t = store.createTask(b1.id, { title: '任务' });
  store.addComment({ boardId: b1.id, taskId: t.id, content: 'c', attachments: [{ name: 'a', size: 1, path: 'kanban/attachments/tl/a' }] });
  const target = join(dir, 'export-all.kanban.json');
  const transfer = new KanbanTransfer({ userDataPath: dir, store, dialog: { showSaveDialog: async () => ({ canceled: false, filePath: target }) } });
  const result = await transfer.exportBoard();
  ok(result && !('cancelled' in result));
  const r = result as { scope: string; boardCount: number; taskCount: number; attachmentCount: number; path: string };
  equal(r.scope, 'all');
  equal(r.boardCount, 3);
  equal(r.taskCount, 1);
  equal(r.attachmentCount, 1);
  ok(existsSync(target), '导出文件生成');
  const snap = readSnapshot(target);
  equal(snap.boards.length, 3);
  // 单看板 scope=board
  const target2 = join(dir, 'export-one.kanban.json');
  const transfer2 = new KanbanTransfer({ userDataPath: dir, store, dialog: { showSaveDialog: async () => ({ canceled: false, filePath: target2 }) } });
  const r2 = (await transfer2.exportBoard(b1.id)) as { scope: string; boardCount: number };
  equal(r2.scope, 'board');
  equal(r2.boardCount, 1);
});

// ─────────────────────── X10/X11 导入损坏 ───────────────────────

test('X10 导入非法 JSON → import-invalid-json，现有数据零改动', () => {
  const { store, dir } = makeStore();
  store.createTask(store.getBoards()[0].id, { title: '存量' });
  const file = join(dir, 'bad.json');
  writeFileSync(file, '{not json');
  const transfer = new KanbanTransfer({ userDataPath: dir, store, dialog: { showOpenDialog: async () => ({ canceled: false, filePaths: [file] }) } });
  throws(() => transfer.importBoard(file, 'merge'), (e: unknown) => (e as { code: string }).code === KANBAN_B5_ERRORS.importInvalidJson);
  equal(store.getBoards().length, 1, '现有数据零改动');
});

test('X11 导入损坏（缺 version/boards）→ import-corrupt', () => {
  const { store } = makeStore();
  throws(() => store.importData({ foo: 1 } as never, 'merge'), (e: unknown) => (e as { code: string }).code === KANBAN_B5_ERRORS.importCorrupt);
  throws(() => store.importData({ version: 'x' } as never, 'merge'), (e: unknown) => (e as { code: string }).code === KANBAN_B5_ERRORS.importCorrupt);
  equal(store.getBoards().length, 1, '现有数据零改动');
});

// ─────────────────────── X12/X13/X14 版本兼容 ───────────────────────

test('X12 导入版本过新 → import-version-newer', () => {
  const { store } = makeStore();
  throws(() => store.importData({ version: 99, boards: [] }, 'merge'), (e: unknown) => (e as { code: string }).code === KANBAN_B5_ERRORS.importVersionNewer);
});

test('X13 导入版本过旧（version=0）→ 复用 B1 migrate() 迁移成功', () => {
  const { store } = makeStore();
  const b = sampleBoard('b_import', '旧版');
  const result = store.importData({ version: 0, boards: [b] } as unknown as KanbanData, 'merge');
  equal(result.applied.boardsImported, 1);
  equal(store.getBoards().length, 2, '默认 + 导入');
  equal(store.snapshot().version, KANBAN_SCHEMA_VERSION, 'version 升到当前');
});

// ponytail: X14（import-version-older）不可达——B1 migrate() 对过旧版本恒成功（无操作 bump，X13 覆盖），
// 该错误码为未来迁移链（migrate 可能抛错）预留的防御分支，无真实输入可触发。见实现记录偏离点。

// ─────────────────────── X15/X16 字段/结构非法 ───────────────────────

test('X15 导入字段非法（auto 缺 AC）→ validation-error', () => {
  const { store } = makeStore();
  const b = sampleBoard('b_bad_ac', '坏板');
  b.tasks[0].executionMode = 'auto';
  b.tasks[0].acceptanceCriteria = null;
  throws(() => store.importData(sampleData(b), 'merge'), (e: unknown) => (e as { code: string }).code === KANBAN_B5_ERRORS.validation);
  equal(store.getBoards().length, 1, '现有数据零改动');
});

test('X16 导入结构非法（columnId 指向不存在列）→ validation-error', () => {
  const { store } = makeStore();
  const b = sampleBoard('b_bad_col', '坏板');
  b.tasks[0].columnId = 'c_不存在';
  throws(() => store.importData(sampleData(b), 'merge'), (e: unknown) => (e as { code: string }).code === KANBAN_B5_ERRORS.validation);
});

test('X16b 导入结构非法（parentId 指向不存在任务）→ validation-error', () => {
  const { store } = makeStore();
  const b = sampleBoard('b_bad_parent', '坏板');
  b.tasks[0].parentId = 't_不存在';
  throws(() => store.importData(sampleData(b), 'merge'), (e: unknown) => (e as { code: string }).code === KANBAN_B5_ERRORS.validation);
});

// ─────────────────────── X18 附件超限 ───────────────────────

test('X18 导入附件超限 → validation-error（field=attachments），现有数据零改动', () => {
  const { store } = makeStore({}, { maxAttachmentSizeMB: 1 });
  const b = sampleBoard('b_big', '大附件');
  const big = 2 * 1024 * 1024 + 1;
  b.tasks[1].timeline[0].attachments[0].size = big;
  throws(() => store.importData(sampleData(b), 'merge'), (e: unknown) => (e as { code: string }).code === KANBAN_B5_ERRORS.validation);
  equal(store.getBoards().length, 1, '现有数据零改动');
});

// ─────────────────────── X8 merge 成功（id 不同） ───────────────────────

test('X8 导入合并成功（merge，id 无冲突）：追加 + ids.preserved', () => {
  const { store } = makeStore();
  const existing = store.getBoards()[0].id;
  const b = sampleBoard('b_import', '导入板');
  const result = store.importData(sampleData(b), 'merge');
  equal(result.applied.mode, 'merge');
  equal(result.applied.boardsImported, 1);
  equal(result.applied.tasksImported, 3);
  equal(result.ids.preserved.length, 1);
  equal(result.ids.preserved[0], 'b_import');
  deepEqual(result.ids.regenerated, []);
  equal(store.getBoards().length, 2);
  equal(store.getBoards().some((x) => x.id === existing), true, '现有看板保留');
});

// ─────────────────────── X9 replace 成功 + 备份 ───────────────────────

test('X9 导入替换成功（replace）：整文件替换 + 备份 boards.preimport-<ts> 生成', () => {
  const { store, dir } = makeStore();
  store.createTask(store.getBoards()[0].id, { title: '将被替换' });
  const b = sampleBoard('b_replace', '新板');
  const result = store.importData(sampleData(b), 'replace');
  equal(result.applied.boardsImported, 1);
  equal(store.getBoards().length, 1, '整文件替换为导入 1 看板');
  equal(store.getBoards()[0].id, 'b_replace');
  // 备份存在（kanban/boards.json.preimport-<ts>；与 B1 损坏备份 boards.json.corrupt-<ts> 区分）
  const backups = readdirSync(join(dir, 'kanban')).filter((f) => f.startsWith('boards.json.preimport-'));
  ok(backups.length >= 1, `备份存在: ${backups.join(',')}`);
  const backupData = readSnapshot(join(dir, 'kanban', backups[0]));
  equal(backupData.boards[0].tasks[0].title, '将被替换', '备份含替换前数据');
});

// ─────────────────────── X17 merge id 冲突重映射 ───────────────────────

test('X17 合并 id 冲突自动重映射：冲突板重 id + 内部引用（parentId/dependencies/列/timeline）重映射', () => {
  const { store } = makeStore();
  // 现有一板，id 与导入板相同
  const existing = store.getBoards()[0];
  const b = sampleBoard(existing.id, '冲突板');
  // 构造同父兄弟子任务，child 依赖 sibling（同父下合法）
  const sibling: Task = {
    id: 't_sibling', parentId: 't_parent', columnId: 'c_todo', title: '兄弟子卡', executionMode: 'manual',
    executionStatus: 'idle', currentExecutionId: null, acceptanceCriteria: null,
    agentSpec: { provider: 'dsh', agent: null, model: null, subagentPolicy: 'auto' },
    dependencies: [], description: null, labels: [], priority: 'P2', assignee: null,
    dueDate: null, order: 2, blockedFromColumnId: null, archivedAt: null, archivedFromColumnId: null,
    createdAt: 'x', updatedAt: 'x', timeline: [],
  };
  b.tasks.push(sibling);
  b.tasks[1].dependencies = [sibling.id]; // child 依赖 sibling（同父）
  const result = store.importData(sampleData(b), 'merge');
  equal(result.applied.boardsImported, 1);
  equal(store.getBoards().length, 2);
  const imported = store.getBoards().find((x) => x.id !== existing.id)!;
  ok(imported, '冲突板已重 id 追加');
  ok(imported.id !== existing.id, '重 id 后原 id 不残留');
  equal(result.ids.regenerated.length, 1);
  equal(result.ids.regenerated[0], imported.id, 'regenerated 含冲突板新 id');
  deepEqual(result.ids.preserved, []);
  // 引用重映射正确
  const parent = imported.tasks.find((t) => t.title === '父卡')!;
  const child = imported.tasks.find((t) => t.title === '子卡')!;
  const sib = imported.tasks.find((t) => t.title === '兄弟子卡')!;
  equal(child.parentId, parent.id, 'parentId 重映射');
  ok(child.dependencies.includes(sib.id), 'dependencies 重映射到兄弟子卡');
  equal(imported.columns.some((c) => c.id === 'c_todo'), false, '列 id 重映射（全部内部 id 重生成）');
  ok(imported.columns.every((c) => c.id.startsWith('c_')), '列重映射后仍为 c_ 前缀');
  ok(!child.timeline.some((x) => x.id === 'tl_c'), 'timeline id 重映射');
});

// ─────────────────────── X22 跨现有看板引用拒绝 ───────────────────────

test('X22 跨现有看板引用拒绝：导入任务引用现有看板任务/列 id → validation-error', () => {
  const { store } = makeStore();
  const existing = store.getBoards()[0];
  // 构造导入板任务引用现有任务 id
  const b = sampleBoard('b_cross', '跨引用');
  b.tasks[0].parentId = existing.id; // 引用现有看板 id 作父任务 → 拒绝
  throws(() => store.importData(sampleData(b), 'merge'), (e: unknown) => (e as { code: string }).code === KANBAN_B5_ERRORS.validation);
  equal(store.getBoards().length, 1, '现有数据零改动');
});

test('X22b 跨现有看板依赖引用拒绝：导入子任务 dependencies 指向现有任务 id → validation-error', () => {
  const { store } = makeStore();
  const existing = store.getBoards()[0];
  // 构造导入板子任务依赖指向现有看板任务 id（文件内无法解析 → 跨板引用拒绝）
  const b = sampleBoard('b_cross2', '跨依赖');
  b.tasks[1].dependencies = [existing.id];
  throws(() => store.importData(sampleData(b), 'merge'), (e: unknown) => (e as { code: string }).code === KANBAN_B5_ERRORS.validation);
  equal(store.getBoards().length, 1, '现有数据零改动');
});

// ─────────────────────── X23 merge 重映射后重申校验 ───────────────────────

test('X23 merge 重映射后重申 B1 校验：重映射产生非法引用 → 拒绝，现有数据零改动', () => {
  const { store } = makeStore();
  const existing = store.getBoards()[0];
  // 构造：冲突板内子任务依赖指向"父任务自身"→ 重映射后仍违例（依赖不能指向父任务）
  const b = sampleBoard(existing.id, '重映射违例');
  b.tasks[1].dependencies = [b.tasks[0].id]; // 子卡依赖父卡 → B1 约束违例
  throws(() => store.importData(sampleData(b), 'merge'), (e: unknown) => (e as { code: string }).code === KANBAN_B5_ERRORS.validation);
  equal(store.getBoards().length, 1, '现有数据零改动');
});

// ─────────────────────── X20 mode 非法 ───────────────────────

test('X20 导入 mode 非法 → import-mode-invalid', () => {
  const { store } = makeStore();
  const b = sampleBoard('b_any', '任意');
  throws(() => store.importData(sampleData(b), 'xxx' as never), (e: unknown) => (e as { code: string }).code === KANBAN_B5_ERRORS.importModeInvalid);
});

// ─────────────────────── X3/X4 导出还原 ───────────────────────

test('X3/X4 导出还原（同机/异机）：导出文件 replace 导入后数据完整还原（含归档/附件引用/execution 缺失占位不阻塞）', () => {
  const { store, dir } = makeStore();
  const b1 = store.createBoard('项目A');
  const t1 = store.createTask(b1.id, { title: '任务1' });
  store.addComment({ boardId: b1.id, taskId: t1.id, content: '评论', attachments: [{ name: 'x.png', size: 5, path: 'kanban/attachments/tl_x/x.png' }] });
  const done = store.createTask(b1.id, { title: '完成', columnId: 'c_done' });
  store.archiveTask(b1.id, done.id);
  const snap = store.exportSnapshot();
  // 全新壳导入（replace）
  const { store: fresh } = makeStore();
  const result = fresh.importData(snap, 'replace');
  equal(result.applied.boardsImported, 2);
  const restored = fresh.getBoard(b1.id);
  equal(restored.name, '项目A');
  equal(restored.tasks.length, 2);
  const arch = restored.tasks.find((t) => t.id === done.id)!;
  ok(arch.archivedAt, '归档字段保留（CON-R033）');
  equal(arch.archivedFromColumnId, 'c_done');
  const comment = restored.tasks.find((t) => t.id === t1.id)!.timeline.find((x) => x.type === 'comment')!;
  equal(comment.attachments[0].name, 'x.png', '附件引用保留（二进制缺失按 B1 占位语义不阻塞）');
});

// ─────────────────────── X21 导入后可用性（归档保留 + CRUD 可用） ───────────────────────

test('X21 导入后可用性回归：归档字段正确 + 导入看板可 CRUD/流转', () => {
  const { store } = makeStore();
  const b = sampleBoard('b_use', '可用板');
  const result = store.importData(sampleData(b), 'merge');
  equal(result.applied.boardsImported, 1);
  const imported = store.getBoard('b_use');
  const arch = imported.tasks.find((t) => t.id === 't_arch')!;
  ok(arch.archivedAt, '归档字段保留');
  equal(arch.archivedFromColumnId, 'c_done');
  // 恢复归档任务
  const restored = store.restoreTask('b_use', arch.id);
  equal(restored.archivedAt, null);
  equal(restored.columnId, 'c_done');
  // 新建任务可用
  const nt = store.createTask('b_use', { title: '新卡' });
  equal(store.getTasks('b_use').length, 4);
  void nt;
});

// ─────────────────────── 导出文件名 ───────────────────────

test('exportFileName：含非法字符 → 清洗；缺省 → kanban-boards.kanban.json', () => {
  equal(exportFileName('我的/看板:test*'), '我的_看板_test_.kanban.json');
  equal(exportFileName(), 'kanban-boards.kanban.json');
});

// ─────────────────────── store 层面 importData 失败零改动（防抖不落盘） ───────────────────────

test('导入校验失败后 flushSync：boards.json 保持原样（零改动落盘）', () => {
  const { store, dir, filePath } = makeStore();
  store.createTask(store.getBoards()[0].id, { title: '存量' });
  store.flushSync();
  const before = readFileSync(filePath, 'utf8');
  const b = sampleBoard('b_bad', '坏板');
  b.tasks[0].columnId = 'c_不存在';
  throws(() => store.importData(sampleData(b), 'merge'), (e: unknown) => (e as { code: string }).code === KANBAN_B5_ERRORS.validation);
  store.flushSync();
  equal(readFileSync(filePath, 'utf8'), before, 'boards.json 未变');
  void dir;
});

// ─────────────────────── replace 备份失败 → store-io-error 拒绝 ───────────────────────

test('replace 备份失败（kanban 目录只读）→ store-io-error，原数据不破坏', () => {
  const { store, dir } = makeStore();
  store.createTask(store.getBoards()[0].id, { title: '存量' });
  store.flushSync();
  const kanbanDir = join(dir, 'kanban');
  const b = sampleBoard('b_rw', '新板');
  chmodSync(kanbanDir, 0o555);
  try {
    throws(() => store.importData(sampleData(b), 'replace'), (e: unknown) => (e as { code: string }).code === KANBAN_B5_ERRORS.ioError);
  } finally {
    chmodSync(kanbanDir, 0o755);
  }
  // 内存态未变（applyData 未执行）
  equal(store.getBoards().length, 1);
  equal(store.getTasks(store.getBoards()[0].id)[0].title, '存量');
});
