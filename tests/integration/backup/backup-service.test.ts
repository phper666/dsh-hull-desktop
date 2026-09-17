/**
 * B5 integration —— B1 备份服务（设计 §7.2 场景表 + 验收①/③）：
 * happy（7 项 + manifest + 排除 dsh/Cache/token-buckets）/ 只读目标拒 / 目标在 userData 内拒 /
 * 注入拷贝失败清理 / 注入仅 HULL_E2E=1 生效。
 * 真 FS + 临时目录；不 mock 文件系统。
 */
import { test, after } from 'node:test';
import { deepEqual, equal, ok, rejects } from 'node:assert/strict';
import { chmodSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { BackupError } from '../../../src/backup/errors';
import { MANIFEST_FILENAME, type Manifest } from '../../../src/backup/manifest';

import {
  cleanupTempDirs,
  listTree,
  makeBackupService,
  mkTemp,
  readJson,
  runBackup,
  seedFixture,
  treeHash,
} from './_helpers';

after(cleanupTempDirs);

function isBackupError(e: unknown, code: string): boolean {
  return e instanceof BackupError && e.code === code;
}

test('① 备份 happy：7 项 + manifest.json，不含 dsh/Cache/token-buckets（验收①）', async () => {
  const ud = mkTemp('hull-bk-ud-');
  const target = mkTemp('hull-bk-tgt-');
  seedFixture(ud, {
    extras: {
      'dsh/bin/dsh': 'fake-bin',
      'token-buckets.json': '{"tokens":1}',
      'Cache/blob.bin': 'cache',
      'notes/.trash/deleted.md': '# deleted',
      'skills/trash/s1/SKILL.md': '# trashed skill',
    },
  });
  const before = treeHash(ud);

  const r = await runBackup(ud, target);

  // 7 项白名单（CON-R-backup-001）
  deepEqual(
    r.manifest.items.map((i) => i.id).sort(),
    ['kanban', 'notes', 'notes-trash', 'notifs', 'settings', 'skills', 'workflows'],
  );
  ok(existsSync(join(r.backupDir, MANIFEST_FILENAME)), 'manifest.json 存在（完成标记）');
  const onDisk = readJson<Manifest>(join(r.backupDir, MANIFEST_FILENAME));
  deepEqual(onDisk.items.map((i) => i.id).sort(), r.manifest.items.map((i) => i.id).sort());

  // 排除项断言：非白名单内容零进入
  const rels = listTree(r.backupDir);
  ok(rels.every((p) => !p.startsWith('dsh/')), `包内不应含 dsh/：${rels.join(',')}`);
  ok(!rels.includes('token-buckets.json'), '包内不应含 token-buckets.json');
  ok(rels.every((p) => !p.startsWith('Cache/')), '包内不应含 Cache/');

  // notes 项排除 .trash/ 与 trash.json（归 notes-trash 项）
  const notes = r.manifest.items.find((i) => i.id === 'notes');
  equal(notes?.fileCount, 1, 'notes 项仅 a.md');
  const notesTrash = r.manifest.items.find((i) => i.id === 'notes-trash');
  equal(notesTrash?.fileCount, 2, 'notes-trash 项含 trash.json + .trash/**');

  // counts 一致 + 现数据 hash 不变
  equal(onDisk.counts.files, onDisk.items.reduce((n, i) => n + i.fileCount, 0));
  equal(treeHash(ud), before, '备份不改动现数据');
});

test('② 只读目标：backup-target-unwritable，目标零残留 + 现数据 hash 不变（验收③）', async (t) => {
  if (typeof process.getuid === 'function' && process.getuid() === 0) {
    t.skip('root 下权限位不生效');
    return;
  }
  const ud = mkTemp('hull-bk-ud-');
  const target = mkTemp('hull-bk-ro-');
  seedFixture(ud);
  const before = treeHash(ud);
  chmodSync(target, 0o500);
  try {
    await rejects(makeBackupService(ud).run({ targetDir: target }), (e) => isBackupError(e, 'backup-target-unwritable'));
    equal(readdirSync(target).length, 0, '目标零残留');
    equal(treeHash(ud), before, '现数据 hash 不变');
  } finally {
    chmodSync(target, 0o700);
  }
});

test('③ 目标在 userData 内：backup-target-inside-userdata，零写入', async () => {
  const ud = mkTemp('hull-bk-ud-');
  seedFixture(ud);
  const before = treeHash(ud);
  const inside = join(ud, 'backup-out');

  await rejects(makeBackupService(ud).run({ targetDir: inside }), (e) =>
    isBackupError(e, 'backup-target-inside-userdata'),
  );

  ok(!existsSync(inside), '目标目录不应被创建');
  equal(treeHash(ud), before, '现数据 hash 不变');
});

test('④ 拷贝/落 manifest 前注入失败：backup-failed + 本次目录清理 + 现数据 hash 不变（验收③）', async () => {
  const prev = process.env.HULL_E2E;
  process.env.HULL_E2E = '1';
  try {
    const ud = mkTemp('hull-bk-ud-');
    const target = mkTemp('hull-bk-tgt-');
    seedFixture(ud);
    const before = treeHash(ud);

    await rejects(makeBackupService(ud, { failAt: 'backup-copy' }).run({ targetDir: target }), (e) =>
      isBackupError(e, 'backup-failed'),
    );
    deepEqual(readdirSync(target), [], '拷贝失败：本次目录被清理');

    await rejects(makeBackupService(ud, { failAt: 'backup-before-manifest' }).run({ targetDir: target }), (e) =>
      isBackupError(e, 'backup-failed'),
    );
    deepEqual(readdirSync(target), [], 'manifest 前失败：本次目录被清理');

    equal(treeHash(ud), before, '现数据 hash 不变');
  } finally {
    if (prev === undefined) delete process.env.HULL_E2E;
    else process.env.HULL_E2E = prev;
  }
});

test('⑤ 注入点仅 HULL_E2E=1 生效：非 e2e 环境 failAt 被忽略（备份成功）', async () => {
  const prev = process.env.HULL_E2E;
  delete process.env.HULL_E2E;
  try {
    const ud = mkTemp('hull-bk-ud-');
    const target = mkTemp('hull-bk-tgt-');
    seedFixture(ud);
    const r = await makeBackupService(ud, { failAt: 'backup-copy' }).run({ targetDir: target });
    ok(existsSync(join(r.backupDir, MANIFEST_FILENAME)), '生产路径不受注入影响');
  } finally {
    if (prev !== undefined) process.env.HULL_E2E = prev;
  }
});
