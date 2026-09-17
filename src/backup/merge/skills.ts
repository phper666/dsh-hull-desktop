/**
 * B3 skills 索引并集（设计 §4.6）：
 * - disabled.json：entries 按 skillName 去重并集；trash.json：entries 按 id 去重并集；
 *   基底 = userData 当前（包内），本地预备份条目追加，incoming 仅作实体兜底来源。
 * - 实体：skills/disabled/<id>/、skills/trash/<id>/ 缺失者从 backup（本地实体）拷入，再退 incoming；
 *   本地实体仍在原位（originalPath 存在）则不重复拷。
 * - originalPath 不存在、或实体目录缺失（点「启用/恢复」会失败）→ 条目追加 missingPath?: true（仅展示）
 *   + conflicts 记 missing-path；不自动清洗条目、不重映射（CON-R-backup-008）。
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { createNodeFsOps } from '../../skills/SkillFsOps';
import type { DisabledEntry, TrashEntry } from '../../skills/types';
import { emptyReport, type MergeReport, type ResultNotice } from './conflicts';

type Marked<T> = T & { missingPath?: true };

interface IndexFile<T> {
  version: number;
  entries: T[];
}

const fsOps = createNodeFsOps();

function isDisabledEntry(v: unknown): v is DisabledEntry {
  const e = v as DisabledEntry;
  return !!e && typeof e === 'object' && typeof e.id === 'string' && typeof e.skillName === 'string' && typeof e.originalPath === 'string';
}

function isTrashEntry(v: unknown): v is TrashEntry {
  const e = v as TrashEntry;
  return !!e && typeof e === 'object' && typeof e.id === 'string' && typeof e.skillName === 'string' && typeof e.originalPath === 'string';
}

function readIndex<T>(path: string, guard: (v: unknown) => v is T): T[] | null {
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as { entries?: unknown };
    if (parsed && Array.isArray(parsed.entries)) return parsed.entries.filter(guard);
  } catch {
    /* 损坏 → 空索引（不覆盖原文件；无变更时不写） */
  }
  return [];
}

/** 实体缺失 → 拷入（backup 优先 = 本地实体；incoming 兜底 = 包内实体；原位仍在则不拷） */
function copyMissingEntities<T extends { id: string; originalPath: string }>(
  entries: T[],
  dirName: 'disabled' | 'trash',
  ctx: { userDataPath: string; backupSkillsRoot: string; incomingSkillsRoot: string },
  skip: (e: T) => boolean,
): void {
  for (const entry of entries) {
    if (skip(entry)) continue;
    if (existsSync(entry.originalPath)) continue; // 本地实体仍在原位
    const entity = join(ctx.userDataPath, 'skills', dirName, entry.id);
    if (existsSync(entity)) continue;
    const sources = [join(ctx.backupSkillsRoot, dirName, entry.id), join(ctx.incomingSkillsRoot, dirName, entry.id)];
    for (const source of sources) {
      if (existsSync(source)) {
        fsOps.mkdirSync(join(ctx.userDataPath, 'skills', dirName));
        fsOps.cpSync(source, entity);
        break;
      }
    }
  }
}

export function mergeSkillsState(ctx: {
  userDataPath: string;
  backupSkillsRoot: string;
  incomingSkillsRoot: string;
}): { report: MergeReport; notices: ResultNotice[] } {
  const report = emptyReport();
  const notices: ResultNotice[] = [];
  const skillsRoot = join(ctx.userDataPath, 'skills');

  // ── disabled.json：按 skillName 并集 ──
  const baseDisabled = readIndex(join(skillsRoot, 'disabled.json'), isDisabledEntry) ?? [];
  const localDisabled = readIndex(join(ctx.backupSkillsRoot, 'disabled.json'), isDisabledEntry) ?? [];
  const incomingDisabled = readIndex(join(ctx.incomingSkillsRoot, 'disabled.json'), isDisabledEntry) ?? [];
  const mergedDisabled: Array<Marked<DisabledEntry>> = baseDisabled.map((e) => ({ ...e }));
  const seenNames = new Set(mergedDisabled.map((e) => e.skillName));
  for (const entry of [...localDisabled, ...incomingDisabled]) {
    if (seenNames.has(entry.skillName)) {
      report.classes.skill.skipped++;
      report.conflicts.push({ kind: 'skill', id: entry.id, path: entry.originalPath, resolution: 'skipped-identical', detail: `同 skillName「${entry.skillName}」去重` });
      continue;
    }
    seenNames.add(entry.skillName);
    mergedDisabled.push({ ...entry });
    report.classes.skill.added++;
    report.conflicts.push({ kind: 'skill', id: entry.id, resolution: 'appended', detail: `禁用条目并入（${entry.skillName}）` });
  }
  copyMissingEntities(mergedDisabled, 'disabled', ctx, (e) => e.kind === 'symlink'); // symlink 条目无实体
  markMissingPaths(
    mergedDisabled,
    (entry, newly, reason) => {
      if (newly) report.classes.skill.updated++;
      report.conflicts.push({
        kind: 'skill',
        id: entry.id,
        path: entry.originalPath,
        resolution: 'missing-path',
        detail: reason === 'entity' ? '禁用实体目录缺失（无法启用），仅标注不清洗' : '原路径不存在（跨机失效），仅标注不清洗',
      });
    },
    // symlink 条目本无实体；其余实体缺失 → 点「启用」（rename <disabled>/<id> 回原位）必失败
    (e) => e.kind === 'symlink' || existsSync(join(ctx.userDataPath, 'skills', 'disabled', e.id)),
  );
  if (JSON.stringify(mergedDisabled) !== JSON.stringify(baseDisabled)) {
    fsOps.writeFileSyncAtomic(join(skillsRoot, 'disabled.json'), JSON.stringify({ version: 1, entries: mergedDisabled }));
  }

  // ── trash.json：按 id 并集 ──
  const baseTrash = readIndex(join(skillsRoot, 'trash.json'), isTrashEntry) ?? [];
  const localTrash = readIndex(join(ctx.backupSkillsRoot, 'trash.json'), isTrashEntry) ?? [];
  const incomingTrash = readIndex(join(ctx.incomingSkillsRoot, 'trash.json'), isTrashEntry) ?? [];
  const mergedTrash: Array<Marked<TrashEntry>> = baseTrash.map((e) => ({ ...e }));
  const seenIds = new Set(mergedTrash.map((e) => e.id));
  for (const entry of [...localTrash, ...incomingTrash]) {
    if (seenIds.has(entry.id)) {
      report.classes.skill.skipped++;
      report.conflicts.push({ kind: 'skill', id: entry.id, path: entry.originalPath, resolution: 'skipped-identical', detail: '同 id 去重' });
      continue;
    }
    seenIds.add(entry.id);
    mergedTrash.push({ ...entry });
    report.classes.skill.added++;
    report.conflicts.push({ kind: 'skill', id: entry.id, resolution: 'appended', detail: `回收站条目并入（${entry.skillName}）` });
  }
  copyMissingEntities(mergedTrash, 'trash', ctx, () => false);
  markMissingPaths(
    mergedTrash,
    (entry, newly, reason) => {
      if (newly) report.classes.skill.updated++;
      report.conflicts.push({
        kind: 'skill',
        id: entry.id,
        path: entry.originalPath,
        resolution: 'missing-path',
        detail: reason === 'entity' ? '回收站实体目录缺失（无法恢复），仅标注不清洗' : '原路径不存在（跨机失效），仅标注不清洗',
      });
    },
    (e) => existsSync(join(ctx.userDataPath, 'skills', 'trash', e.id)),
  );
  if (JSON.stringify(mergedTrash) !== JSON.stringify(baseTrash)) {
    fsOps.writeFileSyncAtomic(join(skillsRoot, 'trash.json'), JSON.stringify({ version: 1, entries: mergedTrash }));
  }

  return { report, notices };
}

/**
 * missingPath 标注（仅展示；不清洗条目、不重映射）；路径恢复存在则撤标注。
 * onMissing：每条判定缺失的条目回调一次（reason = 原路径缺失 'path' / 实体目录缺失 'entity'）。
 * entityExists：可选实体校验（如 disabled/trash 实体目录）；缺省只判 originalPath（replace 侧复用不改语义）。
 */
export function markMissingPaths<T extends { id: string; originalPath: string; missingPath?: true }>(
  entries: T[],
  onMissing?: (entry: T, newly: boolean, reason: 'path' | 'entity') => void,
  entityExists?: (entry: T) => boolean,
): void {
  for (const entry of entries) {
    const pathGone = typeof entry.originalPath === 'string' && !existsSync(entry.originalPath);
    const entityGone = !pathGone && entityExists !== undefined && !entityExists(entry);
    if (pathGone || entityGone) {
      const newly = entry.missingPath !== true;
      entry.missingPath = true;
      onMissing?.(entry, newly, pathGone ? 'path' : 'entity');
    } else {
      delete entry.missingPath;
    }
  }
}
