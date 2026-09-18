/**
 * B2b 运行期恢复服务单测：inspect 拒绝路径必须「整包拒绝且不写 pending.json」
 * （高版本 / 守卫断言 / 迁移预演失败），以及 request 写标记 / cancel 幂等。
 */
import { test, after } from 'node:test';
import { equal, ok, rejects } from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { NOOP_LOGGER } from '../shared/types';

import { BackupError } from './errors';
import type { GateDeps } from './gate';
import { buildManifest, MANIFEST_FILENAME, type Manifest, type ManifestItem } from './manifest';
import { readPending } from './result';
import { RestoreService } from './restoreService';
import { BACKUP_SCOPE, enumerateFiles, resolveItemPaths, type ScopeItemId } from './scope';

const tempDirs: string[] = [];
after(() => {
  for (const d of tempDirs) rmSync(d, { recursive: true, force: true });
});

function mkTemp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value));
}

function writeProfile(root: string, opts: { theme?: string } = {}): void {
  writeJson(join(root, 'settings.json'), { schemaVersion: 4, theme: opts.theme ?? 'dark', notesDir: join(root, 'notes') });
  writeJson(join(root, 'kanban', 'boards.json'), { version: 2, boards: [] });
  writeJson(join(root, 'workflows', 'workflows.json'), { version: 1, workflows: [] });
  writeJson(join(root, 'notes', 'trash.json'), { entries: [] });
  writeJson(join(root, 'skills', 'disabled.json'), { version: 1, entries: [] });
  writeJson(join(root, 'skills', 'trash.json'), { version: 1, entries: [] });
  writeJson(join(root, 'notifications', 'notifications.json'), { version: 1, notifications: [] });
  writeJson(join(root, 'dismiss.json'), {});
  mkdirSync(join(root, 'notes', '.trash'), { recursive: true });
  writeFileSync(join(root, 'notes', 'a.md'), '# a');
}

function manifestOfPackage(root: string): Manifest {
  const versions: Partial<Record<ScopeItemId, number | null>> = { settings: 4, kanban: 2, workflows: 1, notifs: 1 };
  const items: ManifestItem[] = [];
  for (const scope of BACKUP_SCOPE) {
    const resolved = resolveItemPaths(scope, { userDataPath: root, notesDir: join(root, 'notes') });
    if (!resolved) continue;
    const files = enumerateFiles(resolved.absSource, scope);
    if (files.length === 0) continue;
    let size = 0;
    for (const rel of files) {
      const abs = scope.kind === 'file' ? resolved.absSource : join(resolved.absSource, rel);
      size += statSync(abs).size;
    }
    items.push({
      id: scope.id,
      path: resolved.packRel,
      kind: scope.kind,
      version: versions[scope.id] ?? null,
      size,
      fileCount: files.length,
    });
  }
  return buildManifest({
    appVersion: '0.1.9',
    platform: process.platform,
    exportedAt: new Date('2026-09-18T00:00:00.000Z'),
    notesDirHint: join(root, 'notes'),
    items,
  });
}

function writeManifest(root: string, manifest: Manifest): void {
  writeFileSync(join(root, MANIFEST_FILENAME), JSON.stringify(manifest, null, 2));
}

const gateOpen: GateDeps = {
  hasRunningExecutions: () => false,
  isInstallOrUpgradeActive: () => false,
  isSkillsUpgradeActive: () => false,
  isHullUpdateActive: () => false,
  hasPendingRestore: () => false,
};

function makeService(userDataPath: string): RestoreService {
  return new RestoreService({ userDataPath, notesDir: () => join(userDataPath, 'notes'), gate: gateOpen, logger: NOOP_LOGGER });
}

const pendingPath = (ud: string): string => join(ud, '.restore', 'pending.json');

const rejectedWith = (code: string) => (err: unknown): boolean => {
  ok(err instanceof BackupError, `应为 BackupError，实际 ${String(err)}`);
  equal((err as BackupError).code, code);
  return true;
};

test('inspect 拒绝：manifestVersion=2 高版本 → restore-version-newer，不写 pending', async () => {
  const ud = mkTemp('hull-b2-ud-');
  const pkg = mkTemp('hull-b2-pkg-');
  writeProfile(pkg);
  const manifest = { ...manifestOfPackage(pkg), manifestVersion: 2 };
  writeManifest(pkg, manifest);

  await rejects(makeService(ud).inspect({ sourceDir: pkg, mode: 'replace' }), rejectedWith('restore-version-newer'));
  equal(existsSync(pendingPath(ud)), false, '拒绝路径不得写标记');
});

test('inspect 拒绝：包内混入守卫禁项（token-buckets.json）→ 整包拒绝，不写 pending', async () => {
  const ud = mkTemp('hull-b2-ud-');
  const pkg = mkTemp('hull-b2-pkg-');
  writeProfile(pkg);
  writeManifest(pkg, manifestOfPackage(pkg));
  writeJson(join(pkg, 'token-buckets.json'), {}); // §3.3-5 守卫断言：包被伪造为全量包

  await rejects(
    makeService(ud).inspect({ sourceDir: pkg, mode: 'replace' }),
    (err: unknown): boolean => {
      ok(err instanceof BackupError, `应为 BackupError，实际 ${String(err)}`);
      return true;
    },
  );
  equal(existsSync(pendingPath(ud)), false, '拒绝路径不得写标记');
});

test('inspect 拒绝：迁移预演失败（boards.version=3 高于当前）→ restore-migrate-preview-failed，不写 pending', async () => {
  const ud = mkTemp('hull-b2-ud-');
  const pkg = mkTemp('hull-b2-pkg-');
  writeProfile(pkg);
  writeJson(join(pkg, 'kanban', 'boards.json'), { version: 3, boards: [] }); // 高于 KANBAN_SCHEMA_VERSION=2
  const manifest = manifestOfPackage(pkg);
  // manifest 项版本置 null，绕过 checkCompatibility 的版本区间，直击迁移预演
  manifest.items = manifest.items.map((i) => (i.id === 'kanban' ? { ...i, version: null } : i));
  writeManifest(pkg, manifest);

  await rejects(
    makeService(ud).inspect({ sourceDir: pkg, mode: 'replace' }),
    rejectedWith('restore-migrate-preview-failed'),
  );
  equal(existsSync(pendingPath(ud)), false, '拒绝路径不得写标记');
});

test('inspect 通过不写标记；request 原子写 pending(step=requested, phase=forward)；cancel 幂等', async () => {
  const ud = mkTemp('hull-b2-ud-');
  const pkg = mkTemp('hull-b2-pkg-');
  writeProfile(pkg);
  writeManifest(pkg, manifestOfPackage(pkg));
  const service = makeService(ud);

  const preview = await service.inspect({ sourceDir: pkg, mode: 'replace' });
  equal(preview.mode, 'replace');
  equal(preview.items.length, 7);
  equal(preview.mergePlan, null);
  ok(preview.warnings.length > 0);
  equal(existsSync(pendingPath(ud)), false, 'inspect 只读，不写标记');

  const { pending } = await service.request({ sourceDir: pkg, mode: 'replace' });
  equal(pending.step, 'requested');
  equal(pending.phase, 'forward');
  equal(pending.mode, 'replace');
  equal(pending.sourceDir, pkg);
  equal(pending.items.length, 7);
  const onDisk = readPending(ud);
  ok(onDisk, 'pending.json 应落盘');
  equal(onDisk!.step, 'requested');

  equal(service.cancel(), true);
  equal(readPending(ud), null);
  equal(service.cancel(), false, '无标记时 cancel 幂等返回 false');
});
