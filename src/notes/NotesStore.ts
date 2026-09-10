/**
 * N1 Store（设计 §4.1，契约 §接口详情 2-5）
 * 文件操作：get / save（原子写 temp+rename + mtime 乐观锁 + 三 strategy 冲突分流）/ create / move。
 * 事实源 = 磁盘 md 文件（CON-R-notes-002）；写盘模式对齐 src/kanban/KanbanStore.ts:296-303。
 * 路径校验不在此散落——IPC 层单点 pathGuard 后才进 Store（设计 §4.7）；
 * saveAsCopy 副本名在 IPC 层守卫后由本层派生（同源段校验）。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { HullError } from '../shared/errors';
import { NOOP_LOGGER, type RuntimeLogger } from '../shared/types';

import { applyFrontmatterPatch, parseNoteFrontmatter } from './frontmatter';
import { NOTES_ERRORS, type NoteDetail, type SaveInput } from './types';

export interface SaveOutput {
  path: string;
  mtime: string;
}

export class NotesStore {
  private readonly logger: RuntimeLogger;
  private root: string;
  /** 写盘成功回调（Service 用于回声抑制登记 + 索引增量更新） */
  onWrite?: (absPath: string) => void;

  constructor(options: { root: string; logger?: RuntimeLogger }) {
    this.root = options.root;
    this.logger = options.logger ?? NOOP_LOGGER;
    if (!existsSync(this.root)) mkdirSync(this.root, { recursive: true });
  }

  setRoot(root: string): void {
    this.root = root;
  }

  getRoot(): string {
    return this.root;
  }

  /** notes:get：全文 + frontmatter + mtime 基线 */
  get(relPath: string): NoteDetail {
    const abs = join(this.root, relPath);
    const content = requireFile(abs, relPath);
    const { fm } = parseNoteFrontmatter(content);
    return { path: relPath, content, frontmatter: fm, mtime: mtimeIso(abs) };
  }

  /**
   * notes:save（契约 §接口详情 3）：
   * 缺省 strategy → 先校验（mtime ≠ expected → conflict-modified 携 detected.diskMtime；不存在 → conflict-deleted），均不写盘；
   * overwrite → 跳过 mtime 校验（文件已删除仍拒，不静默重建）；
   * saveAsCopy → 写 `<基名> (冲突副本 YYYY-MM-DD).md`（同名追加序号，TBD 建议实现），响应 path = 副本路径。
   * content 与 frontmatterPatch 合成最终文本后单次原子写（设计 §4.1-4 等价形态）。
   */
  save(input: SaveInput): SaveOutput {
    const abs = join(this.root, input.path);
    if (input.strategy !== 'saveAsCopy') {
      // 校验（缺省与 overwrite 均要求目标存在）
      if (!existsSync(abs)) {
        throw new HullError(NOTES_ERRORS.conflictDeleted, `文件已被删除: ${input.path}`);
      }
      if (input.strategy === undefined) {
        const diskMtime = mtimeIso(abs);
        if (diskMtime !== input.expectedMtime) {
          const err = new HullError(
            NOTES_ERRORS.conflictModified,
            `文件已被外部改动: ${input.path}（disk=${diskMtime}）`
          ) as HullError & { detected?: { diskMtime: string } };
          err.detected = { diskMtime };
          throw err;
        }
      }
    }
    // saveAsCopy：不写原路径，派生副本名（同名已存在追加序号 2、3…）
    let targetAbs = abs;
    let targetRel = input.path;
    if (input.strategy === 'saveAsCopy') {
      const date = new Date().toISOString().slice(0, 10);
      const dir = dirname(input.path);
      const base = input.path.split('/').pop()!.replace(/\.md$/i, '');
      const stem = `${base} (冲突副本 ${date})`;
      let n = 1;
      for (;;) {
        const candidate = n === 1 ? `${stem}.md` : `${stem} ${n}.md`;
        const candAbs = join(this.root, dir, candidate);
        if (!existsSync(candAbs)) {
          targetAbs = candAbs;
          targetRel = dir === '.' ? candidate : `${dir}/${candidate}`;
          break;
        }
        n++;
      }
    }
    const finalContent =
      input.frontmatterPatch && Object.keys(input.frontmatterPatch).length > 0
        ? applyFrontmatterPatch(input.content, input.frontmatterPatch)
        : input.content;
    this.atomicWrite(targetAbs, finalContent);
    this.onWrite?.(targetAbs);
    return { path: targetRel, mtime: mtimeIso(targetAbs) };
  }

  /**
   * notes:create（契约 §接口详情 4）：`YYYY-MM-DD-<slug>.md`（slug 空 → 时间戳序号）；
   * title 提供时预写 frontmatter title；同目录同名 → notes-name-conflict。
   */
  create(dir: string | undefined, title: string | undefined): SaveOutput {
    const relDir = dir === undefined || dir === '' ? '.' : dir;
    const date = new Date().toISOString().slice(0, 10);
    const slug = slugify(title ?? '');
    const base = slug === '' ? String(Date.now()) : slug;
    const relPath = relDir === '.' ? `${date}-${base}.md` : `${relDir}/${date}-${base}.md`;
    const abs = join(this.root, relPath);
    if (existsSync(abs)) {
      throw nameConflict(relPath, `同名笔记已存在: ${relPath}`);
    }
    const content = title !== undefined && title !== '' ? applyFrontmatterPatch('', { title }) : '';
    this.atomicWrite(abs, content);
    this.onWrite?.(abs);
    return { path: relPath, mtime: mtimeIso(abs) };
  }

  /**
   * notes:move（契约 §接口详情 5）：磁盘 rename，索引跟随（Service 侧）。
   * targetDir 必须为已存在真实子目录（IPC 层守卫 + 此处 rename 隐式校验）；目标同名 → notes-name-conflict。
   */
  move(relPath: string, targetDirRel: string): SaveOutput {
    const abs = join(this.root, relPath);
    requireSourceFile(abs, relPath);
    const base = relPath.split('/').pop()!;
    const targetRel = targetDirRel === '.' ? base : `${targetDirRel}/${base}`;
    const targetAbs = join(this.root, targetRel);
    if (existsSync(targetAbs)) {
      throw nameConflict(targetRel, `目标同名已存在: ${targetRel}`);
    }
    try {
      mkdirSync(dirname(targetAbs), { recursive: true });
      renameSync(abs, targetAbs);
    } catch (err) {
      throw ioError(relPath, err);
    }
    this.onWrite?.(targetAbs);
    return { path: targetRel, mtime: mtimeIso(targetAbs) };
  }

  /** 原子写 temp+rename（对齐 KanbanStore flushNow） */
  private atomicWrite(abs: string, content: string): void {
    const tmp = `${abs}.tmp`;
    try {
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(tmp, content, 'utf8');
      renameSync(tmp, abs);
    } catch (err) {
      try {
        if (existsSync(tmp)) unlinkSync(tmp);
      } catch {
        /* 清理失败无害 */
      }
      this.logger.warn(`[notes] 原子写失败: ${abs} ${(err as Error).message}`);
      throw ioError(abs, err);
    }
  }
}

function mtimeIso(abs: string): string {
  // 统一用 mtime（Date，ms 精度）——mtimeMs 带亚毫秒小数，与 get/seed 侧口径不一致会导致乐观锁误判
  return statSync(abs).mtime.toISOString();
}

function requireFile(abs: string, relPath: string): string {
  try {
    if (!statSync(abs).isFile()) throw new HullError(NOTES_ERRORS.notFound, `不是文件: ${relPath}`);
    return readFileSync(abs, 'utf8');
  } catch (err) {
    if (err instanceof HullError) throw err;
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new HullError(NOTES_ERRORS.notFound, `笔记不存在: ${relPath}`);
    }
    throw ioError(relPath, err);
  }
}

function requireSourceFile(abs: string, relPath: string): void {
  try {
    if (!statSync(abs).isFile()) throw new HullError(NOTES_ERRORS.notFound, `不是文件: ${relPath}`);
  } catch (err) {
    if (err instanceof HullError) throw err;
    throw new HullError(NOTES_ERRORS.notFound, `笔记不存在: ${relPath}`);
  }
}

function nameConflict(targetPath: string, message: string): HullError & { targetPath: string } {
  const err = new HullError(NOTES_ERRORS.nameConflict, message) as HullError & { targetPath: string };
  err.targetPath = targetPath;
  return err;
}

function ioError(path: string, err: unknown): HullError {
  return new HullError(NOTES_ERRORS.ioError, `文件系统操作失败: ${path} ${(err as Error).message}`);
}

/** title → slug：Unicode 字母数字 + -，空白折叠 '-'，其余剔除；空串返回 ''（调用方落时间戳） */
function slugify(title: string): string {
  return title
    .trim()
    .replace(/\s+/g, '-')
    .replace(/[^\p{L}\p{N}-]+/gu, '')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '');
}
