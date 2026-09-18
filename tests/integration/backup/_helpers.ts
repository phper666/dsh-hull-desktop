/**
 * B5 integration 公共助手（设计 §7.2）：真 FS 临时目录 + 7 项白名单种子 + 真服务装配 +
 * 手工包 manifest 生成 + 全树内容 hash。
 * 复用被测实现的 BACKUP_SCOPE/enumerateFiles/buildManifest（包布局与校验规则同源），不复制业务规则。
 */
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { BackupService, type BackupServiceDeps, type BackupResult } from '../../../src/backup/backupService';
import type { GateDeps } from '../../../src/backup/gate';
import { buildManifest, MANIFEST_FILENAME, type Manifest, type ManifestItem } from '../../../src/backup/manifest';
import { RestoreService, type RestoreServiceDeps } from '../../../src/backup/restoreService';
import { BACKUP_SCOPE, enumerateFiles, resolveItemPaths, type ScopeItemId } from '../../../src/backup/scope';
import { NOOP_LOGGER } from '../../../src/shared/types';

const tempDirs: string[] = [];

/** 建临时目录（after 钩子统一清理，见 cleanupTempDirs） */
export function mkTemp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

export function cleanupTempDirs(): void {
  for (const d of tempDirs) rmSync(d, { recursive: true, force: true });
}

export function writeJson(file: string, value: unknown): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(value, null, 2));
}

export function writeText(file: string, value: string): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, value);
}

export function readJson<T = unknown>(file: string): T {
  return JSON.parse(readFileSync(file, 'utf8')) as T;
}

/** 全树相对路径（'/' 分隔，含子目录文件；不跟符号链接；排序） */
export function listTree(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string, base: string): void => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const rel = base === '' ? e.name : `${base}/${e.name}`;
      if (e.isDirectory()) walk(join(dir, e.name), rel);
      else if (e.isFile()) out.push(rel);
    }
  };
  walk(root, '');
  return out.sort();
}

/** 全树内容 hash（路径 + 内容；缺省忽略 `.restore`——恢复过程自身会写标记/结果/预备份） */
export function treeHash(root: string, ignore: readonly string[] = ['.restore']): string {
  const h = createHash('sha256');
  for (const rel of listTree(root)) {
    if (ignore.some((ig) => rel === ig || rel.startsWith(`${ig}/`))) continue;
    h.update(rel);
    h.update('\0');
    h.update(readFileSync(join(root, rel)));
    h.update('\0');
  }
  return h.digest('hex');
}

export interface FixtureOpts {
  /** settings.json 覆盖（默认 { schemaVersion: 4, theme: 'light' }） */
  settings?: Record<string, unknown>;
  /** kanban/boards.json 覆盖（默认 { version: 2, boards: [] }） */
  boards?: unknown;
  /** workflows/workflows.json 覆盖（默认 { version: 1, workflows: [] }） */
  workflows?: unknown;
  /** 笔记文件（rel → 内容；默认 { 'a.md': '# a' }） */
  notes?: Record<string, string>;
  /** 额外文件（相对路径 → 内容），如 dsh/bin/dsh、token-buckets.json、Cache/x */
  extras?: Record<string, string>;
}

/** 种子 userData / 备份包（7 项白名单齐全；SKILL.md 无附件依赖） */
export function seedFixture(root: string, opts: FixtureOpts = {}): void {
  writeJson(join(root, 'settings.json'), { schemaVersion: 4, theme: 'light', ...(opts.settings ?? {}) });
  writeJson(join(root, 'kanban', 'boards.json'), opts.boards ?? { version: 2, boards: [] });
  writeJson(join(root, 'workflows', 'workflows.json'), opts.workflows ?? { version: 1, workflows: [] });
  for (const [rel, body] of Object.entries(opts.notes ?? { 'a.md': '# a' })) {
    writeText(join(root, 'notes', rel), body);
  }
  writeJson(join(root, 'notes', 'trash.json'), { entries: [] });
  writeJson(join(root, 'skills', 'disabled.json'), { version: 1, entries: [] });
  writeJson(join(root, 'skills', 'trash.json'), { version: 1, entries: [] });
  writeJson(join(root, 'notifications', 'notifications.json'), { version: 1, notifications: [] });
  writeJson(join(root, 'dismiss.json'), {});
  for (const [rel, body] of Object.entries(opts.extras ?? {})) {
    writeText(join(root, rel), body);
  }
}

/** 按 scope 规则从包目录生成 manifest（size/fileCount 与包实际一致，与 B1 同源） */
export function pkgManifest(
  root: string,
  versions: Partial<Record<ScopeItemId, number | null>> = {},
): Manifest {
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

/** 手工构造完整备份包：seedFixture + manifest.json（校验器/预演/执行器可直接消费） */
export function writePackage(
  root: string,
  opts: FixtureOpts = {},
  versions: Partial<Record<ScopeItemId, number | null>> = {},
): Manifest {
  seedFixture(root, opts);
  const manifest = pkgManifest(root, versions);
  writeJson(join(root, MANIFEST_FILENAME), manifest);
  return manifest;
}

export function makeGate(over: Partial<GateDeps> = {}): GateDeps {
  return {
    hasRunningExecutions: () => false,
    isInstallOrUpgradeActive: () => false,
    isSkillsUpgradeActive: () => false,
    isHullUpdateActive: () => false,
    hasPendingRestore: () => false,
    ...over,
  };
}

export function makeBackupService(userDataPath: string, over: Partial<BackupServiceDeps> = {}): BackupService {
  return new BackupService({
    userDataPath,
    notesDir: () => join(userDataPath, 'notes'),
    flushAll: () => {},
    gate: makeGate(),
    logger: NOOP_LOGGER,
    appVersion: '0.1.9',
    ...over,
  });
}

export function makeRestoreService(userDataPath: string, over: Partial<RestoreServiceDeps> = {}): RestoreService {
  return new RestoreService({
    userDataPath,
    notesDir: () => join(userDataPath, 'notes'),
    gate: makeGate(),
    logger: NOOP_LOGGER,
    ...over,
  });
}

/** 真备份一次（返回 backupDir + manifest） */
export function runBackup(userDataPath: string, targetDir: string): Promise<BackupResult> {
  return makeBackupService(userDataPath).run({ targetDir });
}
