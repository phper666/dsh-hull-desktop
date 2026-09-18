/**
 * B3 merge 冲突清单 + 合并报告类型（feishu-backup-api-contract §MergeReport / 设计 §4）
 * 契约 ConflictKind 原为 5 类，恢复合并新增 'notif'（通知去重/ring cap 裁剪不再借 workflow 计数）；
 * Resolution 6 种；MergeReport = classes + conflicts + notices。
 * ResultNotice 唯一定义处迁至 ../result（依赖方向单向：merge → result），此处再导出兼容既有 import。
 */
import type { RestoreMergeReport, ResultNotice } from '../result';

export type { ResultNotice } from '../result';

/** 编译期互操作断言（漂移即编译失败）：MergeReport 必须可直接填入 RestoreResult.merge */
type _MergeReportFitsRestore = MergeReport extends RestoreMergeReport ? true : never;

export type ConflictKind = 'note' | 'kanban' | 'workflow' | 'skill' | 'setting' | 'notif';

export type Resolution = 'renamed' | 'appended' | 'kept-local' | 'overwritten' | 'missing-path' | 'skipped-identical';

export interface ConflictEntry {
  kind: ConflictKind;
  path?: string;
  id?: string;
  resolution: Resolution;
  detail?: string;
}

export interface ClassCounts {
  added: number;
  updated: number;
  skipped: number;
}

export interface MergeReport {
  classes: Record<ConflictKind, ClassCounts>;
  conflicts: ConflictEntry[];
  notices: ResultNotice[];
}

function zeroCounts(): ClassCounts {
  return { added: 0, updated: 0, skipped: 0 };
}

export function emptyReport(): MergeReport {
  return {
    classes: {
      note: zeroCounts(),
      kanban: zeroCounts(),
      workflow: zeroCounts(),
      skill: zeroCounts(),
      setting: zeroCounts(),
      notif: zeroCounts(),
    },
    conflicts: [],
    notices: [],
  };
}

/** 汇总各类 report（计数相加 + 清单拼接；不改入参） */
export function mergeReports(...reports: MergeReport[]): MergeReport {
  const out = emptyReport();
  for (const r of reports) {
    for (const kind of Object.keys(out.classes) as ConflictKind[]) {
      const src = r.classes[kind];
      const dst = out.classes[kind];
      if (!src) continue;
      dst.added += src.added;
      dst.updated += src.updated;
      dst.skipped += src.skipped;
    }
    out.conflicts.push(...r.conflicts);
    out.notices.push(...r.notices);
  }
  return out;
}
