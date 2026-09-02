/**
 * cline 平台适配器（T1 JSONL/JSON 型）：
 * - 路径 ~/.cline/data/tasks/<taskId>/api_conversation_history.json（扩展名 .json，实为 JSONL；部分版本整文件为单行 JSON 数组——两种都兼容）
 * - assistant 消息：{ role, model, usage:{input_tokens, output_tokens, cache_creation_input_tokens, cache_read_input_tokens}, ts(ms) }——anthropic 风格，用 shared.toRecord
 * 参考：docs/research/2026-09-02-agent-token-format-research.md §4
 */
import { readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import type { PlatformSource, UsageRecord } from '../types';
import { findString, num, safeJson, toRecord } from './shared';

/** 单条 assistant 消息 → UsageRecord（非 assistant / 无 usage → null） */
export function parseClineMessage(j: Record<string, unknown>, fallbackTs: string): UsageRecord | null {
  if (j.role !== 'assistant') return null;
  const usage = j.usage as Record<string, unknown> | undefined;
  const tsNum = typeof j.ts === 'number' ? j.ts : typeof j.timestamp === 'number' ? j.timestamp : NaN;
  const ts = Number.isFinite(tsNum) ? new Date(tsNum).toISOString() : typeof j.timestamp === 'string' ? j.timestamp : fallbackTs;
  const modelInfo = j.modelInfo as Record<string, unknown> | undefined;
  const model = (j.model as string) || (typeof modelInfo?.modelId === 'string' ? modelInfo.modelId : undefined) || findString(j, 'model', 3) || 'unknown';
  if (usage && typeof usage === 'object') return toRecord({ ts, platform: 'cline', model }, usage);
  // 旧版 cline：metrics.tokens {prompt, completion, cached}（无 anthropic usage）
  const tokens = (j.metrics as Record<string, unknown> | undefined)?.tokens as Record<string, unknown> | undefined;
  if (!tokens || typeof tokens !== 'object') return null;
  const inputTokens = num(tokens.prompt);
  const outputTokens = num(tokens.completion);
  const cacheReadTokens = num(tokens.cached);
  if (inputTokens === 0 && outputTokens === 0 && cacheReadTokens === 0) return null;
  return { ts, platform: 'cline', model, inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens: 0, reasoningTokens: 0 };
}

/** 逐行解析（单条消息对象） */
export function parseClineLine(line: string, fallbackTs: string): UsageRecord | null {
  const j = safeJson(line);
  if (!j || Array.isArray(j)) return null;
  return parseClineMessage(j, fallbackTs);
}

/** 整文件解析：兼容 JSONL（每行一条消息）与单行 JSON 数组两种版本 */
export function parseClineFile(text: string, fallbackTs: string): UsageRecord[] {
  const out: UsageRecord[] = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    const j = safeJson(line);
    if (!j) continue;
    if (Array.isArray(j)) {
      for (const m of j) {
        const r = parseClineMessage(m as Record<string, unknown>, fallbackTs);
        if (r) out.push(r);
      }
    } else {
      const r = parseClineMessage(j, fallbackTs);
      if (r) out.push(r);
    }
  }
  return out;
}

function walk(dir: string, out: string[]): void {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return; // 子目录 EPERM/ENOENT → 跳过不中断
  }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name === 'api_conversation_history.json') out.push(p);
  }
}

export function createClineSource(home: string = homedir()): PlatformSource {
  const tasksDir = join(home, '.cline', 'data', 'tasks');
  return {
    platform: 'cline',
    home: tasksDir,
    listFiles: () => {
      const files: string[] = [];
      walk(tasksDir, files);
      return files;
    },
    parseFile: parseClineFile,
  };
}
