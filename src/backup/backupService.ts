/**
 * B1 运行期备份编排（设计 §2.1）：
 *   门控 → 目标守卫 → 可写预检 → flushAll → 新建 Hull备份-YYYYMMDD-HHmmss/（重名 -2/-3）
 *   → 白名单逐项拷贝（单文件失败重试 1 次，仍失败整体失败）→ manifest.json 最后原子写（完成标记）
 *   → 失败 best-effort 清理（删不掉 rename *.failed-<ts>）。
 * 不写 userData 任何白名单项（副作用仅用户选定目标目录）。
 */
import {
  accessSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { constants as fsConstants } from 'node:fs';
import { dirname, join } from 'node:path';

import { createNodeFsOps } from '../skills/SkillFsOps';
import type { RuntimeLogger } from '../shared/types';

import { BackupError, type BackupErrorCode } from './errors';
import { canBackup, type GateDeps } from './gate';
import { buildManifest, MANIFEST_FILENAME, type Manifest, type ManifestItem } from './manifest';
import { BACKUP_SCOPE, enumerateFiles, isInsideUserData, resolveItemPaths, type ScopeCtx, type ScopeItem } from './scope';

export interface BackupServiceDeps {
  userDataPath: string;
  /** NotesService.getNotesDir() */
  notesDir(): string;
  /** kanbanStore.flushSync()（其余 store 同步原子写无需 flush） */
  flushAll(): void;
  gate: GateDeps;
  logger: RuntimeLogger;
  appVersion: string;
  now?: () => Date;
  /** HULL_E2E_FAIL_AT（仅 HULL_E2E=1 生效）：'backup-copy' | 'backup-before-manifest' */
  failAt?: string;
}

export interface BackupResult {
  backupDir: string;
  manifest: Manifest;
}

/** 保留最近 keep 个带 manifest 的包；顺带清掉无 manifest / *.failed- 的孤儿目录 */
const BACKUP_DIR_PREFIX = 'Hull备份-';

export class BackupService {
  private readonly ops = createNodeFsOps();
  private busy = false;

  constructor(private readonly deps: BackupServiceDeps) {}

  async run(input: { targetDir: string }): Promise<BackupResult> {
    if (this.busy) throw new BackupError('backup-busy', '已有备份任务进行中');
    const gate = canBackup(this.deps.gate);
    if (!gate.ok) throw new BackupError(gate.code ?? 'backup-busy', gate.message ?? '当前不能备份');

    const targetDir = input.targetDir;
    if (isInsideUserData(targetDir, this.deps.userDataPath)) {
      throw new BackupError('backup-target-inside-userdata', `备份目标不能位于数据目录内：${targetDir}`);
    }
    assertWritable(targetDir);

    this.busy = true;
    let backupDir: string | null = null;
    try {
      this.deps.flushAll(); // 一致性（CON-R-backup-005）：kanban 防抖落盘
      const now = this.deps.now?.() ?? new Date();
      backupDir = createUniqueDir(targetDir, now);
      const ctx: ScopeCtx = { userDataPath: this.deps.userDataPath, notesDir: this.deps.notesDir() };
      this.deps.logger.info(`[backup] start target=${targetDir} dir=${backupDir}`);

      const items = await this.copyAll(backupDir, ctx);
      if (items.length === 0) throw new BackupError('backup-failed', '没有可备份的数据（白名单 7 项均不存在）');
      if (this.failPoint() === 'backup-before-manifest') throw new Error('injected failure: backup-before-manifest');

      const manifest = buildManifest({
        appVersion: this.deps.appVersion,
        platform: process.platform,
        exportedAt: now,
        notesDirHint: ctx.notesDir,
        items,
      });
      // manifest 最后原子写 = 完成标记（CON-R-backup-003/012）；它存在即代表本次备份完整
      this.ops.writeFileSyncAtomic(join(backupDir, MANIFEST_FILENAME), JSON.stringify(manifest, null, 2));
      this.deps.logger.info(`[backup] finish dir=${backupDir} items=${items.length} bytes=${manifest.counts.bytes}`);
      return { backupDir, manifest };
    } catch (err) {
      const base = err instanceof Error ? err.message : String(err);
      const code: BackupErrorCode = err instanceof BackupError ? err.code : 'backup-failed';
      const failedPath = backupDir ? await this.cleanupFailedDir(backupDir) : null;
      const message = failedPath ? `${base}（残留目录已改名为 ${failedPath}）` : base;
      this.deps.logger.error(`[backup] fail dir=${backupDir ?? '-'}: ${base}`);
      throw new BackupError(code, message);
    } finally {
      this.busy = false;
    }
  }

  /** 数据卡「清理旧备份」：删除孤儿（无 manifest / *.failed-）并只保留最近 keep 个有效包；返回删除目录数 */
  cleanupOrphans(parentDir: string, keep: number): number {
    if (!existsSync(parentDir)) return 0;
    let entries;
    try {
      entries = readdirSync(parentDir, { withFileTypes: true });
    } catch (err) {
      this.deps.logger.warn(`[backup] cleanup 读取失败 ${parentDir}: ${(err as Error).message}`);
      return 0;
    }
    const valid: string[] = [];
    const doomed: string[] = [];
    for (const e of entries) {
      if (!e.isDirectory() || !e.name.startsWith(BACKUP_DIR_PREFIX)) continue;
      const dir = join(parentDir, e.name);
      if (e.name.includes('.failed-') || !existsSync(join(dir, MANIFEST_FILENAME))) doomed.push(dir);
      else valid.push(dir);
    }
    valid.sort((a, b) => (a < b ? 1 : -1)); // 名字含时间戳，降序 = 新→旧
    doomed.push(...valid.slice(Math.max(0, keep)));

    let removed = 0;
    for (const dir of doomed) {
      try {
        rmSync(dir, { recursive: true, force: true });
        removed++;
      } catch (err) {
        this.deps.logger.warn(`[backup] cleanup 删除失败 ${dir}: ${(err as Error).message}`);
      }
    }
    if (removed > 0) this.deps.logger.info(`[backup] cleanup 删除 ${removed} 个备份目录（keep=${keep}）`);
    return removed;
  }

  private async copyAll(backupDir: string, ctx: ScopeCtx): Promise<ManifestItem[]> {
    const out: ManifestItem[] = [];
    const failPoint = this.failPoint();
    for (const item of BACKUP_SCOPE) {
      const paths = resolveItemPaths(item, ctx);
      if (!paths) {
        this.deps.logger.info(`[backup] skip ${item.id}（源在 userData 外，不打包）`);
        continue;
      }
      const files = enumerateFiles(paths.absSource, item);
      if (files.length === 0) {
        if (item.optional) {
          this.deps.logger.info(`[backup] skip ${item.id}（无文件）`);
          continue;
        }
        throw new BackupError('backup-failed', `白名单项缺失：${item.id}`);
      }

      let size = 0;
      for (const rel of files) {
        const src = item.kind === 'file' ? paths.absSource : join(paths.absSource, rel);
        const dst = item.kind === 'file' ? join(backupDir, paths.packRel) : join(backupDir, paths.packRel, rel);
        if (failPoint === 'backup-copy') throw new Error(`injected failure: backup-copy (${rel})`);
        await copyWithRetry(src, dst);
        size += statSync(src).size;
      }
      out.push({
        id: item.id,
        path: paths.packRel,
        kind: item.kind,
        version: readItemVersion(item, paths.absSource, files),
        size,
        fileCount: files.length,
      });
    }
    return out;
  }

  private failPoint(): string | undefined {
    return process.env.HULL_E2E === '1' ? this.deps.failAt : undefined;
  }

  /** best-effort 清理：rm -rf；删不掉 → rename `*.failed-<ts>`，返回改名后的路径 */
  private async cleanupFailedDir(backupDir: string): Promise<string | null> {
    try {
      rmSync(backupDir, { recursive: true, force: true });
      return null;
    } catch {
      /* 继续 rename 兜底 */
    }
    const failedPath = `${backupDir}.failed-${Date.now()}`;
    try {
      await this.ops.moveSync(backupDir, failedPath);
      return failedPath;
    } catch {
      return null;
    }
  }
}

/** 读项主文件的版本号（file 项 = 该文件；parts 项 = 第一个 part；tree 项 = 首个文件） */
function readItemVersion(item: ScopeItem, absSource: string, files: string[]): number | null {
  if (!item.versionOf) return null;
  const primaryRel =
    item.parts && item.parts.length > 0
      ? item.parts[0].rel
      : item.kind === 'file'
        ? item.rel
        : files[0];
  const file = item.kind === 'file' ? absSource : join(absSource, primaryRel);
  try {
    return item.versionOf(JSON.parse(readFileSync(file, 'utf8')));
  } catch {
    return null; // 损坏源文件不阻断备份（恢复期由校验器整包拒绝）
  }
}

/** 目标目录可写预检：access(W_OK) + 探测文件写删（空间不足不做预检，由写错误兜底） */
function assertWritable(targetDir: string): void {
  let probe: string | null = null;
  const deny = (reason: string): never => {
    if (probe) {
      try {
        rmSync(probe, { force: true });
      } catch {
        /* 探测文件清理失败无害 */
      }
    }
    throw new BackupError('backup-target-unwritable', `备份目标不可写：${targetDir}（${reason}）`);
  };
  try {
    if (!existsSync(targetDir) || !statSync(targetDir).isDirectory()) deny('目录不存在');
    accessSync(targetDir, fsConstants.W_OK);
    probe = join(targetDir, `.hull-write-probe-${process.pid}-${Date.now()}`);
    writeFileSync(probe, '');
    rmSync(probe, { force: true });
    probe = null;
  } catch (err) {
    if (err instanceof BackupError) throw err;
    deny((err as Error).message);
  }
}

/** 新建 `Hull备份-YYYYMMDD-HHmmss/`；已存在 → -2/-3 后缀（mkdir 原子占据） */
function createUniqueDir(targetDir: string, now: Date): string {
  const base = `${BACKUP_DIR_PREFIX}${stamp(now)}`;
  for (let n = 0; n < 1000; n++) {
    const dir = join(targetDir, n === 0 ? base : `${base}-${n + 1}`);
    try {
      mkdirSync(dir);
      return dir;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    }
  }
  throw new BackupError('backup-failed', `无法创建备份目录（重名过多）：${targetDir}`);
}

function stamp(d: Date): string {
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/** 单文件拷贝失败重试 1 次（文件可能在拷贝窗口被 rename 走）；二次失败抛错 → 整体失败 */
async function copyWithRetry(src: string, dst: string): Promise<void> {
  const attempt = (): void => {
    mkdirSync(dirname(dst), { recursive: true });
    copyFileSync(src, dst);
  };
  try {
    attempt();
    return;
  } catch {
    await new Promise((r) => setTimeout(r, 50));
  }
  attempt();
}
