import { test, after } from 'node:test';
import { equal, ok } from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import type { HullSettings } from '../../settings/SettingsProvider';
import { DEFAULT_NOTIF_PREFS } from '../../notifications/prefs';
import { DEFAULT_COLUMNS, KANBAN_SCHEMA_VERSION, type Board, type Task } from '../../kanban/types';
import { NOOP_LOGGER } from '../../shared/types';
import { applyMerge } from './index';

const dirs: string[] = [];
after(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

function tmp(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}

function writeFile(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

function writeJson(path: string, value: unknown): void {
  writeFile(path, JSON.stringify(value));
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

function settings(base: string, over: Partial<HullSettings> = {}): HullSettings {
  return {
    closeToQuit: false,
    schemaVersion: 4,
    channel: 'latest',
    pinnedVersion: null,
    autoCheckDsh: true,
    autoCheckHull: true,
    registry: 'https://registry.npmjs.org',
    theme: 'dark',
    packageManager: 'pnpm',
    notifPrefs: { ...DEFAULT_NOTIF_PREFS },
    notesDir: join(base, 'notes'),
    ...over,
  };
}

test('applyMerge：按类分发；任一类结果落盘 + 汇总 MergeReport', () => {
  const userData = tmp('hull-merge-apply-');
  const backupRoot = tmp('hull-merge-apply-bak-');
  const incomingRoot = tmp('hull-merge-apply-inc-');
  const notesDir = tmp('hull-merge-apply-notes-');

  // ── 包内基线（userData 已被执行器 reset 为包内容） ──
  writeJson(join(userData, 'kanban', 'boards.json'), { version: KANBAN_SCHEMA_VERSION, boards: [board('b_pack', '包内板', [])] });
  writeJson(join(userData, 'workflows', 'workflows.json'), {
    version: 1,
    workflows: [{ id: 'w1', name: '包内流', enabled: true, steps: [], trigger: null, createdAt: TS, updatedAt: TS }],
  });
  writeJson(join(userData, 'notifications', 'notifications.json'), {
    version: 1,
    notifications: [{ id: 'n1', source: 'workflow', severity: 'info', title: 'n1', body: '', link: { kind: 'workflow', workflowId: 'w1' }, ts: TS, readAt: TS }],
  });
  writeFile(join(userData, 'notes', 'a.md'), 'PACK');
  writeJson(join(userData, 'notes', 'trash.json'), { version: 1, entries: [] });
  writeJson(join(userData, 'skills', 'disabled.json'), { version: 1, entries: [] });
  writeJson(join(userData, 'skills', 'trash.json'), { version: 1, entries: [] });
  writeJson(join(userData, 'dismiss.json'), { hull: '2026-01-01' });

  // ── 本地预备份（backupRoot） ──
  writeJson(join(backupRoot, 'kanban', 'boards.json'), {
    version: KANBAN_SCHEMA_VERSION,
    boards: [board('b_pack', '本地旧板', [task('t_local', '本地任务')]), board('b_new', '本地新板', [])],
  });
  writeJson(join(backupRoot, 'workflows', 'workflows.json'), {
    version: 1,
    workflows: [{ id: 'w1', name: '本地流', enabled: true, steps: [], trigger: null, createdAt: TS, updatedAt: TS }],
  });
  writeJson(join(backupRoot, 'notifications', 'notifications.json'), {
    version: 1,
    notifications: [
      { id: 'n1', source: 'workflow', severity: 'info', title: 'n1-local', body: '', link: { kind: 'workflow', workflowId: 'w1' }, ts: '2026-09-02T00:00:00.000Z', readAt: null },
      { id: 'n2', source: 'workflow', severity: 'error', title: 'n2', body: '', link: { kind: 'workflow', workflowId: 'w1' }, ts: '2026-09-03T00:00:00.000Z', readAt: null },
    ],
  });
  writeFile(join(backupRoot, 'notes', 'a.md'), 'LOCAL');
  writeJson(join(backupRoot, 'notes', 'trash.json'), {
    version: 1,
    entries: [{ id: 'tr_1', originalPath: 'x.md', deletedAt: TS, sizeBytes: 1 }],
  });
  writeFile(join(backupRoot, 'notes', '.trash', 'tr_1.md'), 'E1');
  writeJson(join(backupRoot, 'skills', 'disabled.json'), {
    version: 1,
    entries: [{ id: 'd_1', skillName: 'A', originalPath: join(backupRoot, 'gone'), kind: 'dir', affectedPlatforms: [], disabledAt: TS }],
  });
  writeJson(join(backupRoot, 'skills', 'trash.json'), { version: 1, entries: [] });
  writeJson(join(backupRoot, 'dismiss.json'), { hull: '2026-02-01' });

  // ── 包内 staging（incomingRoot） ──
  writeFile(join(incomingRoot, 'notes', 'a.md'), 'PACK');

  const report = applyMerge({
    userDataPath: userData,
    backupRoot,
    incomingRoot,
    settingsLocal: settings(userData),
    settingsIncoming: settings(userData, { closeToQuit: true, notesDir, theme: 'light' }),
    logger: NOOP_LOGGER,
    now: () => new Date(2026, 8, 18, 12, 30, 45),
    uuid: () => 'fixed-uuid',
  });

  // settings：包内覆盖 + notesDir 取包内路径
  const written = JSON.parse(readFileSync(join(userData, 'settings.json'), 'utf8')) as HullSettings;
  equal(written.closeToQuit, true);
  equal(written.theme, 'light');
  equal(written.notesDir, notesDir);

  // notes：本地保留原名，包内落冲突名
  equal(readFileSync(join(userData, 'notes', 'a.md'), 'utf8'), 'LOCAL');
  equal(readFileSync(join(userData, 'notes', 'a (恢复冲突 20260918-123045).md'), 'utf8'), 'PACK');
  equal(existsSync(join(userData, 'notes', '.trash', 'tr_1.md')), true);

  // skills：并集 + missingPath
  const disabled = JSON.parse(readFileSync(join(userData, 'skills', 'disabled.json'), 'utf8')) as { entries: Array<{ id: string; missingPath?: boolean }> };
  equal(disabled.entries.length, 1);
  equal(disabled.entries[0].missingPath, true);

  // workflows：id 冲突重 id
  const wfFile = JSON.parse(readFileSync(join(userData, 'workflows', 'workflows.json'), 'utf8')) as { workflows: Array<{ id: string; name: string }> };
  equal(wfFile.workflows.length, 2);
  ok(wfFile.workflows.some((w) => w.id === 'wf_fixed-uuid'));

  // notifications：去重追加
  const notifs = JSON.parse(readFileSync(join(userData, 'notifications', 'notifications.json'), 'utf8')) as { notifications: Array<{ id: string }> };
  equal(notifs.notifications.length, 2);

  // dismiss：逐通道取新
  const dismiss = JSON.parse(readFileSync(join(userData, 'dismiss.json'), 'utf8')) as { hull: string };
  equal(dismiss.hull, '2026-02-01');

  // kanban：包内基底 + 本地旧板重 id 追加
  const boards = JSON.parse(readFileSync(join(userData, 'kanban', 'boards.json'), 'utf8')) as { boards: Array<{ id: string; name: string }> };
  equal(boards.boards.length, 3);
  equal(boards.boards[0].id, 'b_pack');

  // 报告汇总
  for (const kind of ['note', 'kanban', 'workflow', 'setting'] as const) {
    ok(report.classes[kind].added > 0 || report.classes[kind].updated > 0, `${kind} 应有变更`);
  }
  // notif 独立计数：通知去重/裁剪不污染 workflow
  equal(report.classes.notif.added, 1); // n2 追加
  equal(report.classes.notif.skipped, 1); // n1 去重
  equal(report.classes.workflow.added, 1); // 仅工作流重 id
  ok(report.conflicts.some((c) => c.kind === 'notif' && c.id === 'n1'));
  ok(report.conflicts.length >= 3);
  equal(report.notices.length, 0);
});

test('applyMerge：包内缺 settings（incoming 无 notesDir）→ 保留本地 notesDir，不强制回退默认', () => {
  const userData = tmp('hull-merge-apply3-');
  const backupRoot = tmp('hull-merge-apply3-bak-');
  const incomingRoot = tmp('hull-merge-apply3-inc-');
  const localNotes = tmp('hull-merge-apply3-notes-');
  writeJson(join(userData, 'skills', 'disabled.json'), { version: 1, entries: [] });
  writeJson(join(userData, 'skills', 'trash.json'), { version: 1, entries: [] });

  const report = applyMerge({
    userDataPath: userData,
    backupRoot,
    incomingRoot,
    settingsLocal: settings(userData, { notesDir: localNotes }),
    settingsIncoming: {} as HullSettings, // runMerge 对包内无 settings.json 传 {}
    logger: NOOP_LOGGER,
    now: () => new Date(),
    uuid: () => 'u',
  });

  const written = JSON.parse(readFileSync(join(userData, 'settings.json'), 'utf8')) as HullSettings;
  equal(written.notesDir, localNotes);
  equal(report.notices.filter((n) => n.code === 'notes-dir-fallback').length, 0, '不产生回退 notice');
});

test('applyMerge：类抛错 → 异常上抛（交由执行器回滚，不半吞）', () => {
  const userData = tmp('hull-merge-apply2-');
  const backupRoot = tmp('hull-merge-apply2-bak-');
  const incomingRoot = tmp('hull-merge-apply2-inc-');
  writeJson(join(userData, 'kanban', 'boards.json'), { version: KANBAN_SCHEMA_VERSION, boards: [board('b_1', '包内板', [])] });
  // 本地预备份看板损坏 → mergeKanban 解析抛错 → applyMerge 整体失败
  writeFile(join(backupRoot, 'kanban', 'boards.json'), '{broken');
  writeJson(join(userData, 'skills', 'disabled.json'), { version: 1, entries: [] });
  writeJson(join(userData, 'skills', 'trash.json'), { version: 1, entries: [] });

  let thrown: Error | null = null;
  try {
    applyMerge({
      userDataPath: userData,
      backupRoot,
      incomingRoot,
      settingsLocal: settings(userData),
      settingsIncoming: settings(userData),
      logger: NOOP_LOGGER,
      now: () => new Date(),
      uuid: () => 'u',
    });
  } catch (err) {
    thrown = err as Error;
  }
  ok(thrown !== null);
});
