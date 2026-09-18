/**
 * B3 看板合并（设计 §4.1）：复用 B5 KanbanStore.importData merge 分支。
 * 调用边界：执行器已把包内 boards 换入 userData/kanban/boards.json（基底）；本函数在临时实例上
 * 导入本地旧数据（backupBoardsPath）→ 冲突板重 id + 引用重映射 + 追加（不覆盖包内）。
 * importData('merge') 不触发 replace 分支的 preimport 备份（backupPreimport 仅 replace 调用），
 * 无重复备份写盘；结果由 store 内部 flushNow 原子写回 boards.json。
 */
import { existsSync, readFileSync } from 'node:fs';

import { KanbanStore } from '../../kanban/KanbanStore';
import type { KanbanData } from '../../kanban/types';
import { NOOP_LOGGER, type RuntimeLogger } from '../../shared/types';
import { emptyReport, type MergeReport } from './conflicts';

export function mergeKanban(ctx: {
  userDataPath: string;
  backupBoardsPath: string;
  logger: RuntimeLogger;
}): { report: MergeReport; boards: KanbanData } {
  const report = emptyReport();
  // 临时实例只用于"导入本地旧数据"；日志走 NOOP（避免恢复早期日志半初始化依赖）
  const store = new KanbanStore({ userDataPath: ctx.userDataPath, logger: NOOP_LOGGER });
  try {
    if (!existsSync(ctx.backupBoardsPath)) {
      ctx.logger.info(`[backup] merge 看板：本地预备份不存在，保持包内基线（${ctx.backupBoardsPath}）`);
      return { report, boards: store.snapshot() };
    }
    let localBoards: KanbanData;
    try {
      localBoards = JSON.parse(readFileSync(ctx.backupBoardsPath, 'utf8')) as KanbanData;
    } catch (err) {
      throw new Error(`本地预备份看板解析失败: ${(err as Error).message}`);
    }
    if (!localBoards || typeof localBoards !== 'object' || !Array.isArray(localBoards.boards)) {
      throw new Error('本地预备份看板结构非法（缺 boards[]）');
    }

    // 冲突板 = 本地 id ∩ 包内基底 id；remapMerge 按 boards 顺序重 id，可按下标映射回旧 id
    const baseIds = new Set(store.snapshot().boards.map((b) => b.id));
    const conflictOldIds = localBoards.boards.filter((b) => baseIds.has(b.id)).map((b) => b.id);

    const result = store.importData(localBoards, 'merge');
    report.classes.kanban.added = result.applied.boardsImported;
    result.ids.regenerated.forEach((newId, index) => {
      report.conflicts.push({
        kind: 'kanban',
        id: conflictOldIds[index],
        resolution: 'appended',
        detail: `看板 id 冲突，已重 id 为 ${newId}（任务/列/时间线引用同步重映射）`,
      });
    });
    return { report, boards: store.snapshot() };
  } finally {
    store.dispose(); // 清防抖 timer；importData 已同步 flushNow 落盘
  }
}
