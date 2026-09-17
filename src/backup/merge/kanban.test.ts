import { test, after } from 'node:test';
import { equal, ok } from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { DEFAULT_COLUMNS, KANBAN_SCHEMA_VERSION, type Board, type KanbanData, type Task } from '../../kanban/types';
import { NOOP_LOGGER } from '../../shared/types';
import { mergeKanban } from './kanban';

const dirs: string[] = [];
after(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

function tmp(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}

const TS = '2026-09-01T00:00:00.000Z';

function task(id: string, title: string): Task {
  return {
    id,
    parentId: null,
    columnId: 'c_todo',
    title,
    executionMode: 'manual',
    executionStatus: 'idle',
    currentExecutionId: null,
    acceptanceCriteria: null,
    agentSpec: { provider: 'dsh', agent: null, model: null, subagentPolicy: 'auto' },
    dependencies: [],
    description: null,
    labels: [],
    priority: 'P2',
    assignee: null,
    dueDate: null,
    startDate: null,
    order: 0,
    blockedFromColumnId: null,
    archivedAt: null,
    archivedFromColumnId: null,
    createdAt: TS,
    updatedAt: TS,
    timeline: [],
  };
}

function board(id: string, name: string, tasks: Task[]): Board {
  return { id, name, columns: DEFAULT_COLUMNS.map((c) => ({ ...c })), tasks, order: 0, createdAt: TS, updatedAt: TS };
}

function writeBoards(path: string, data: KanbanData): void {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, JSON.stringify(data));
}

test('kanban：复用 importData(merge) —— 包内基底保留 id，本地旧数据冲突板重 id 追加并重映射引用', () => {
  const userData = tmp('hull-merge-kanban-');
  const backupDir = tmp('hull-merge-kanban-bak-');
  const packPath = join(userData, 'kanban', 'boards.json');
  const backupPath = join(backupDir, 'kanban', 'boards.json');

  writeBoards(packPath, { version: KANBAN_SCHEMA_VERSION, boards: [board('b_pack', '包内板', [])] });
  writeBoards(backupPath, {
    version: KANBAN_SCHEMA_VERSION,
    boards: [
      board('b_pack', '本地旧板', [task('t_local', '本地任务')]),
      board('b_new', '本地新板', [task('t_new', '新板任务')]),
    ],
  });

  const { report, boards } = mergeKanban({ userDataPath: userData, backupBoardsPath: backupPath, logger: NOOP_LOGGER });

  equal(boards.boards.length, 3);
  equal(boards.boards[0].id, 'b_pack'); // 包内基底未被覆盖
  equal(boards.boards[0].name, '包内板');

  const localOld = boards.boards.find((b) => b.name === '本地旧板')!;
  ok(localOld.id !== 'b_pack');
  ok(localOld.id.startsWith('b_'));
  const remappedTask = localOld.tasks[0];
  ok(remappedTask.id !== 't_local');
  ok(remappedTask.id.startsWith('t_'));
  ok(remappedTask.columnId !== 'c_todo'); // 引用随重 id 同步重映射
  equal(boards.boards.find((b) => b.name === '本地新板')!.id, 'b_new'); // 非冲突板保留原 id

  // 落盘 = 内存快照
  const onDisk = JSON.parse(readFileSync(packPath, 'utf8')) as KanbanData;
  equal(onDisk.boards.length, 3);

  equal(report.classes.kanban.added, 2);
  equal(report.classes.kanban.updated, 0);
  const conflict = report.conflicts.find((c) => c.kind === 'kanban')!;
  equal(conflict.id, 'b_pack');
  equal(conflict.resolution, 'appended');
  ok(conflict.detail?.includes(localOld.id));
});

test('kanban：本地预备份缺失 → 包内基线原样保留，无冲突', () => {
  const userData = tmp('hull-merge-kanban2-');
  const backupDir = tmp('hull-merge-kanban-bak2-');
  const packPath = join(userData, 'kanban', 'boards.json');
  writeBoards(packPath, { version: KANBAN_SCHEMA_VERSION, boards: [board('b_pack', '包内板', [])] });

  const { report, boards } = mergeKanban({
    userDataPath: userData,
    backupBoardsPath: join(backupDir, 'kanban', 'boards.json'),
    logger: NOOP_LOGGER,
  });
  equal(boards.boards.length, 1);
  equal(report.classes.kanban.added, 0);
  equal(report.conflicts.length, 0);
  equal((JSON.parse(readFileSync(packPath, 'utf8')) as KanbanData).boards.length, 1);
});
