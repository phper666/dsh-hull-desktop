/**
 * S2 操作门面（feishu-s2-skills-api-contract §行为契约，设计 D1/D5）
 * 7 通道编排入口。安全边界（不信任 renderer，主进程强制）：
 * ① 路径校验（白名单域+穿越拒绝）② 单飞互斥（per-path Map 锁）③ 写前 mtime 冲突检查
 * ④ undetectable 拒绝（UpgradeExecutor 内）。顺序：先锁后 mtime（D5）。
 * 成功变更后 await 重扫（快照/计数即时一致；幂等，哈希走缓存）。
 */
import { NOOP_LOGGER, type RuntimeLogger } from '../../shared/types';

import { REGISTRY } from '../registry';
import { createNodeFsOps, type SkillFsOps } from '../SkillFsOps';
import { isValidSkillName, isWithinRoots } from '../pathGuard';
import {
  SkillValidationError,
  SkillsConflictError,
  SkillsNotFoundError,
  SkillsOpInProgressError,
} from '../errors';
import type { DisabledEntry, OperationLogEntry, PathInfo, SkillEntry, TrashEntry } from '../types';
import type { SkillsScanner } from '../SkillsScanner';
import { defaultNpxUpdate, UpgradeExecutor, type UpgradeRunners } from './UpgradeExecutor';
import { TrashManager } from './TrashManager';
import { DisableManager } from './DisableManager';
import { OperationLog } from './OperationLog';

export interface RemoveResult {
  path: string;
  status: 'removed' | 'failed';
  trashId?: string;
  code?: string;
}

export interface SkillsOpsOptions {
  ops?: SkillFsOps;
  homeDir: string;
  userDataPath: string;
  scanner: SkillsScanner;
  logger?: RuntimeLogger;
  /** 升级 runner 注入（测试 fake 全量接管；未注入 → 生产缺省 npx-first，见 PRODUCTION_RUNNERS）；每次调用取最新 */
  runnersRef?: () => UpgradeRunners | undefined;
}

/** per-path 单飞锁（D5：Map 足够，不引锁库） */
class PathLocks {
  private readonly held = new Set<string>();
  acquire(path: string): void {
    if (this.held.has(path)) throw new SkillsOpInProgressError('操作进行中，请稍后');
    this.held.add(path);
  }
  release(path: string): void {
    this.held.delete(path);
  }
}

/**
 * 生产缺省 runners（O-2 接线）：npx-first，失败/无效果由 UpgradeExecutor 降级 git-staging。
 * 仅在未注入 runnersRef 时生效——测试经 runnersRef 全量接管，不触真实子进程。
 */
const PRODUCTION_RUNNERS: UpgradeRunners = { npxUpdate: defaultNpxUpdate };

export class SkillsOps {
  private readonly ops: SkillFsOps;
  private readonly logger: RuntimeLogger;
  private readonly scanner: SkillsScanner;
  private readonly registryDirs: string[];
  private readonly locks = new PathLocks();
  private readonly log: OperationLog;
  private readonly trash: TrashManager;
  private readonly disabledMgr: DisableManager;
  private readonly skillsBase: string;
  private readonly runnersRef?: () => UpgradeRunners | undefined;

  constructor(options: SkillsOpsOptions) {
    this.ops = options.ops ?? createNodeFsOps();
    this.logger = options.logger ?? NOOP_LOGGER;
    this.scanner = options.scanner;
    this.runnersRef = options.runnersRef;
    this.registryDirs = REGISTRY.map((r) => this.ops.join(options.homeDir, r.dir));
    this.skillsBase = this.ops.join(options.userDataPath, 'skills');
    this.log = new OperationLog(this.ops.join(this.skillsBase, 'log', 'operations.jsonl'));
    this.log.init(); // 启动截断（>10MB 留 1000 行，D6）
    this.trash = new TrashManager(this.ops, this.skillsBase, this.log, this.logger);
    this.disabledMgr = new DisableManager(this.ops, this.skillsBase, this.log, this.logger);
  }

  // ─────────────────────────── 守卫链 ───────────────────────────

  /**
   * 主进程强制路径校验（Q-038）：白名单域 + 目录名合法 + realpath basename 合法。
   * requireExist=false 用于启用（禁用态路径物理不存在，realpath 必失败）。
   */
  private async validateOpPath(p: unknown, requireExist = true): Promise<string> {
    if (typeof p !== 'string' || p.length === 0) throw new SkillValidationError('路径不能为空', 'path');
    if (!isWithinRoots(p, this.registryDirs)) throw new SkillValidationError('路径不在注册表白名单内', 'path');
    const norm = this.ops.normalize(p);
    if (!isValidSkillName(this.ops.basename(norm))) throw new SkillValidationError('非法 skill 路径', 'path');
    const real = await this.ops.realpath(p).catch(() => null);
    if (real === null) {
      if (requireExist) throw new SkillsNotFoundError('目标路径不存在，请刷新');
      return p;
    }
    if (!isValidSkillName(this.ops.basename(real))) throw new SkillValidationError('非法 skill 路径（realpath 校验失败）', 'path');
    return p;
  }

  private findEntry(path: string): { entry: SkillEntry; pathInfo: PathInfo } {
    for (const entry of this.scanner.snapshot().entries) {
      const pathInfo = entry.paths.find((pi) => pi.path === path);
      if (pathInfo) return { entry, pathInfo };
    }
    throw new SkillsNotFoundError('目标路径不存在（已被外部删除或已移除），请刷新');
  }

  /** 先锁后 mtime（D5）：锁内做冲突检查保证「检查→写」段内无壳内并发 */
  private async guard(path: string, pathInfo?: PathInfo): Promise<() => void> {
    this.locks.acquire(path);
    try {
      if (pathInfo) {
        if (!this.ops.existsSync(path)) throw new SkillsNotFoundError('目标路径不存在（已被外部删除），请刷新');
        const st = await this.ops.stat(path);
        if (st.mtimeMs !== pathInfo.mtimeMs) {
          throw new SkillsConflictError('已被外部修改，请刷新后重试');
        }
      }
      return () => this.locks.release(path);
    } catch (err) {
      this.locks.release(path);
      throw err;
    }
  }

  private async rescan(): Promise<void> {
    try {
      await this.scanner.scan();
    } catch {
      /* 重扫失败不影响操作结果回传 */
    }
  }

  private newExecutor(): UpgradeExecutor {
    return new UpgradeExecutor(
      { ops: this.ops, base: this.skillsBase, scanner: this.scanner, log: this.log, logger: this.logger },
      this.runnersRef ? this.runnersRef() : PRODUCTION_RUNNERS
    );
  }

  // ─────────────────────────── 7 通道 ───────────────────────────

  /** 移除（批量逐条串行，部分失败不回滚已成功项；契约 results[] 等长等序） */
  async remove(paths: unknown): Promise<RemoveResult[]> {
    if (!Array.isArray(paths) || paths.length === 0 || !paths.every((p) => typeof p === 'string')) {
      throw new SkillValidationError('paths 必须为非空字符串数组', 'paths');
    }
    const results: RemoveResult[] = [];
    for (const p of paths as string[]) {
      try {
        await this.validateOpPath(p);
        const { entry, pathInfo } = this.findEntry(p); // 不在快照 → not-found
        const release = await this.guard(p, pathInfo);
        let trashEntry;
        try {
          trashEntry = await this.trash.moveToTrash(entry.name, p, pathInfo.affectedPlatforms);
        } finally {
          release();
        }
        this.log.append({ ts: new Date().toISOString(), action: 'remove', paths: [p], result: 'success', detail: { trashId: trashEntry.id } });
        results.push({ path: p, status: 'removed', trashId: trashEntry.id });
      } catch (err) {
        results.push({
          path: p,
          status: 'failed',
          code: err instanceof Error && 'code' in err ? String((err as { code: unknown }).code) : 'skills-io-error',
        });
      }
    }
    await this.rescan();
    return results;
  }

  /** 一键升级（单 path；守卫+undetectable 主进程强制，契约 §upgrade 前置） */
  async upgrade(path: unknown): Promise<{ path: string; method: string; newHash: string }> {
    const p = await this.validateOpPath(path);
    const { entry, pathInfo } = this.findEntry(p);
    // 🟡4：symlink 来源拒绝升级——rename 会把别名换成独立副本（SSOT 留旧内容，下次扫描重复）。
    // symlink skill 经其 SSOT 原路径升级；此处明确拒绝而非静默换语义。
    if (pathInfo.isSymlink) {
      throw new SkillValidationError('symlink 来源的 skill 不支持原位升级，请在其原始仓库（SSOT）路径升级', 'path');
    }
    const release = await this.guard(p, pathInfo);
    try {
      const res = await this.newExecutor().upgrade(p);
      // 🟡7：回写远端哈希覆盖——否则 lock 未 bump + 进程内缓存 → 重扫永远 upgradable
      this.scanner.applyRemoteHashOverride(entry.name, res.newHash);
      return res;
    } finally {
      release();
      await this.rescan();
    }
  }

  /** 禁用/启用（按物理路径粒度；Q-031） */
  async setEnabled(path: unknown, enabled: unknown): Promise<{ path: string; enabled: boolean; entryId?: string }> {
    if (typeof enabled !== 'boolean') throw new SkillValidationError('enabled 必须为布尔值', 'enabled');
    // 启用分支：禁用态路径物理不存在——存在性校验跳过（映射+冲突检查在 DisableManager）
    const p = await this.validateOpPath(path, !enabled);
    if (enabled) {
      const release = await this.guard(p); // 无快照信息（禁用态路径不在扫描结果）
      try {
        await this.disabledMgr.enable(p);
      } finally {
        release();
      }
      this.log.append({ ts: new Date().toISOString(), action: 'enable', paths: [p], result: 'success' });
      await this.rescan();
      return { path: p, enabled: true };
    }
    const { entry, pathInfo } = this.findEntry(p);
    const release = await this.guard(p, pathInfo);
    let disabledEntry: DisabledEntry;
    try {
      disabledEntry = await this.disabledMgr.disable(entry.name, p, pathInfo.affectedPlatforms);
    } finally {
      release();
    }
    this.log.append({ ts: new Date().toISOString(), action: 'disable', paths: [p], result: 'success', detail: { entryId: disabledEntry.id } });
    await this.rescan();
    return { path: p, enabled: false, entryId: disabledEntry.id };
  }

  getDisabledList(): DisabledEntry[] {
    return this.disabledMgr.list();
  }

  async getTrashList(): Promise<{ entries: TrashEntry[]; totalSizeBytes: number }> {
    return this.trash.list(); // 顺带惰性清理（Q-035）
  }

  /**
   * 恢复到原路径（🔴1 评审修复）：先映射 trashId→originalPath，白名单校验（trash.json
   * parser 不可信）+ 单飞锁（与 upgrade/remove 的两段 rename 窗口互斥），再执行搬移。
   */
  async restoreFromTrash(trashId: unknown): Promise<{ restoredPath: string }> {
    if (typeof trashId !== 'string' || !trashId) throw new SkillValidationError('trashId 不能为空', 'trashId');
    const entry = this.trash.findEntry(trashId);
    if (!entry) throw new SkillsNotFoundError('回收站条目不存在（可能已被清理），请刷新');
    if (!isWithinRoots(entry.originalPath, this.registryDirs)) {
      throw new SkillValidationError('回收站条目原路径不在注册表白名单内', 'originalPath');
    }
    const release = await this.guard(entry.originalPath); // 无 mtime 可比（原路径当前为空）
    try {
      const restoredPath = await this.trash.restore(trashId);
      this.log.append({ ts: new Date().toISOString(), action: 'restore', paths: [restoredPath], result: 'success', detail: { trashId } });
      return { restoredPath };
    } finally {
      release();
      await this.rescan();
    }
  }

  getOperationLog(limit?: unknown): OperationLogEntry[] {
    const n = typeof limit === 'number' && limit > 0 ? Math.min(Math.floor(limit), 1000) : 200;
    return this.log.readTail(n);
  }

  /** 启动自愈：staging backup 残留 + 原路径空缺 → 自动还原（设计 §4.1 两段 rename 窗口崩溃兜底） */
  selfHeal(): void {
    this.newExecutor().selfHeal();
  }
}
