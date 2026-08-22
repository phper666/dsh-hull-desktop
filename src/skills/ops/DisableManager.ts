/**
 * 禁用/启用管理器（CON-R-skills-008 + Q-031/Q-032，设计 D4）
 * 按物理路径粒度移目录真禁用：symlink 来源 → unlink 指针（SSOT 保留，记 symlinkTarget）；
 * 实目录来源 → rename 入 <userData>/skills/disabled/d_<uuid>/；disabled.json 记映射；
 * 启用 = 据映射恢复（原路径占用 → restore-conflict 不覆盖）。SKILL.md 内容零触碰。
 */
import { randomUUID } from 'node:crypto';

import { NOOP_LOGGER, type RuntimeLogger } from '../../shared/types';

import type { SkillFsOps } from '../SkillFsOps';
import { RestoreConflictError, SkillValidationError } from '../errors';
import type { DisabledEntry } from '../types';
import type { OperationLog } from './OperationLog';

interface DisabledIndex {
  version: number;
  entries: DisabledEntry[];
}

/** 防御性读取 disabled.json（损坏 → 空索引重建告警）；scanner enabled 推导与 UI 合并共用 */
export function loadDisabledEntries(ops: SkillFsOps, indexFile: string): DisabledEntry[] {
  try {
    if (!ops.existsSync(indexFile)) return [];
    const parsed = JSON.parse(ops.readFileSync(indexFile)) as DisabledIndex;
    if (parsed && Array.isArray(parsed.entries)) return parsed.entries;
  } catch {
    /* 损坏按空重建 */
  }
  return [];
}

export class DisableManager {
  private readonly disabledDir: string;
  private readonly indexFile: string;
  private readonly logger: RuntimeLogger;

  constructor(
    private readonly ops: SkillFsOps,
    baseDir: string,
    private readonly log: OperationLog,
    logger?: RuntimeLogger
  ) {
    this.disabledDir = ops.join(baseDir, 'disabled');
    this.indexFile = ops.join(baseDir, 'disabled.json');
    this.logger = logger ?? NOOP_LOGGER;
  }

  private loadIndex(): DisabledIndex {
    return { version: 1, entries: loadDisabledEntries(this.ops, this.indexFile) };
  }

  private saveIndex(idx: DisabledIndex): void {
    this.ops.writeFileSyncAtomic(this.indexFile, JSON.stringify(idx));
  }

  /** 禁用一个物理路径（调用方已完成守卫链）；返回映射条目 */
  async disable(skillName: string, physPath: string, affectedPlatforms: string[]): Promise<DisabledEntry> {
    const idx = this.loadIndex();
    if (idx.entries.some((e) => e.originalPath === physPath)) {
      throw new SkillValidationError('该路径已处于禁用状态，请刷新', 'path');
    }
    const lstat = await this.ops.lstat(physPath);
    const id = `d_${randomUUID()}`;
    let entry: DisabledEntry;
    if (lstat.isSymbolicLink()) {
      // symlink 来源：仅移指针，源保留在原始仓库/SSOT（Q-032）
      const target = this.ops.readlinkSync(physPath);
      this.ops.unlinkSync(physPath);
      entry = { id, skillName, originalPath: physPath, kind: 'symlink', symlinkTarget: target, affectedPlatforms: [...affectedPlatforms], disabledAt: new Date().toISOString() };
    } else {
      // 实目录来源：整体 rename 入 disabled（内容零触碰）
      this.ops.mkdirSync(this.disabledDir);
      this.ops.renameSync(physPath, this.ops.join(this.disabledDir, id));
      entry = { id, skillName, originalPath: physPath, kind: 'dir', affectedPlatforms: [...affectedPlatforms], disabledAt: new Date().toISOString() };
    }
    idx.entries.push(entry);
    this.saveIndex(idx);
    void this.logger;
    return entry;
  }

  /** 启用：据映射恢复原位 / 重建 symlink；冲突不覆盖；成功清映射 */
  async enable(physPath: string): Promise<void> {
    const idx = this.loadIndex();
    const entry = idx.entries.find((e) => e.originalPath === physPath);
    if (!entry) throw new SkillValidationError('该路径不在禁用列表（状态已变化），请刷新', 'path');
    if (this.ops.existsSync(physPath)) {
      throw new RestoreConflictError('原路径已被占用，请先移走冲突项或手动处理', physPath);
    }
    if (entry.kind === 'symlink') {
      this.ops.symlinkSync(entry.symlinkTarget!, physPath);
    } else {
      this.ops.renameSync(this.ops.join(this.disabledDir, entry.id), physPath);
    }
    idx.entries = idx.entries.filter((e) => e.originalPath !== physPath);
    this.saveIndex(idx);
  }

  list(): DisabledEntry[] {
    return this.loadIndex().entries;
  }
}
