/**
 * opencode 平台适配器（T1 JSONL/JSON 型）：
 * - 路径 ~/.opencode/token-history/YYYY-MM.json，按月 JSON 数组（官方未收录，本机实测格式）
 * - 每条会话 { sessionID, projectID, timestamp(ms), totals{...}, byModel{模型名:{input,output,total,reasoning,cache:{read,write}}} }
 * - 语义：按 byModel 键拆多条 UsageRecord（模型级明细，totals 为汇总不单出记录）
 * 参考：docs/research/2026-09-02-agent-token-format-research.md §3
 */
import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import type { PlatformSource, UsageRecord } from '../types';
import { num, safeJson } from './shared';

/** 单条会话记录 → 按 byModel 键拆 0..N 条 UsageRecord（空/零值模型跳过） */
export function parseOpenCodeEntry(entry: unknown, fallbackTs: string): UsageRecord[] {
  if (!entry || typeof entry !== 'object') return [];
  const e = entry as Record<string, unknown>;
  const byModel = e.byModel;
  if (!byModel || typeof byModel !== 'object') return [];
  const ts = typeof e.timestamp === 'number' ? new Date(e.timestamp).toISOString() : fallbackTs;
  const out: UsageRecord[] = [];
  for (const [model, v] of Object.entries(byModel as Record<string, unknown>)) {
    if (!v || typeof v !== 'object') continue;
    const m = v as Record<string, unknown>;
    const cache = (m.cache ?? {}) as Record<string, unknown>;
    // 对齐 anthropic 约定（与 claude/codex 一致）：opencode byModel.output 不含 reasoning，output 补入 reasoning 避免合计低估
    const reasoningTokens = num(m.reasoning);
    const rec: UsageRecord = {
      ts,
      platform: 'opencode',
      model,
      inputTokens: num(m.input),
      outputTokens: num(m.output) + reasoningTokens,
      cacheReadTokens: num(cache.read),
      cacheWriteTokens: num(cache.write),
      reasoningTokens,
    };
    if (rec.inputTokens === 0 && rec.outputTokens === 0 && rec.cacheReadTokens === 0 && rec.cacheWriteTokens === 0 && rec.reasoningTokens === 0) continue;
    out.push(rec);
  }
  return out;
}

/** 整文件解析：JSON 数组（按月），全部会话记录展开 */
export function parseOpenCodeFile(text: string, fallbackTs: string): UsageRecord[] {
  const j = safeJson(text);
  if (!j) return [];
  const arr = Array.isArray(j) ? j : [j];
  const out: UsageRecord[] = [];
  for (const e of arr) out.push(...parseOpenCodeEntry(e, fallbackTs));
  return out;
}

export function createOpenCodeSource(home: string = homedir()): PlatformSource {
  const tokenHistory = join(home, '.opencode', 'token-history');
  return {
    platform: 'opencode',
    home: tokenHistory,
    listFiles: () => {
      if (!existsSync(tokenHistory)) return [];
      return readdirSync(tokenHistory)
        .filter((f) => f.endsWith('.json'))
        .map((f) => join(tokenHistory, f));
    },
    parseFile: parseOpenCodeFile,
  };
}
