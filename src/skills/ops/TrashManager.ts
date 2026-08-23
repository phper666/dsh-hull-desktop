/**
 * 回收站管理器（CON-R-skills-003 + Q-035，设计 D2）
 * 移除前整目录 move 入 <userData>/skills/trash/tr_<uuid>/（EXDEV 跨卷降级）；
 * trash.json 索引（原路径+删除时间+体积+平台快照）；TTL 30 天 + 500MB 上限最旧先删（惰性触发）；
 * 恢复冲突不覆盖。uuid 目录名规避同 skill 多路径撞名。
 */
import { randomUUID } from 'node:crypto';

import { NOOP_LOGGER, type RuntimeLogger } from '../../shared/types';

import type { SkillFsOps } from '../SkillFsOps';
import { RestoreConflictError, SkillsNotFoundError } from '../errors';
import type { TrashEntry } from '../types';
import type { OperationLog } from './OperationLog';

export const TRASH_TTL_MS = 30 * 24 * 3600 * 1000; // 30 天
export const TRASH_CAP_BYTES = 500 * 1024 * 1024; // 500MB

interface TrashIndex {
  version: number;
  entries: TrashEntry[];
}

export interface TrashManagerOptions {
  sizeOf?: (path: string) => Promise<number>;
  now?: () => Date;
}

export class TrashManager {
  private readonly trashDir: string;
  private readonly indexFile: string;
  private readonly logger: RuntimeLogger;
  private readonly sizeOf: (path: string) => Promise<number>;
  private readonly now: () => Date;

  constructor(
    private readonly ops: SkillFsOps,
    baseDir: string,
    private readonly log: OperationLog,
    logger?: RuntimeLogger,
    opts?: TrashManagerOptions
  ) {
    this.trashDir = ops.join(baseDir, 'trash');
    this.indexFile = ops.join(baseDir, 'trash.json');
    this.logger = logger ?? NOOP_LOGGER;
    this.sizeOf = opts?.sizeOf ?? ((p) => this.computeSize(p));
    this.now = opts?.now ?? (() => new Date());
  }

  private async computeSize(path: string): Promise<number> {
    let total = 0;
    let names: string[];
    try {
      names = await this.ops.readdir(path);
    } catch {
      return 0;
    }
    for (const n of names) {
      const full = this.ops.join(path, n);
      const ls = await this.ops.lstat(full).catch(() => null);
      if (!ls || ls.isSymbolicLink()) continue; // symlink 跳过（循环防护，🟡3）
      const st = await this.ops.stat(full).catch(() => null);
      if (!st) continue;
      total += st.isDirectory() ? await this.computeSize(full) : st.size;
    }
    return total;
  }

  private loadIndex(): TrashIndex {
    try {
      if (!this.ops.existsSync(this.indexFile)) return { version: 1, entries: [] };
      const parsed = JSON.parse(this.ops.readFileSync(this.indexFile)) as TrashIndex;
      if (parsed && Array.isArray(parsed.entries)) return { version: 1, entries: parsed.entries };
    } catch {
      this.logger.warn('[skills] trash.json 损坏，按空索引重建');
    }
    return { version: 1, entries: [] };
  }

  private saveIndex(idx: TrashIndex): void {
    this.ops.writeFileSyncAtomic(this.indexFile, JSON.stringify(idx));
  }

  /** 整目录移入回收站（move → EXDEV 降级由 ops.moveSync 承担）；原路径消失=未删语义保持 */
  async moveToTrash(skillName: string, physPath: string, affectedPlatforms: string[]): Promise<TrashEntry> {
    const id = `tr_${randomUUID()}`;
    const sizeBytes = await this.sizeOf(physPath);
    this.ops.mkdirSync(this.trashDir);
    const dest = this.ops.join(this.trashDir, id);
    await this.ops.moveSync(physPath, dest); // copy 中途失败抛错 → 源保留（未删）
    const entry: TrashEntry = {
      id,
      skillName,
      originalPath: physPath,
      deletedAt: this.now().toISOString(),
      sizeBytes,
      affectedPlatforms: [...affectedPlatforms],
    };
    const idx = this.loadIndex();
    idx.entries.push(entry);
    this.saveIndex(idx);
    return entry;
  }

  /** 索引查询（无副作用；门面 restore 前置守卫用——trash.json parser 不可信） */
  findEntry(trashId: string): TrashEntry | undefined {
    return this.loadIndex().entries.find((e) => e.id === trashId);
  }

  /** 恢复到原路径；目标占用 → restore-conflict 不覆盖；条目不存在 → skills-not-found */
  async restore(trashId: string): Promise<string> {
    const idx = this.loadIndex();
    const entry = idx.entries.find((e) => e.id === trashId);
    if (!entry) throw new SkillsNotFoundError('回收站条目不存在（可能已被清理），请刷新');
    if (this.ops.existsSync(entry.originalPath)) {
      throw new RestoreConflictError('原路径已被占用，请先移走冲突项或手动处理', entry.originalPath);
    }
    const src = this.ops.join(this.trashDir, entry.id);
    await this.ops.moveSync(src, entry.originalPath);
    idx.entries = idx.entries.filter((e) => e.id !== trashId);
    this.saveIndex(idx);
    return entry.originalPath;
  }

  /** 列表 + 惰性清理（TTL 过期 → 真删；总量超限 → 最旧先删至 ≤500MB）；purge 入日志 */
  async list(): Promise<{ entries: TrashEntry[]; totalSizeBytes: number }> {
    const idx = this.loadIndex();
    const now = this.now().getTime();
    const kept: TrashEntry[] = [];
    for (const e of idx.entries) {
      const dir = this.ops.join(this.trashDir, e.id);
      if (now - new Date(e.deletedAt).getTime() > TRASH_TTL_MS || !this.ops.existsSync(dir)) {
        this.ops.rmRecursiveSync(dir);
        this.log.append({ ts: this.now().toISOString(), action: 'purge', paths: [e.originalPath], result: 'success', detail: { reason: 'ttl-or-missing', trashId: e.id } });
        continue;
      }
      kept.push(e);
    }
    let total = kept.reduce((s, e) => s + e.sizeBytes, 0);
    if (total > TRASH_CAP_BYTES) {
      kept.sort((a, b) => a.deletedAt.localeCompare(b.deletedAt)); // 最旧先
      while (kept.length > 0 && total > TRASH_CAP_BYTES) {
        const victim = kept.shift()!;
        this.ops.rmRecursiveSync(this.ops.join(this.trashDir, victim.id));
        total -= victim.sizeBytes;
        this.log.append({ ts: this.now().toISOString(), action: 'purge', paths: [victim.originalPath], result: 'success', detail: { reason: 'capacity', trashId: victim.id } });
      }
    }
    if (kept.length !== idx.entries.length) {
      idx.entries = kept;
      this.saveIndex(idx);
    }
    return { entries: kept, totalSizeBytes: total };
  }
}
