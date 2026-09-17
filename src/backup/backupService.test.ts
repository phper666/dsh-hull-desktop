import { test, after } from 'node:test';
import { deepEqual, equal, ok, rejects } from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { NOOP_LOGGER } from '../shared/types';

import { BackupService, type BackupServiceDeps } from './backupService';
import { BackupError } from './errors';
import { MANIFEST_FILENAME, parseManifest } from './manifest';

const tempDirs: string[] = [];
after(() => {
  for (const d of tempDirs) rmSync(d, { recursive: true, force: true });
});

function mkTemp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

/** 全 7 项都有源文件的临时 userData */
function makeProfile(): string {
  const ud = mkTemp('hull-bk-ud-');
  writeFileSync(join(ud, 'settings.json'), JSON.stringify({ schemaVersion: 4, theme: 'dark', notesDir: join(ud, 'notes') }));
  mkdirSync(join(ud, 'kanban'));
  writeFileSync(join(ud, 'kanban', 'boards.json'), JSON.stringify({ version: 2, boards: [] }));
  mkdirSync(join(ud, 'workflows'));
  writeFileSync(join(ud, 'workflows', 'workflows.json'), JSON.stringify({ version: 1, workflows: [] }));
  mkdirSync(join(ud, 'notes', '.trash'), { recursive: true });
  writeFileSync(join(ud, 'notes', 'a.md'), '# a');
  writeFileSync(join(ud, 'notes', '.DS_Store'), 'x');
  writeFileSync(join(ud, 'notes', 'pic.png'), 'x');
  writeFileSync(join(ud, 'notes', 'note.txt'), 'x');
  writeFileSync(join(ud, 'notes', 'trash.json'), JSON.stringify({ entries: [] }));
  writeFileSync(join(ud, 'notes', '.trash', 'tr_1.md'), 'x');
  mkdirSync(join(ud, 'skills', 'trash', 'tr_1'), { recursive: true });
  mkdirSync(join(ud, 'skills', 'disabled', 'd_1'), { recursive: true });
  writeFileSync(join(ud, 'skills', 'disabled.json'), JSON.stringify({ version: 1, entries: [] }));
  writeFileSync(join(ud, 'skills', 'disabled', 'd_1', 'SKILL.md'), 'x');
  writeFileSync(join(ud, 'skills', 'trash.json'), JSON.stringify({ version: 1, entries: [] }));
  writeFileSync(join(ud, 'skills', 'trash', 'tr_1', 'SKILL.md'), 'x');
  writeFileSync(join(ud, 'skills', 'hash-cache.json'), '{}');
  mkdirSync(join(ud, 'notifications'));
  writeFileSync(join(ud, 'notifications', 'notifications.json'), JSON.stringify({ version: 1, notifications: [] }));
  writeFileSync(join(ud, 'dismiss.json'), JSON.stringify({ dsh: '2026-09-17' }));
  return ud;
}

const gateOpen = {
  hasRunningExecutions: () => false,
  isInstallOrUpgradeActive: () => false,
  isSkillsUpgradeActive: () => false,
  isHullUpdateActive: () => false,
  hasPendingRestore: () => false,
};

function makeService(userDataPath: string, over: Partial<BackupServiceDeps> = {}) {
  const calls = { flush: 0 };
  const service = new BackupService({
    userDataPath,
    notesDir: () => join(userDataPath, 'notes'),
    flushAll: () => {
      calls.flush++;
    },
    gate: gateOpen,
    logger: NOOP_LOGGER,
    appVersion: '0.1.9',
    now: () => new Date('2026-09-18T10:20:30.000Z'),
    ...over,
  });
  return { service, calls };
}

const rejectCode = (code: string) => (err: unknown): boolean => {
  equal((err as BackupError).code, code);
  return true;
};

test('run happy path：7 项齐全 + manifest 可解析 + 守卫断言', async () => {
  const ud = makeProfile();
  const target = mkTemp('hull-bk-target-');
  const { service, calls } = makeService(ud);
  const res = await service.run({ targetDir: target });

  equal(calls.flush, 1); // flushAll 在拷贝前调用
  ok(res.backupDir.startsWith(join(target, 'Hull备份-')), res.backupDir);
  equal(existsSync(join(res.backupDir, MANIFEST_FILENAME)), true);

  const parsed = parseManifest(JSON.parse(readFileSync(join(res.backupDir, MANIFEST_FILENAME), 'utf8')));
  ok(parsed.ok);
  if (!parsed.ok) return;
  deepEqual(parsed.value.items.map((i) => i.id), [
    'settings',
    'kanban',
    'workflows',
    'notes',
    'notes-trash',
    'skills',
    'notifs',
  ]);
  equal(parsed.value.counts.files, 12);
  equal(parsed.value.counts.bytes, parsed.value.items.reduce((s, i) => s + i.size, 0));
  const byId = new Map(parsed.value.items.map((i) => [i.id, i]));
  equal(byId.get('settings')?.version, 4);
  equal(byId.get('kanban')?.version, 2);
  equal(byId.get('workflows')?.version, 1);
  equal(byId.get('notifs')?.version, 1);
  equal(byId.get('notes')?.path, 'notes');

  for (const rel of [
    'settings.json',
    'kanban/boards.json',
    'workflows/workflows.json',
    'notes/a.md',
    'notes/trash.json',
    'notes/.trash/tr_1.md',
    'skills/disabled.json',
    'skills/disabled/d_1/SKILL.md',
    'skills/trash.json',
    'skills/trash/tr_1/SKILL.md',
    'notifications/notifications.json',
    'dismiss.json',
  ]) {
    equal(existsSync(join(res.backupDir, rel)), true, rel);
  }
  // notes 项仅 md：源内非 md 不入包（打包与校验同源枚举）
  for (const rel of ['notes/.DS_Store', 'notes/pic.png', 'notes/note.txt']) {
    equal(existsSync(join(res.backupDir, rel)), false, rel);
  }
  equal(byId.get('notes')?.fileCount, 1, 'notes 项仅 a.md');
  // 守卫断言：包内不得出现非白名单内容
  for (const rel of ['dsh', 'node', 'token-buckets.json', 'skills/hash-cache.json', 'kanban/executions', 'logs']) {
    equal(existsSync(join(res.backupDir, rel)), false, rel);
  }
});

test('run：目标在 userData 内 → backup-target-inside-userdata，零写入', async () => {
  const ud = makeProfile();
  const target = join(ud, 'inside-target');
  const { service } = makeService(ud);
  await rejects(service.run({ targetDir: target }), rejectCode('backup-target-inside-userdata'));
  equal(existsSync(target), false);
});

test('run：目标只读 → backup-target-unwritable，零残留', async () => {
  const ud = makeProfile();
  const target = mkTemp('hull-bk-ro-');
  chmodSync(target, 0o500);
  try {
    const { service } = makeService(ud);
    await rejects(service.run({ targetDir: target }), rejectCode('backup-target-unwritable'));
    deepEqual(readdirSync(target), []);
  } finally {
    chmodSync(target, 0o700);
  }
});

test('run：门控不通过 → backup-busy，零写入且不 flush', async () => {
  const ud = makeProfile();
  const target = mkTemp('hull-bk-target-');
  const { service, calls } = makeService(ud, { gate: { ...gateOpen, hasRunningExecutions: () => true } });
  await rejects(service.run({ targetDir: target }), rejectCode('backup-busy'));
  deepEqual(readdirSync(target), []);
  equal(calls.flush, 0);
});

test('run：注入写失败 → backup-failed + 本次目录清理 + 现数据不变', async () => {
  process.env.HULL_E2E = '1';
  try {
    const ud = makeProfile();
    const before = readFileSync(join(ud, 'settings.json'), 'utf8');
    const target = mkTemp('hull-bk-target-');
    const { service } = makeService(ud, { failAt: 'backup-copy' });
    await rejects(service.run({ targetDir: target }), rejectCode('backup-failed'));
    equal(readdirSync(target).some((n) => n.startsWith('Hull备份-')), false);
    equal(readFileSync(join(ud, 'settings.json'), 'utf8'), before);
  } finally {
    delete process.env.HULL_E2E;
  }
});

test('run：failAt 仅在 HULL_E2E=1 生效（生产忽略）', async () => {
  delete process.env.HULL_E2E;
  const ud = makeProfile();
  const target = mkTemp('hull-bk-target-');
  const { service } = makeService(ud, { failAt: 'backup-copy' });
  const res = await service.run({ targetDir: target });
  equal(existsSync(join(res.backupDir, MANIFEST_FILENAME)), true);
});

test('run：重名自增 -2 后缀', async () => {
  const ud = makeProfile();
  const target = mkTemp('hull-bk-target-');
  const { service } = makeService(ud);
  const first = await service.run({ targetDir: target });
  const second = await service.run({ targetDir: target });
  ok(first.backupDir !== second.backupDir);
  ok(second.backupDir.endsWith('-2'), second.backupDir);
});

test('run：notes 外置 → notes 项不进包，notes-trash 仍打包', async () => {
  const ud = makeProfile();
  const target = mkTemp('hull-bk-target-');
  const external = mkTemp('hull-bk-ext-');
  const { service } = makeService(ud, { notesDir: () => external });
  const res = await service.run({ targetDir: target });
  equal(res.manifest.items.some((i) => i.id === 'notes'), false);
  equal(existsSync(join(res.backupDir, 'notes', 'a.md')), false);
  equal(res.manifest.items.some((i) => i.id === 'notes-trash'), true);
  equal(existsSync(join(res.backupDir, 'notes', 'trash.json')), true);
});

test('cleanupOrphans：删孤儿/失败残留 + 仅保留最近 keep 个有效包', () => {
  const target = mkTemp('hull-bk-target-');
  const mk = (name: string, withManifest: boolean): void => {
    mkdirSync(join(target, name));
    if (withManifest) writeFileSync(join(target, name, MANIFEST_FILENAME), '{}');
  };
  mk('Hull备份-20260101-000000', false); // 孤儿（无 manifest）
  mk('Hull备份-20260101-000001', true);
  mk('Hull备份-20260101-000002', true);
  mk('Hull备份-20260101-000003.failed-1', false); // 失败残留
  mkdirSync(join(target, '不相关目录'));
  const { service } = makeService(mkTemp('hull-bk-ud-'));
  equal(service.cleanupOrphans(target, 1), 3);
  deepEqual(
    readdirSync(target).sort(),
    ['Hull备份-20260101-000002', '不相关目录'].sort()
  );
});
