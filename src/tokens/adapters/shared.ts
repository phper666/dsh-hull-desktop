/**
 * 平台适配器共享工具（v2 全量平台扩展）：
 * - num/safeJson/findUsageShape/toRecord：JSONL/JSON 型防御式解析基础（原 TokenUsageScanner.ts 内嵌，v2 抽出供各 adapter 复用）
 * - fileFingerprint：文件指纹（调试/未来缓存增量用）
 * 纯函数，无平台耦合。
 */
import { createHash } from 'node:crypto';
import { statSync } from 'node:fs';

import type { UsageRecord } from '../types';

export function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.floor(v) : 0;
}

export function safeJson(line: string): Record<string, unknown> | null {
  try {
    const j = JSON.parse(line);
    return typeof j === 'object' && j !== null ? (j as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** 深度 ≤4 找「usage 形态」对象（input/output 数值字段齐备）——codex/dsh/kimi 等内部格式防御式提取 */
export function findUsageShape(obj: unknown, depth = 0): Record<string, unknown> | null {
  if (depth > 4 || obj === null || typeof obj !== 'object') return null;
  const o = obj as Record<string, unknown>;
  if (typeof o.input_tokens === 'number' && typeof o.output_tokens === 'number') return o;
  for (const v of Object.values(o)) {
    if (v && typeof v === 'object') {
      const hit = findUsageShape(v, depth + 1);
      if (hit) return hit;
    }
  }
  return null;
}

export function findString(obj: unknown, key: string, depth: number): string | null {
  if (depth <= 0 || obj === null || typeof obj !== 'object') return null;
  const o = obj as Record<string, unknown>;
  if (typeof o[key] === 'string') return o[key] as string;
  for (const v of Object.values(o)) {
    if (v && typeof v === 'object') {
      const hit = findString(v, key, depth - 1);
      if (hit) return hit;
    }
  }
  return null;
}

export type UsagePartial = Omit<UsageRecord, 'inputTokens' | 'outputTokens' | 'cacheReadTokens' | 'cacheWriteTokens' | 'reasoningTokens'>;

/** 归一化 usage 形态 → UsageRecord（anthropic 风格字段；cache/reasoning 多别名合并） */
export function toRecord(partial: UsagePartial, usage: Record<string, unknown>): UsageRecord | null {
  const inputTokens = num(usage.input_tokens);
  const outputTokens = num(usage.output_tokens);
  const cacheReadTokens = num(usage.cache_read_input_tokens) + num(usage.cached_input_tokens) + num(usage.cache_read_tokens);
  const cacheWriteTokens = num(usage.cache_creation_input_tokens) + num(usage.cache_write_tokens);
  const reasoningTokens = num(usage.reasoning_output_tokens) + num(usage.reasoning_tokens);
  if (inputTokens === 0 && outputTokens === 0 && cacheReadTokens === 0 && cacheWriteTokens === 0 && reasoningTokens === 0) return null;
  return { ...partial, inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, reasoningTokens };
}

export function fileFingerprint(filePath: string): string {
  try {
    const s = statSync(filePath);
    return createHash('sha1').update(`${filePath}:${s.size}:${s.mtimeMs}`).digest('hex').slice(0, 16);
  } catch {
    return '';
  }
}
