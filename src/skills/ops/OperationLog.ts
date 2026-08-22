/**
 * 操作日志（CON-R-skills-003/008，设计 D6）
 * operations.jsonl append-only JSON Lines；启动 >10MB 截断保留最近 1000 行；
 * 尾读 N 条时间倒序。userData 侧文件——直接 node:fs（HashCache 先例），不经 SkillFsOps。
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';

import type { OperationLogEntry } from '../types';

export const LOG_TRUNCATE_BYTES = 10 * 1024 * 1024; // >10MB 启动截断
export const LOG_TRUNCATE_KEEP = 1000;

export class OperationLog {
  constructor(private readonly filePath: string) {}

  /** 启动调用：超阈值截断保留最近 LOG_TRUNCATE_KEEP 行 */
  init(): void {
    if (!existsSync(this.filePath)) return;
    let size: number;
    try {
      size = statSync(this.filePath).size;
    } catch {
      return;
    }
    if (size <= LOG_TRUNCATE_BYTES) return;
    try {
      const lines = readFileSync(this.filePath, 'utf8').split('\n').filter((l) => l.trim() !== '');
      const keep = lines.slice(-LOG_TRUNCATE_KEEP);
      const tmp = `${this.filePath}.tmp-${process.pid}-${Date.now()}`;
      writeFileSync(tmp, keep.join('\n') + '\n', 'utf8');
      renameSync(tmp, this.filePath);
    } catch {
      /* 截断失败无害（下次启动重试） */
    }
  }

  /** 追加一行（append-only；崩溃安全：半行损坏由读取端跳过） */
  append(entry: OperationLogEntry): void {
    try {
      mkdirSync(this.filePath.slice(0, Math.max(this.filePath.lastIndexOf('/'), 0)) || '.', { recursive: true });
      appendFileSync(this.filePath, JSON.stringify(entry) + '\n', 'utf8');
    } catch {
      /* 日志写失败不阻塞操作本身（操作结果已回传 UI） */
    }
  }

  /** 尾读最近 limit 条，时间倒序（最新在前）；坏行跳过 */
  readTail(limit = 200): OperationLogEntry[] {
    if (!existsSync(this.filePath)) return [];
    let raw: string;
    try {
      raw = readFileSync(this.filePath, 'utf8');
    } catch {
      return [];
    }
    const out: OperationLogEntry[] = [];
    const lines = raw.split('\n');
    for (let i = lines.length - 1; i >= 0 && out.length < limit; i--) {
      const line = lines[i]!.trim();
      if (line === '') continue;
      try {
        const parsed = JSON.parse(line) as OperationLogEntry;
        if (parsed && typeof parsed.action === 'string' && Array.isArray(parsed.paths)) out.push(parsed);
      } catch {
        /* 半行/损坏行跳过 */
      }
    }
    return out;
  }
}
