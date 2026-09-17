import { test, after } from 'node:test';
import { equal, match, ok } from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { buildManifest, type Manifest, type ManifestItem } from './manifest';
import { previewMigrations, resolveNotesDir, validateDataFiles } from './validators';

const dirs: string[] = [];
after(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

function tmp(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}

/** 合法包内容（相对包根；notes 项排除 trash.json，trash 归 notes-trash 项） */
const DEFAULT_PKG: Record<string, string> = {
  'settings.json': JSON.stringify({ schemaVersion: 3, theme: 'dark', notesDir: '/tmp/notes' }),
  'kanban/boards.json': JSON.stringify({
    version: 1,
    boards: [
      {
        id: 'b1',
        name: '默认看板',
        columns: [],
        tasks: [{ id: 't1', columnId: 'c1', order: 0, title: 'x' }],
        order: 0,
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
    ],
  }),
  'workflows/workflows.json': JSON.stringify({ version: 1, workflows: [] }),
  'notifications/notifications.json': JSON.stringify({ version: 1, notifications: [] }),
  'dismiss.json': JSON.stringify({ dsh: '2026-01-01T00:00:00.000Z' }),
  'notes/a.md': '# a\n',
  'notes/sub/b.md': '# b\n',
  'notes/trash.json': JSON.stringify({
    entries: [{ id: 'tr_1', originalPath: 'a.md', deletedAt: '2026-01-01T00:00:00.000Z', sizeBytes: 1 }],
  }),
  'skills/disabled.json': JSON.stringify({ version: 1, entries: [] }),
  'skills/trash.json': JSON.stringify({
    version: 1,
    entries: [{ id: 'tr_1', originalPath: '/x/skill', deletedAt: '2026-01-01T00:00:00.000Z' }],
  }),
  'skills/trash/tr_1/SKILL.md': '# skill\n',
};

function writePkg(root: string, patch: Record<string, string> = {}): void {
  for (const [rel, content] of Object.entries({ ...DEFAULT_PKG, ...patch })) {
    const abs = join(root, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  }
}

/** 按实际文件与 B1 枚举规则（手写镜像）生成 manifest；mutate 可在 buildManifest 前改 items */
function mkManifest(root: string, mutate?: (items: ManifestItem[]) => ManifestItem[]): Manifest {
  const sz = (rel: string): number => statSync(join(root, rel)).size;
  const items: ManifestItem[] = [
    { id: 'settings', path: 'settings.json', kind: 'file', version: 3, size: sz('settings.json'), fileCount: 1 },
    { id: 'kanban', path: 'kanban/boards.json', kind: 'file', version: 1, size: sz('kanban/boards.json'), fileCount: 1 },
    {
      id: 'workflows',
      path: 'workflows/workflows.json',
      kind: 'file',
      version: 1,
      size: sz('workflows/workflows.json'),
      fileCount: 1,
    },
    { id: 'notes', path: 'notes', kind: 'tree', version: null, size: sz('notes/a.md') + sz('notes/sub/b.md'), fileCount: 2 },
    { id: 'notes-trash', path: 'notes', kind: 'tree', version: null, size: sz('notes/trash.json'), fileCount: 1 },
    {
      id: 'skills',
      path: '.',
      kind: 'tree',
      version: null,
      size: sz('skills/disabled.json') + sz('skills/trash.json') + sz('skills/trash/tr_1/SKILL.md'),
      fileCount: 3,
    },
    {
      id: 'notifs',
      path: '.',
      kind: 'tree',
      version: 1,
      size: sz('notifications/notifications.json') + sz('dismiss.json'),
      fileCount: 2,
    },
  ];
  return buildManifest({
    appVersion: '0.1.9',
    platform: 'darwin',
    exportedAt: new Date('2026-09-18T00:00:00.000Z'),
    notesDirHint: '/tmp/notes',
    items: mutate ? mutate(items) : items,
  });
}

function validate(root: string, manifest: Manifest): ReturnType<typeof validateDataFiles> {
  return validateDataFiles({ stagedRoot: root, manifest, userDataPath: join(root, 'userData') });
}

test('validateDataFiles：合法包通过 + notices 空', () => {
  const root = tmp('hull-val-');
  writePkg(root);
  const out = validate(root, mkManifest(root));
  equal(out.ok, true);
  if (out.ok) equal(out.notices.length, 0);
});

test('validateDataFiles：size / fileCount 与 manifest 不一致 → 拒绝', () => {
  const root = tmp('hull-val-size-');
  writePkg(root);
  const sizeOut = validate(
    root,
    mkManifest(root, (items) => items.map((i) => (i.id === 'settings' ? { ...i, size: i.size + 1 } : i)))
  );
  equal(sizeOut.ok, false);
  if (!sizeOut.ok) {
    equal(sizeOut.code, 'restore-manifest-invalid');
    match(sizeOut.message, /settings/);
  }

  const root2 = tmp('hull-val-count-');
  writePkg(root2);
  writePkg(root2, { 'notes/c.md': '# c\n' }); // 包内多出未计入项的文件
  const countOut = validate(root2, mkManifest(root2));
  equal(countOut.ok, false);
  if (!countOut.ok) match(countOut.message, /notes/);
});

test('validateDataFiles：JSON 顶层结构非法 → 拒绝（表驱动）', () => {
  for (const [name, patch] of [
    ['settings 缺 schemaVersion', { 'settings.json': JSON.stringify({ theme: 'dark' }) }],
    ['settings 非对象', { 'settings.json': '[]' }],
    ['boards 缺 version', { 'kanban/boards.json': JSON.stringify({ boards: [] }) }],
    ['boards 非数组', { 'kanban/boards.json': JSON.stringify({ version: 2, boards: {} }) }],
    ['workflows 缺 workflows', { 'workflows/workflows.json': JSON.stringify({ version: 1 }) }],
    ['notifications 缺数组', { 'notifications/notifications.json': JSON.stringify({ version: 1 }) }],
    ['JSON 损坏', { 'settings.json': '{ oops' }],
  ] as const) {
    const root = tmp('hull-val-struct-');
    writePkg(root, patch as Record<string, string>);
    const out = validate(root, mkManifest(root));
    equal(out.ok, false, name);
    if (!out.ok) equal(out.code, 'restore-manifest-invalid', name);
  }
});

test('validateDataFiles：trash 条目形状非法 → 拒绝（notes / skills）', () => {
  const root = tmp('hull-val-trash-');
  writePkg(root, { 'notes/trash.json': JSON.stringify({ entries: [{ id: 1 }] }) });
  equal(validate(root, mkManifest(root)).ok, false);

  // notes 条目缺 sizeBytes（NotesTrash 加载器视为损坏丢弃）→ 整包拒绝（与 merge/notes.ts 同口径）
  const rootMissingSize = tmp('hull-val-trash-size-');
  writePkg(rootMissingSize, {
    'notes/trash.json': JSON.stringify({ entries: [{ id: 'tr_1', originalPath: 'a.md', deletedAt: '2026-01-01T00:00:00.000Z' }] }),
  });
  const missingSizeOut = validate(rootMissingSize, mkManifest(rootMissingSize));
  equal(missingSizeOut.ok, false);
  if (!missingSizeOut.ok) match(missingSizeOut.message, /sizeBytes/);

  const root2 = tmp('hull-val-trash2-');
  writePkg(root2, { 'skills/trash.json': JSON.stringify({ version: 1, entries: [{ id: 'tr_1' }] }) });
  equal(validate(root2, mkManifest(root2)).ok, false);

  const root3 = tmp('hull-val-trash3-');
  writePkg(root3, { 'skills/trash.json': JSON.stringify({ entries: [] }) }); // 缺 version
  equal(validate(root3, mkManifest(root3)).ok, false);
});

test('validateDataFiles：notes 含非 md（打包侧已过滤）→ 伪造计入 manifest 因计数不符整包拒绝', () => {
  const root = tmp('hull-val-md-');
  writePkg(root, { 'notes/readme.txt': 'not md' });
  const manifest = mkManifest(root, (items) =>
    items.map((i) =>
      i.id === 'notes' ? { ...i, fileCount: 3, size: i.size + statSync(join(root, 'notes/readme.txt')).size } : i
    )
  );
  const out = validate(root, manifest);
  equal(out.ok, false);
  if (!out.ok) match(out.message, /notes/);
});

test('validateDataFiles：守卫断言拒绝伪造全量包（表驱动）', () => {
  const cases: Array<[string, Record<string, string>]> = [
    ['dsh/', { 'dsh/settings.json': '{}' }],
    ['node/', { 'node/bin/node': 'x' }],
    ['corepack/', { 'corepack/x': 'x' }],
    ['Partitions/', { 'Partitions/shell/LOG': 'x' }],
    ['.restore/', { '.restore/pending.json': '{}' }],
    ['token-buckets.json', { 'token-buckets.json': '{}' }],
    ['skills/hash-cache.json', { 'skills/hash-cache.json': '{}' }],
    ['skills/remote-sig-cache.json', { 'skills/remote-sig-cache.json': '{}' }],
    ['skills/staging/', { 'skills/staging/x/SKILL.md': '# x' }],
    ['kanban/executions/', { 'kanban/executions/e1.json': '{}' }],
    ['workflows/runs.json', { 'workflows/runs.json': '{}' }],
    ['logs/', { 'logs/hull.log': 'x' }],
  ];
  for (const [name, patch] of cases) {
    const root = tmp('hull-val-guard-');
    writePkg(root);
    writePkg(root, patch);
    const out = validate(root, mkManifest(root));
    equal(out.ok, false, name);
    if (!out.ok) match(out.message, /守卫断言/, name);
  }
});

test('resolveNotesDir：四种分支（合法 / 相对 / 禁区 / 不存在）', () => {
  const userData = tmp('hull-val-notes-');
  const existsAll = { userDataPath: userData, exists: () => true };

  const good = resolveNotesDir(join(userData, 'custom-notes'), existsAll);
  equal(good.value, join(userData, 'custom-notes'));
  equal(good.fallback, null);
  equal(good.notice, null);

  for (const [name, raw, exists] of [
    ['相对路径', 'relative/notes', true],
    ['空字符串', '', true],
    ['禁区（<userData>/dsh 内）', join(userData, 'dsh', 'sub'), true],
    ['不存在', join(userData, 'gone'), false],
  ] as const) {
    const r = resolveNotesDir(raw, { userDataPath: userData, exists: () => exists });
    equal(r.value, join(userData, 'notes'), name);
    equal(r.fallback, join(userData, 'notes'), name);
    equal(r.notice?.code, 'notes-dir-fallback', name);
  }
});

test('previewMigrations：低版本预演通过（settings 3→4 / boards 1→2，值保留）', () => {
  const userData = tmp('hull-val-prev-');
  const out = previewMigrations({
    settingsRaw: { schemaVersion: 3, theme: 'light', closeToQuit: true },
    boardsRaw: {
      version: 1,
      boards: [{ id: 'b1', name: '默认看板', columns: [], tasks: [{ id: 't1', title: 'x' }], order: 0 }],
    },
    workflowsRaw: { version: 1, workflows: [] },
    userDataPath: userData,
  });
  equal(out.ok, true);
  if (out.ok) {
    equal(out.settings.schemaVersion, 4);
    equal(out.settings.theme, 'light');
    equal(out.settings.closeToQuit, true);
    equal(out.settings.notesDir, join(userData, 'notes')); // 缺省补齐
    equal(out.boards.version, 2);
    equal(out.boards.boards[0].tasks[0].startDate, null);
    equal(out.boards.boards[0].tasks[0].title, 'x');
  }
});

test('previewMigrations：boards 高版本 / 结构非法 / workflows 结构非法 → 拒绝（不抛）', () => {
  const userData = tmp('hull-val-prev2-');
  const base = { settingsRaw: { schemaVersion: 4 }, workflowsRaw: { version: 1, workflows: [] }, userDataPath: userData };

  const newer = previewMigrations({ ...base, boardsRaw: { version: 3, boards: [] } });
  equal(newer.ok, false);
  if (!newer.ok) {
    equal(newer.code, 'restore-migrate-preview-failed');
    match(newer.message, /高于当前/);
  }

  const broken = previewMigrations({ ...base, boardsRaw: { version: 1 } });
  equal(broken.ok, false);
  if (!broken.ok) equal(broken.code, 'restore-migrate-preview-failed');

  const badTasks = previewMigrations({ ...base, boardsRaw: { version: 1, boards: [{}] } });
  equal(badTasks.ok, false, 'boards[].tasks 缺失 → 迁移抛错被兜底');

  const badWorkflows = previewMigrations({ ...base, boardsRaw: { version: 2, boards: [] }, workflowsRaw: { version: 1 } });
  equal(badWorkflows.ok, false);
});

test('previewMigrations：可选项缺失（null）→ 默认值预演通过', () => {
  const userData = tmp('hull-val-prev3-');
  const out = previewMigrations({ settingsRaw: null, boardsRaw: null, workflowsRaw: null, userDataPath: userData });
  equal(out.ok, true);
  if (out.ok) {
    equal(out.settings.notesDir, join(userData, 'notes'));
    equal(out.settings.schemaVersion, 4);
    equal(out.boards.version, 2);
    equal(out.boards.boards.length, 0);
  }
});
