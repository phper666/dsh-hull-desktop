/**
 * N1 回收站（设计 §4.4，契约 §接口详情 6-9 / §回收站物理布局 / CON-R-notes-007）
 * manifest <userData>/notes/trash.json（原子写 temp+rename + 损坏 corrupt-<ts> 备份重建，
 * 模式对齐 KanbanStore）+ 实体 <userData>/notes/.trash/tr_<uuid>.md（固定 userData、独立于 notes.dir）。
 * restore 冲突不覆盖；TTL 30d（恰好 30 天算过期）+ 500MB 容量循环删最旧；
 * 实体 unlink 失败跳过记日志（下次清理重试）；孤儿实体保留不展示（契约 TBD v1 口径）。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

import { HullError } from '../shared/errors';
import { NOOP_LOGGER, type RuntimeLogger } from '../shared/types';

import { isValidTrashId, resolveSafeNotePath } from './pathGuard';
import { NOTES_ERRORS, type TrashEntry } from './types';

/** TTL：deletedAt 起算 ≥30 天过期（契约 T3-05：恰好 30 天算过期） */
const TTL_MS = 30 * 24 * 60 * 60 * 1000;
/** 容量上限 500MB（总容量 >500MB 循环删最旧至 <500MB） */
const CAPACITY_BYTES = 500 * 1024 * 1024;

interface TrashManifest {
  entries: TrashEntry[];
}

export class NotesTrash {
  private readonly logger: RuntimeLogger;
  private readonly trashDir: string;
  private readonly manifestPath: string;
  private entries: TrashEntry[];
  /** 删除/恢复落 notes.dir 的路径回调（回声抑制登记；Service 注入） */
  onNotesWrite?: (absPath: string) => void;

  constructor(options: { userDataPath: string; logger?: RuntimeLogger }) {
    this.logger = options.logger ?? NOOP_LOGGER;
    const notesRoot = join(options.userDataPath, 'notes');
    this.trashDir = join(notesRoot, '.trash');
    this.manifestPath = join(notesRoot, 'trash.json');
    this.entries = this.load();
    if (!existsSync(this.trashDir)) mkdirSync(this.trashDir, { recursive: true });
  }

  /** notes:delete：文件 rename 入 .trash/tr_<uuid>.md + manifest 追加条目（原子写）。
   *  仅接受文件：目录误删会整树入 .trash 且 purge/cleanup unlinkSync EISDIR 永久滞留（oracle 🟠2） */
  deleteFromNotes(notesRoot: string, relPath: string): { trashId: string } {
    const abs = join(notesRoot, relPath);
    let sizeBytes: number;
    try {
      const st = statSync(abs);
      if (!st.isFile()) throw new HullError(NOTES_ERRORS.notFound, `不是文件，不可删除入回收站: ${relPath}`);
      sizeBytes = st.size;
    } catch (err) {
      if (err instanceof HullError) throw err;
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new HullError(NOTES_ERRORS.notFound, `笔记不存在: ${relPath}`);
      }
      throw new HullError(NOTES_ERRORS.ioError, `删除失败: ${(err as Error).message}`);
    }
    const id = `tr_${randomUUID()}`;
    const entity = join(this.trashDir, `${id}.md`);
    renameSync(abs, entity);
    this.entries.push({ id, originalPath: relPath, deletedAt: new Date().toISOString(), sizeBytes });
    this.flush();
    this.onNotesWrite?.(abs);
    return { trashId: id };
  }

  /** notes:trashList：manifest 快照 + totalSizeBytes（条目体积合计；sizeBytes 以删除时实测为准） */
  list(): { entries: TrashEntry[]; totalSizeBytes: number } {
    return {
      entries: this.entries.map((e) => ({ ...e })),
      totalSizeBytes: this.entries.reduce((sum, e) => sum + e.sizeBytes, 0),
    };
  }

  /**
   * notes:restore（契约 §接口详情 8）：rename 回 当前 notes.dir/<originalPath>（换目录后恢复落到新目录）；
   * 父目录不存在自动创建；目标被占用 → notes-restore-conflict（携 targetPath）不覆盖，条目保留。
   */
  restore(trashId: unknown, notesRoot: string): { restoredPath: string } {
    const entry = this.findEntry(trashId);
    // manifest 可被外部篡改：originalPath 回归路径守卫（拒 ../、隐藏段、越出 notes.dir，oracle 🟡8）
    const restoredRel = (() => {
      try {
        resolveSafeNotePath(notesRoot, entry.originalPath);
        return entry.originalPath;
      } catch {
        throw new HullError(NOTES_ERRORS.restoreConflict, `回收站条目原路径非法，不可恢复: ${entry.originalPath}`);
      }
    })();
    const targetAbs = join(notesRoot, restoredRel);
    if (existsSync(targetAbs)) {
      const err = new HullError(
        NOTES_ERRORS.restoreConflict,
        `恢复目标已被占用，不覆盖: ${restoredRel}`
      ) as HullError & { targetPath?: string };
      err.targetPath = restoredRel;
      throw err;
    }
    const entity = join(this.trashDir, `${entry.id}.md`);
    try {
      mkdirSync(join(targetAbs, '..'), { recursive: true });
      renameSync(entity, targetAbs);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new HullError(NOTES_ERRORS.ioError, `回收站实体丢失: ${entry.id}`);
      }
      throw new HullError(NOTES_ERRORS.ioError, `恢复失败: ${(err as Error).message}`);
    }
    this.removeEntry(entry.id);
    this.flush();
    this.onNotesWrite?.(targetAbs);
    return { restoredPath: restoredRel };
  }

  /** notes:purge：实体删除 + manifest 移除；实体已丢失仍移除 manifest（幂等收敛） */
  purge(trashId: unknown): Record<string, never> {
    const entry = this.findEntry(trashId);
    try {
      unlinkSync(join(this.trashDir, `${entry.id}.md`));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        this.logger.warn(`[notes] purge 实体删除失败（条目仍移除）: ${entry.id} ${(err as Error).message}`);
      }
    }
    this.removeEntry(entry.id);
    this.flush();
    return {};
  }

  /**
   * TTL/容量清理（契约 §核心流程：启动 + 每 24h + trashList 惰性触发）：
   * 先删 age ≥30 天，再循环删 deletedAt 最旧至总容量 <500MB；实体 unlink 失败跳过（下次重试）。
   */
  cleanup(): void {
    const now = Date.now();
    // TTL
    for (const e of [...this.entries]) {
      const age = now - Date.parse(e.deletedAt);
      if (!Number.isNaN(age) && age >= TTL_MS) this.purgeQuietly(e.id);
    }
    // 容量：按 deletedAt 最旧循环删至 <500MB
    let total = this.list().totalSizeBytes;
    while (total > CAPACITY_BYTES && this.entries.length > 0) {
      const oldest = [...this.entries].sort((a, b) => a.deletedAt.localeCompare(b.deletedAt))[0];
      const sizeBefore = this.entries.length;
      this.purgeQuietly(oldest.id);
      if (this.entries.length === sizeBefore) break; // unlink 失败被跳过 → 防死循环
      total = this.list().totalSizeBytes;
    }
  }

  /** 清理用静默 purge（跳过实体丢失/占用，仅收敛 manifest；失败条目保留重试） */
  private purgeQuietly(id: string): void {
    const entry = this.entries.find((e) => e.id === id);
    if (!entry) return;
    try {
      unlinkSync(join(this.trashDir, `${id}.md`));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        this.logger.warn(`[notes] TTL/容量清理跳过（实体删除失败）: ${id} ${(err as Error).message}`);
        return; // 条目保留，下次清理重试
      }
    }
    this.removeEntry(id);
    this.flush();
  }

  private findEntry(trashId: unknown): TrashEntry {
    if (!isValidTrashId(trashId)) throw new HullError(NOTES_ERRORS.notFound, `trashId 非法: ${String(trashId)}`);
    const entry = this.entries.find((e) => e.id === trashId);
    if (!entry) throw new HullError(NOTES_ERRORS.notFound, `回收站条目不存在: ${trashId}`);
    return entry;
  }

  private removeEntry(id: string): void {
    this.entries = this.entries.filter((e) => e.id !== id);
  }

  /** manifest 加载：损坏 → 备份 trash.json.corrupt-<ts> + 重建空清单（对齐 KanbanStore backupAndRebuild） */
  private load(): TrashEntry[] {
    if (!existsSync(this.manifestPath)) return [];
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(this.manifestPath, 'utf8'));
    } catch (err) {
      this.logger.warn(`[notes] trash.json 解析失败: ${(err as Error).message}（备份并重建空清单）`);
      this.backupCorrupt();
      return [];
    }
    const obj = parsed as Partial<TrashManifest>;
    if (!Array.isArray(obj.entries)) {
      this.logger.warn('[notes] trash.json 缺 entries，视为损坏（备份并重建空清单）');
      this.backupCorrupt();
      return [];
    }
    // 防御性过滤：四字段齐且类型正确的条目才收（损坏条目不致命）
    return obj.entries.filter(
      (e): e is TrashEntry =>
        typeof e?.id === 'string' && typeof e?.originalPath === 'string' && typeof e?.deletedAt === 'string' && typeof e?.sizeBytes === 'number'
    );
  }

  private backupCorrupt(): void {
    try {
      renameSync(this.manifestPath, `${this.manifestPath}.corrupt-${Date.now()}`);
    } catch {
      /* 备份失败无害 */
    }
  }

  /** manifest 原子写（temp+rename） */
  private flush(): void {
    const manifest: TrashManifest = { entries: this.entries };
    try {
      writeFileSync(`${this.manifestPath}.tmp`, JSON.stringify(manifest), 'utf8');
      renameSync(`${this.manifestPath}.tmp`, this.manifestPath);
    } catch (err) {
      throw new HullError(NOTES_ERRORS.ioError, `trash.json 写入失败: ${(err as Error).message}`);
    }
  }
}
