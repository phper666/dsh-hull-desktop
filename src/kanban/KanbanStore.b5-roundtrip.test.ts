/**
 * B5 round-trip 测试（🔴-1 盲点修复）
 *
 * 背景：B3 ExecutionEngine.markSucceeded 不清 currentExecutionId（值 e_<seq>，Q-023 记录追溯），
 * 而旧 B5 校验强制 currentExecutionId 指向文件内 timeline（tl_ 系）→ 任何 succeeded 任务导出再导入必失败。
 * 旧 fixture 全 currentExecutionId: null，未覆盖真实 round-trip。
 *
 * 本文件：exportSnapshot → 写临时文件 → importBoard(mode=replace) 真实 round-trip，
 * 覆盖 succeeded + currentExecutionId、archivedAt、dependencies、跨现有看板引用（e_ 指向不存在的 timeline id）保留。
 */
import { test, after } from 'node:test';
import { equal, ok, throws } from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { KanbanStore } from './KanbanStore';
import { KanbanTransfer } from './KanbanTransfer';
import { KANBAN_B5_ERRORS, KANBAN_SCHEMA_VERSION, type Board, type KanbanData } from './types';

const tempDirs: string[] = [];
after(() => {
  for (const d of tempDirs) rmSync(d, { recursive: true, force: true });
});

function makeStore(files: Record<string, string> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'hull-kanban-b5rt-'));
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
  const store = new KanbanStore({ userDataPath: dir, logger });
  return { store, dir, filePath: join(dir, 'kanban', 'boards.json') };
}

/** 含 succeeded 任务（currentExecutionId='e_0001'）+ 归档任务 + 父子依赖的看板数据 */
function roundTripBoard(): Board {
  const now = '2026-08-21T00:00:00.000Z';
  return {
    id: 'b_rt',
    name: 'roundtrip',
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
        executionStatus: 'succeeded', currentExecutionId: 'e_0001', acceptanceCriteria: null,
        agentSpec: { provider: 'dsh', agent: null, model: null, subagentPolicy: 'auto' },
        dependencies: [], description: null, labels: [], priority: 'P2', assignee: null,
        dueDate: null, order: 0, blockedFromColumnId: null, archivedAt: null, archivedFromColumnId: null,
        createdAt: now, updatedAt: now,
        timeline: [{ id: 'tl_sys', type: 'system', content: '任务创建', attachments: [], createdAt: now, author: 'system', source: { type: 'system' }, execution: null }],
      },
      {
        id: 't_child', parentId: 't_parent', columnId: 'c_todo', title: '子卡', executionMode: 'manual',
        executionStatus: 'idle', currentExecutionId: null, acceptanceCriteria: null,
        agentSpec: { provider: 'dsh', agent: null, model: null, subagentPolicy: 'auto' },
        dependencies: ['t_sibling'], description: null, labels: [], priority: 'P2', assignee: null,
        dueDate: null, order: 1, blockedFromColumnId: null, archivedAt: null, archivedFromColumnId: null,
        createdAt: now, updatedAt: now, timeline: [],
      },
      {
        id: 't_sibling', parentId: 't_parent', columnId: 'c_todo', title: '兄弟子卡', executionMode: 'manual',
        executionStatus: 'idle', currentExecutionId: null, acceptanceCriteria: null,
        agentSpec: { provider: 'dsh', agent: null, model: null, subagentPolicy: 'auto' },
        dependencies: [], description: null, labels: [], priority: 'P2', assignee: null,
        dueDate: null, order: 2, blockedFromColumnId: null, archivedAt: null, archivedFromColumnId: null,
        createdAt: now, updatedAt: now, timeline: [],
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

function snapshotData(): KanbanData {
  return { version: KANBAN_SCHEMA_VERSION, boards: [roundTripBoard()] };
}

/** 导出到临时文件（模拟 exportSnapshot → 落盘） */
function writeSnapshot(data: KanbanData, dir: string, name: string): string {
  const file = join(dir, name);
  writeFileSync(file, JSON.stringify(data), 'utf8');
  return file;
}

// ─────────────────────── 场景 1：succeeded + currentExecutionId round-trip ───────────────────────

test('R1 round-trip（replace）：succeeded 任务 + currentExecutionId=e_0001 导出再导入成功且保留', () => {
  const { store, dir } = makeStore();
  const file = writeSnapshot(snapshotData(), dir, 'rt-succeeded.json');
  const transfer = new KanbanTransfer({ userDataPath: dir, store, dialog: {} });
  const result = transfer.importBoard(file, 'replace');
  equal(result.applied.boardsImported, 1);
  const b = store.getBoard('b_rt');
  const parent = b.tasks.find((t) => t.id === 't_parent')!;
  equal(parent.executionStatus, 'succeeded', 'succeeded 保留');
  equal(parent.currentExecutionId, 'e_0001', 'currentExecutionId=e_0001 保留（Q-023 记录引用）');
});

// ─────────────────────── 场景 2：archivedAt round-trip ───────────────────────

test('R2 round-trip（replace）：archivedAt + archivedFromColumnId 保留', () => {
  const { store, dir } = makeStore();
  const file = writeSnapshot(snapshotData(), dir, 'rt-archived.json');
  const transfer = new KanbanTransfer({ userDataPath: dir, store, dialog: {} });
  transfer.importBoard(file, 'replace');
  const b = store.getBoard('b_rt');
  const arch = b.tasks.find((t) => t.id === 't_arch')!;
  ok(arch.archivedAt, 'archivedAt 保留');
  equal(arch.archivedFromColumnId, 'c_done', 'archivedFromColumnId 保留');
});

// ─────────────────────── 场景 3：dependencies round-trip ───────────────────────

test('R3 round-trip（replace）：dependencies 保留且指向文件内合法任务 id', () => {
  const { store, dir } = makeStore();
  const file = writeSnapshot(snapshotData(), dir, 'rt-deps.json');
  const transfer = new KanbanTransfer({ userDataPath: dir, store, dialog: {} });
  transfer.importBoard(file, 'replace');
  const b = store.getBoard('b_rt');
  const child = b.tasks.find((t) => t.id === 't_child')!;
  deepEqualSorted(child.dependencies, ['t_sibling']);
  // 依赖指向文件内合法任务 id（同父兄弟）
  for (const d of child.dependencies) ok(b.tasks.some((t) => t.id === d), `依赖指向文件内任务（dep=${d}）`);
  ok(b.tasks.find((t) => t.id === 't_sibling')!.parentId === 't_parent', '依赖为同父兄弟');
});

// ─────────────────────── 场景 4：currentExecutionId 指向不存在 timeline id → 宽松化接受 ───────────────────────

test('R4 round-trip（replace）：currentExecutionId 指向文件内不存在的 timeline id（e_ 系跨引用）→ 宽松化接受', () => {
  const { store, dir } = makeStore();
  const data = snapshotData();
  // 父卡 currentExecutionId 指向一个文件内不存在的 id（B3 e_<seq> 记录引用，非 tl_ timeline）
  data.boards[0].tasks[0].currentExecutionId = 'e_9999';
  const file = writeSnapshot(data, dir, 'rt-cross.json');
  const transfer = new KanbanTransfer({ userDataPath: dir, store, dialog: {} });
  // 不抛 validation-error，按轨 1 宽松化接受
  const result = transfer.importBoard(file, 'replace');
  equal(result.applied.boardsImported, 1);
  equal(store.getBoard('b_rt').tasks.find((t) => t.id === 't_parent')!.currentExecutionId, 'e_9999', 'e_ 值保留');
});

// ─────────────────────── 场景 4b：格式非法仍拒绝（宽松化边界） ───────────────────────

test('R4b round-trip（replace）：currentExecutionId 格式非法（非 e_/tl_ 前缀）→ validation-error', () => {
  const { store, dir } = makeStore();
  const data = snapshotData();
  data.boards[0].tasks[0].currentExecutionId = 'garbage_id';
  const file = writeSnapshot(data, dir, 'rt-badfmt.json');
  const transfer = new KanbanTransfer({ userDataPath: dir, store, dialog: {} });
  throws(() => transfer.importBoard(file, 'replace'), (e: unknown) => (e as { code: string }).code === KANBAN_B5_ERRORS.validation);
  // 失败零改动：仍默认看板
  equal(store.getBoards().length, 1);
  ok(store.getBoards()[0].id !== 'b_rt');
});

// ─────────────────────── 场景 1b：merge 模式 round-trip ───────────────────────

test('R1b round-trip（merge）：succeeded + currentExecutionId=e_0001 合并导入成功且保留', () => {
  const { store, dir } = makeStore();
  const file = writeSnapshot(snapshotData(), dir, 'rt-merge.json');
  const transfer = new KanbanTransfer({ userDataPath: dir, store, dialog: {} });
  const result = transfer.importBoard(file, 'merge');
  equal(result.applied.boardsImported, 1);
  const b = store.getBoard('b_rt');
  equal(b.tasks.find((t) => t.id === 't_parent')!.currentExecutionId, 'e_0001', 'merge 后 e_ 值保留');
});

/** 排序后比较数组（顺序无关） */
function deepEqualSorted(actual: string[], expected: string[]): void {
  equal([...actual].sort().join(','), [...expected].sort().join(','));
}
