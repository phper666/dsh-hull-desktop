/**
 * 执行输出日志读取（Q-回复落盘 2026-09-05）
 * ExecutionEngine 流式输出落盘 <userData>/kanban/executions/e_<id>.log；
 * 此处按任务 timeline 最新 execution 条目的 outputPath（相对 userData）读回文本，
 * 供 kanban:getExecutionLog IPC 消费（详情弹框「执行输出」区块）。
 */
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import type { Task } from './types';

/** 输出日志相对目录（与 ExecutionEngine.executionLogPath 对齐） */
export const EXECUTIONS_REL_DIR = 'kanban/executions';

/**
 * 读任务最近一次执行的输出日志全文。
 * 无 execution 条目 / outputPath 缺失 / 文件不存在 / 读取异常 → null（UI 区块隐藏）。
 * outputPath 仅接受 EXECUTIONS_REL_DIR 前缀（防 store 数据异常导致目录逃逸）。
 */
export function readLatestExecutionLog(userDataPath: string, task: Task): string | null {
  const entries = task.timeline.filter((x) => x.type === 'execution' && x.execution?.outputPath);
  const last = entries[entries.length - 1];
  const rel = last?.execution?.outputPath;
  if (!rel) return null;
  const normalized = resolve(userDataPath, rel);
  const root = resolve(userDataPath, EXECUTIONS_REL_DIR);
  if (!normalized.startsWith(root + '\\') && !normalized.startsWith(root + '/')) return null;
  try {
    return existsSync(normalized) ? readFileSync(normalized, 'utf8') : null;
  } catch {
    return null;
  }
}
