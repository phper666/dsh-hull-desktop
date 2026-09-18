/**
 * B5 integration —— B2 恢复运行期校验/执行（设计 §7.2 场景表 + 验收②③④）：
 * 备份→replace 全链路 / 高版本拒绝不写标记 / 迁移预演失败不写标记 / 守卫断言 / 低版本迁移通过。
 * 运行期零数据副作用（仅 `.restore/pending.json`）；拒绝路径现数据 hash 前后不变。
 */
import { test, after } from 'node:test';
import { deepEqual, equal, ok, rejects } from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { BackupError } from '../../../src/backup/errors';
import { MANIFEST_FILENAME, type Manifest } from '../../../src/backup/manifest';
import { readPending, type PendingFile, type RestoreResult } from '../../../src/backup/result';
import { runRestoreIfPending } from '../../../src/backup/restoreExecutor';
import { migrateKanbanData } from '../../../src/kanban/KanbanStore';
import { KANBAN_SCHEMA_VERSION } from '../../../src/kanban/types';
import { migrateSettingsObject, SCHEMA_VERSION_CURRENT } from '../../../src/settings/SettingsProvider';
import { NOOP_LOGGER } from '../../../src/shared/types';

import {
  cleanupTempDirs,
  makeRestoreService,
  mkTemp,
  pkgManifest,
  readJson,
  runBackup,
  seedFixture,
  treeHash,
  writeJson,
  writePackage,
} from './_helpers';

after(cleanupTempDirs);

function isBackupError(e: unknown, code: string): boolean {
  return e instanceof BackupError && e.code === code;
}

test('⑥ 备份→replace 恢复全链路：settings=包内 + boards 版本正确 + .restore/backup（验收②③④）', async () => {
  const src = mkTemp('hull-rs-src-');
  const pkgParent = mkTemp('hull-rs-pkg-');
  const pkgBoards = {
    version: KANBAN_SCHEMA_VERSION,
    boards: [{ id: 'b1', name: '包内板', columns: [], tasks: [], order: 0, createdAt: '2026-01-01', updatedAt: '2026-01-01' }],
  };
  seedFixture(src, {
    settings: { theme: 'dark', notesDir: join(src, 'notes') }, // 包内 notesDir 有效 → 恢复后原样保留（§3.4）
    boards: pkgBoards,
    notes: { 'hello.md': '# hello' },
  });
  const pkg = await runBackup(src, pkgParent);

  const target = mkTemp('hull-rs-tgt-');
  seedFixture(target, { settings: { theme: 'light' } });
  const before = treeHash(target);
  const svc = makeRestoreService(target);

  const req = await svc.request({ sourceDir: pkg.backupDir, mode: 'replace' });
  equal(req.pending.step, 'requested');
  equal(req.pending.phase, 'forward');
  const pending = readPending(target);
  ok(pending, 'pending.json 已写');
  equal(pending!.step, 'requested');
  equal(treeHash(target), before, '运行期零数据副作用（仅 .restore 标记）');

  const outcome = runRestoreIfPending({ userDataPath: target, logger: NOOP_LOGGER });
  equal(outcome.status, 'success');

  // 验收④：result.json 存在且 status 正确；pending 已清
  const result = readJson<RestoreResult>(join(target, '.restore', 'result.json'));
  equal(result.status, 'success');
  equal(result.mode, 'replace');
  deepEqual(result.notices, [], 'notesDir 有效 → 无回退提示');
  equal(readPending(target), null);

  // 验收②：settings = 包内、boards 迁移至当前版本；R3：成功后 backup 已归档（result.bakDir 指向归档）
  deepEqual(readJson(join(target, 'settings.json')), readJson(join(pkg.backupDir, 'settings.json')));
  equal(readJson<{ theme: string }>(join(target, 'settings.json')).theme, 'dark');
  const boards = readJson<{ version: number; boards: Array<{ name: string }> }>(join(target, 'kanban', 'boards.json'));
  equal(boards.version, KANBAN_SCHEMA_VERSION);
  equal(boards.boards[0]?.name, '包内板');
  ok(result.bakDir, 'result.bakDir 指向归档路径');
  ok(existsSync(join(result.bakDir!, 'settings.json')), '归档 backup-<ts> 存在（原数据可人工兜底）');
  equal(readJson<{ theme: string }>(join(result.bakDir!, 'settings.json')).theme, 'light');
  ok(!existsSync(join(target, '.restore', 'backup')), '活跃 .restore/backup 不存在');
  equal(readJson<{ boards: unknown[] }>(join(target, 'kanban', 'boards.json')).boards.length, 1);
});

test('⑦b notesDir 红线：包内 notesDir 不存在 → 回退默认目录 + result.notices 提示（§3.4）', async () => {
  const pkg = mkTemp('hull-rs-pkg-');
  writePackage(pkg, { settings: { theme: 'dark', notesDir: join(pkg, 'notes-gone') } });

  const target = mkTemp('hull-rs-tgt-');
  seedFixture(target, { settings: { theme: 'light' } });

  const svc = makeRestoreService(target);
  const preview = await svc.inspect({ sourceDir: pkg, mode: 'replace' });
  equal(preview.notesDirFallback, join(target, 'notes'), '预演即提示回退目录');
  await svc.request({ sourceDir: pkg, mode: 'replace' });

  const outcome = runRestoreIfPending({ userDataPath: target, logger: NOOP_LOGGER });
  equal(outcome.status, 'success');
  const settings = readJson<{ notesDir: string }>(join(target, 'settings.json'));
  equal(settings.notesDir, join(target, 'notes'), '回退默认目录已原子写回');
  const result = readJson<RestoreResult>(join(target, '.restore', 'result.json'));
  equal(result.status, 'success');
  ok(
    result.notices.some((n) => n.code === 'notes-dir-fallback'),
    'result.notices 含 notes-dir-fallback（数据卡提示重选依据）',
  );
});

test('⑦ 高版本包拒绝：restore-version-newer + 不写标记 + 现数据 hash 不变（验收③）', async () => {
  const src = mkTemp('hull-rs-src-');
  const pkgParent = mkTemp('hull-rs-pkg-');
  seedFixture(src);
  const pkg = await runBackup(src, pkgParent);

  // 篡改包格式版本（结构仍合法，确保命中兼容性校验而非 manifest 解析）
  const mfPath = join(pkg.backupDir, MANIFEST_FILENAME);
  writeJson(mfPath, { ...readJson<Manifest>(mfPath), manifestVersion: 2 });

  const target = mkTemp('hull-rs-tgt-');
  seedFixture(target);
  const before = treeHash(target);

  await rejects(makeRestoreService(target).request({ sourceDir: pkg.backupDir, mode: 'replace' }), (e) =>
    isBackupError(e, 'restore-version-newer'),
  );

  ok(!existsSync(join(target, '.restore')), '不写 pending（无 .restore）');
  equal(treeHash(target), before, '现数据 hash 不变');
});

test('⑧ 迁移预演失败（包内 boards.version=3）：restore-migrate-preview-failed + 不写标记', async () => {
  const pkg = mkTemp('hull-rs-pkg-');
  // manifest 项版本标 ≤ 当前（兼容性放行），实际文件版本 3 → 冲突由预演捕获
  writePackage(pkg, { boards: { version: 3, boards: [] } }, { kanban: KANBAN_SCHEMA_VERSION });

  const target = mkTemp('hull-rs-tgt-');
  seedFixture(target);
  const before = treeHash(target);

  await rejects(makeRestoreService(target).request({ sourceDir: pkg, mode: 'replace' }), (e) =>
    isBackupError(e, 'restore-migrate-preview-failed'),
  );

  ok(!existsSync(join(target, '.restore')), '不写标记');
  ok(!existsSync(join(target, '.restore', 'backup')), '不触发 backupAndRebuild');
  equal(treeHash(target), before, '现数据 hash 不变');
});

test('⑨ 守卫断言：伪造含 token-buckets.json / dsh/ 的包 → 整包拒绝（不写标记）', async () => {
  for (const extra of ['token-buckets.json', 'dsh/bin/dsh', 'Partitions/shell/data.json']) {
    const pkg = mkTemp('hull-rs-pkg-');
    writePackage(pkg);
    writeJson(join(pkg, ...extra.split('/')), { forged: true });

    const target = mkTemp('hull-rs-tgt-');
    seedFixture(target);
    const before = treeHash(target);

    await rejects(makeRestoreService(target).request({ sourceDir: pkg, mode: 'replace' }), (e) => {
      ok(e instanceof BackupError && e.code === 'restore-manifest-invalid', `伪造项 ${extra} 应拒绝：${String(e)}`);
      ok(/禁止路径/.test((e as Error).message), 'message 指明守卫断言');
      return true;
    });

    ok(!existsSync(join(target, '.restore')), `伪造项 ${extra}：不写 pending`);
    equal(treeHash(target), before, `伪造项 ${extra}：现数据 hash 不变`);
  }
});

test('⑩ 低版本迁移通过：settings v3 + boards v1 预演通过 → 恢复后内容保留，迁移函数升至当前', async () => {
  const pkg = mkTemp('hull-rs-pkg-');
  const v1Board = {
    id: 'b1',
    name: 'v1 板',
    columns: [],
    tasks: [{ id: 't1', title: '任务', columnId: 'c_todo', order: 0 }],
    order: 0,
    createdAt: '2026-01-01',
    updatedAt: '2026-01-01',
  };
  writePackage(
    pkg,
    { settings: { schemaVersion: 3, theme: 'dark' }, boards: { version: 1, boards: [v1Board] } },
    { settings: 3, kanban: 1 },
  );

  const target = mkTemp('hull-rs-tgt-');
  seedFixture(target, { settings: { schemaVersion: 4 } });
  const svc = makeRestoreService(target);

  await svc.inspect({ sourceDir: pkg, mode: 'replace' }); // 预演通过（不抛）
  await svc.request({ sourceDir: pkg, mode: 'replace' });
  const outcome = runRestoreIfPending({ userDataPath: target, logger: NOOP_LOGGER });
  equal(outcome.status, 'success');

  // 启动期迁移（bootstrap 的 settings.migrate() / KanbanStore 构造与这两个函数同源）
  const settings = migrateSettingsObject(readJson<Record<string, unknown>>(join(target, 'settings.json')), target);
  equal(settings.schemaVersion, SCHEMA_VERSION_CURRENT);
  equal(settings.theme, 'dark', '内容值保留');
  const boards = migrateKanbanData(readJson(join(target, 'kanban', 'boards.json')));
  equal(boards.version, KANBAN_SCHEMA_VERSION);
  equal(boards.boards[0]?.name, 'v1 板', '看板内容保留');
  equal(boards.boards[0]?.tasks[0]?.startDate, null, 'v1→v2 迁移补齐 startDate');

  const result = readJson<RestoreResult>(join(target, '.restore', 'result.json'));
  equal(result.status, 'success');
  ok(result.bakDir, 'result.bakDir 指向归档路径');
  ok(existsSync(result.bakDir!), '.restore/backup 已归档');
  ok(!existsSync(join(target, '.restore', 'backup')), '活跃 .restore/backup 不存在');
});

test('⑪ 手工包 manifest 与包实际一致（pkgManifest 自检：integration fixture 可信）', () => {
  const pkg = mkTemp('hull-rs-pkg-');
  const manifest = writePackage(pkg);
  const roundtrip = pkgManifest(pkg);
  deepEqual(roundtrip.items, manifest.items);
  equal(manifest.counts.files, manifest.items.reduce((n, i) => n + i.fileCount, 0));
});
