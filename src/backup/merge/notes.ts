/**
 * B3 笔记合并（设计 §4.2）：
 * 基线 = userData/notes（执行器 reset 后 = 包内内容）；本地预备份（backupNotesRoot）按文件级并入：
 * - 目标相对路径不存在 → 拷入（added）；
 * - 目标存在且内容 hash 相同 → 跳过（skipped-identical）；
 * - 不同 → 本地版本保留原名，包内版本落 `原名 (恢复冲突 YYYYMMDD-HHmmss).md`（重名递增 -2，renamed）；
 *   方向由三方 hash 判定（userData / backup / incoming），执行器无论先 reset 到哪侧都不丢内容；
 * - 4.2b 回收站：trash.json 按 id 并集（包内基序 + 本地追加），实体缺失者从 backup/.trash 拷入。
 * 所有写盘 temp+rename 原子；`.trash/` 与 trash.json 不进文件级合并。
 */
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, relative, sep } from 'node:path';

import type { TrashEntry } from '../../notes/types';
import { emptyReport, type ConflictEntry, type MergeReport } from './conflicts';

const TRASH_DIR = '.trash';
const TRASH_FILE = 'trash.json';

function sha256(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

/** YYYYMMDD-HHmmss（本地时区，对齐备份目录命名；now 可注入便于测试） */
function stamp(d: Date): string {
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

function toPosix(rel: string): string {
  return rel.split(sep).join('/');
}

/** 原子文件写（temp+rename；父目录自动创建） */
function copyAtomic(src: string, dst: string): void {
  mkdirSync(dirname(dst), { recursive: true });
  const tmp = `${dst}.tmp-${process.pid}-${Date.now()}`;
  copyFileSync(src, tmp);
  renameSync(tmp, dst);
}

function writeJsonAtomic(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, JSON.stringify(value), 'utf8');
  renameSync(tmp, path);
}

/** 枚举 root 下 *.md（跳过 .trash/ 与 trash.json；相对路径） */
function listMdFiles(root: string): string[] {
  const out: string[] = [];
  if (!existsSync(root)) return out;
  const walk = (dir: string): void => {
    for (const ent of readdirSync(dir, { withFileTypes: true })) {
      if (ent.name === TRASH_DIR) continue;
      const abs = join(dir, ent.name);
      if (ent.isDirectory()) walk(abs);
      else if (ent.isFile() && ent.name.endsWith('.md')) out.push(relative(root, abs));
    }
  };
  walk(root);
  return out;
}

/** 冲突名：原名 (恢复冲突 YYYYMMDD-HHmmss).md；重名递增 -2/-3…（首份冲突文件不覆盖） */
function uniqueConflictRel(notesRoot: string, rel: string, now: Date): string {
  const dir = dirname(rel);
  const stem = basename(rel).replace(/\.md$/, '');
  const t = stamp(now);
  for (let i = 1; i < 1000; i++) {
    const name = `${stem} (恢复冲突 ${t})${i > 1 ? `-${i}` : ''}.md`;
    const candidate = dir === '.' ? name : join(dir, name);
    if (!existsSync(join(notesRoot, candidate))) return candidate;
  }
  // 不可能到达（1000 次内必空）；保险取 -timestamp 后缀
  return join(dir === '.' ? '' : dir, `${stem} (恢复冲突 ${t}-${Date.now()}).md`);
}

/** 条目形状与 NotesTrash.load 同口径（缺 sizeBytes 的条目加载器丢弃 → merge 也不得写出/保留） */
function isValidTrashEntry(e: unknown): e is TrashEntry {
  const t = e as TrashEntry;
  return (
    !!t &&
    typeof t === 'object' &&
    typeof t.id === 'string' &&
    typeof t.originalPath === 'string' &&
    typeof t.deletedAt === 'string' &&
    typeof t.sizeBytes === 'number'
  );
}

function readTrashEntries(path: string): TrashEntry[] {
  if (!existsSync(path)) return [];
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as { entries?: unknown };
    return Array.isArray(parsed?.entries) ? parsed.entries.filter(isValidTrashEntry) : [];
  } catch {
    return []; // 损坏按空（条目实体仍在 backup 目录，可人工恢复；B2 预演已校验包内形状）
  }
}

export function mergeNotes(ctx: {
  userDataPath: string;
  backupNotesRoot: string;
  incomingNotesRoot: string;
  now(): Date;
}): { report: MergeReport } {
  const report = emptyReport();
  const notesRoot = join(ctx.userDataPath, 'notes');
  const now = ctx.now();

  // ── 文件级 ──
  for (const rel of listMdFiles(ctx.backupNotesRoot)) {
    const src = join(ctx.backupNotesRoot, rel);
    const dst = join(notesRoot, rel);
    const srcHash = sha256(src);

    if (!existsSync(dst)) {
      copyAtomic(src, dst);
      report.classes.note.added++;
      continue;
    }
    const dstHash = sha256(dst);
    if (dstHash === srcHash) {
      report.classes.note.skipped++;
      report.conflicts.push({ kind: 'note', path: toPosix(rel), resolution: 'skipped-identical', detail: '内容 hash 相同，跳过' });
      continue;
    }

    const incomingPath = join(ctx.incomingNotesRoot, rel);
    const incomingHash = existsSync(incomingPath) ? sha256(incomingPath) : null;
    const conflictRel = uniqueConflictRel(notesRoot, rel, now);
    if (incomingHash !== null && incomingHash === dstHash) {
      // 目标当前是包内版本 → 包内落冲突名，本地版本回原名
      renameSync(dst, join(notesRoot, conflictRel));
      copyAtomic(src, dst);
      report.classes.note.updated++;
      report.conflicts.push({ kind: 'note', path: toPosix(rel), resolution: 'renamed', detail: `包内版本 → ${toPosix(conflictRel)}` });
    } else if (incomingHash !== null) {
      // 目标已是本地/未知内容 → 保留原名，包内版本落冲突名
      copyAtomic(incomingPath, join(notesRoot, conflictRel));
      report.classes.note.updated++;
      report.conflicts.push({ kind: 'note', path: toPosix(rel), resolution: 'renamed', detail: `保留原名，包内版本 → ${toPosix(conflictRel)}` });
    } else {
      // 包内无对应版本（incoming 缺失）→ 两侧无法比较，保留目标不动
      report.classes.note.skipped++;
      report.conflicts.push({ kind: 'note', path: toPosix(rel), resolution: 'kept-local', detail: '包内无对应文件版本，保留现内容' });
    }
  }

  // ── 回收站（4.2b） ──
  const baseEntries = readTrashEntries(join(notesRoot, TRASH_FILE));
  const localEntries = readTrashEntries(join(ctx.backupNotesRoot, TRASH_FILE));
  const incomingEntries = readTrashEntries(join(ctx.incomingNotesRoot, TRASH_FILE));
  const mergedTrash: TrashEntry[] = baseEntries.map((e) => ({ ...e }));
  const seenIds = new Set(mergedTrash.map((e) => e.id));
  const appendedLocal: ConflictEntry[] = [];
  for (const entry of [...localEntries, ...incomingEntries]) {
    if (seenIds.has(entry.id)) continue;
    seenIds.add(entry.id);
    mergedTrash.push({ ...entry });
    report.classes.note.added++;
    if (localEntries.includes(entry)) {
      appendedLocal.push({ kind: 'note', path: TRASH_FILE, id: entry.id, resolution: 'appended', detail: '本地回收站条目并入' });
    }
  }
  report.conflicts.push(...appendedLocal);

  // 实体缺失 → 从 backup（本地实体）/ incoming（包内实体）拷入
  for (const entry of mergedTrash) {
    const entity = join(notesRoot, TRASH_DIR, `${entry.id}.md`);
    if (existsSync(entity)) continue;
    for (const sourceRoot of [ctx.backupNotesRoot, ctx.incomingNotesRoot]) {
      const source = join(sourceRoot, TRASH_DIR, `${entry.id}.md`);
      if (existsSync(source)) {
        copyAtomic(source, entity);
        break;
      }
    }
  }

  if (JSON.stringify(mergedTrash) !== JSON.stringify(baseEntries)) {
    writeJsonAtomic(join(notesRoot, TRASH_FILE), { entries: mergedTrash });
  }

  return { report };
}
