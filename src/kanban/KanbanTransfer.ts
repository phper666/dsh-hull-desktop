/**
 * B5 导出/导入传输层（feishu-b5-m2-kanban-api-contract.md §接口清单）
 * 主进程侧：文件读写（读导入文件 / 原子写导出文件）+ 原生保存/打开对话框 + dialog 取消。
 * 校验/重映射/应用逻辑在 KanbanStore（本层薄封装，依赖可注入便于单测）。
 * electron 懒加载：node:test 下 require('electron') 不可用（非 Electron 运行时），
 * 依赖通过 new KanbanTransfer({ userDataPath, dialog, fs }) 注入。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { HullError } from '../shared/errors';
import { NOOP_LOGGER, type RuntimeLogger } from '../shared/types';
import { KanbanStore } from './KanbanStore';
import { KANBAN_B5_ERRORS, type ImportMode, type ImportResult, type KanbanData } from './types';

/** electron dialog 接口（测试注入 mock；仅用到的方法需实现） */
export interface TransferDialog {
  showSaveDialog?(options: { title: string; defaultPath: string; filters: { name: string; extensions: string[] }[] }): Promise<{ canceled: boolean; filePath?: string }>;
  showOpenDialog?(options: { title: string; filters: { name: string; extensions: string[] }[] }): Promise<{ canceled: boolean; filePaths?: string[] }>;
}

export interface KanbanTransferOptions {
  userDataPath: string;
  store: KanbanStore;
  dialog?: TransferDialog;
  logger?: RuntimeLogger;
  /** 测试注入：导出文件写失败钩子（原子写失败路径） */
  onExportWriteError?: (err: Error) => void;
}

export interface ExportResult {
  path: string;
  scope: 'board' | 'all';
  boardCount: number;
  taskCount: number;
  attachmentCount: number;
  exportedAt: string;
}

/** 导出默认文件名（看板名或全看板） */
export function exportFileName(boardName?: string): string {
  const base = boardName ? boardName.replace(/[\\/:*?"<>|]/g, '_') : 'kanban-boards';
  return `${base}.kanban.json`;
}

/**
 * 主进程 exportBoard/importBoard 编排（B5 契约 §接口详情）。
 * exportBoard：快照 → 保存对话框 → 原子写 → ExportResult；取消 → { cancelled: true }。
 * importBoard：读文件 → JSON 解析 → store.importData（校验+应用）；失败零改动。
 */
export class KanbanTransfer {
  private readonly store: KanbanStore;
  private readonly userDataPath: string;
  private readonly dialog: TransferDialog;
  private readonly logger: RuntimeLogger;
  private readonly onExportWriteError?: (err: Error) => void;

  constructor(options: KanbanTransferOptions) {
    this.store = options.store;
    this.userDataPath = options.userDataPath;
    this.logger = options.logger ?? NOOP_LOGGER;
    this.onExportWriteError = options.onExportWriteError;
    // electron 懒加载：测试注入 dialog；生产 require('electron')
    this.dialog = options.dialog ?? (require('electron') as { dialog: TransferDialog }).dialog;
  }

  /** 导出（单看板/全看板）→ 保存对话框 → 原子写 → ExportResult；取消 → { cancelled: true } */
  async exportBoard(boardId?: string): Promise<ExportResult | { cancelled: true }> {
    const snapshot = this.store.exportSnapshot(boardId);
    const scope: 'board' | 'all' = boardId !== undefined ? 'board' : 'all';
    const boardName = boardId !== undefined ? snapshot.boards[0]?.name : undefined;
    const result = await this.dialog.showSaveDialog!({
      title: '导出看板',
      defaultPath: join(this.userDataPath, exportFileName(boardName)),
      filters: [{ name: '看板 JSON', extensions: ['json'] }],
    });
    if (result.canceled || !result.filePath) {
      return { cancelled: true };
    }
    this.writeExportFile(result.filePath, snapshot);
    const tasks = snapshot.boards.reduce((n, b) => n + b.tasks.length, 0);
    const attachments = snapshot.boards.reduce(
      (n, b) => n + b.tasks.reduce((m, t) => m + t.timeline.reduce((k, tl) => k + tl.attachments.length, 0), 0),
      0
    );
    return {
      path: result.filePath,
      scope,
      boardCount: snapshot.boards.length,
      taskCount: tasks,
      attachmentCount: attachments,
      exportedAt: new Date().toISOString(),
    };
  }

  /** 导入（合并/替换）→ 读文件 → 校验 → 原子应用 → ImportResult；失败 HullError 现有数据零改动 */
  importBoard(filePath: string, mode: ImportMode): ImportResult {
    let raw: string;
    try {
      raw = readFileSync(filePath, 'utf8');
    } catch (err) {
      throw new HullError(KANBAN_B5_ERRORS.importInvalidJson, `读取导入文件失败: ${(err as Error).message}`);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new HullError(KANBAN_B5_ERRORS.importInvalidJson, '文件损坏或非 JSON');
    }
    return this.store.importData(parsed as KanbanData, mode);
  }

  /** 导出文件原子写（temp+rename；目标目录不存在先建） */
  private writeExportFile(targetPath: string, data: KanbanData): void {
    try {
      const dir = dirname(targetPath);
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      const tmp = `${targetPath}.tmp`;
      writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
      renameSync(tmp, targetPath);
    } catch (err) {
      const e = err as Error;
      this.onExportWriteError?.(e);
      throw new HullError(KANBAN_B5_ERRORS.exportIo, `导出文件写入失败: ${e.message}`);
    }
  }
}
