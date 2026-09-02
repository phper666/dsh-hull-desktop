/**
 * gemini CLI 平台适配器（T1 JSONL 型）：
 * - 路径 ~/.gemini/tmp/<project_hash>/chats/session-*.jsonl（递归 ~/.gemini/tmp 下 chats 目录的 *.jsonl）
 * - 每行 MessageRecord；找 tokens（TokensSummary）形态：{ input:{promptTokenCount}, output:{candidatesTokenCount}, cached:{cachedContentTokenCount}, total:{totalTokenCount} }
 * - 映射：inputTokens=promptTokenCount / outputTokens=candidatesTokenCount / cacheReadTokens=cachedContentTokenCount / reasoning 无则 0
 * 参考：docs/research/2026-09-02-agent-token-format-research.md §6
 */
import { readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, sep } from 'node:path';

import type { PlatformSource, UsageRecord } from '../types';
import { findString, num, safeJson } from './shared';

/** 逐行解析：有 tokens 形态 → UsageRecord；否则 null */
export function parseGeminiLine(line: string, fallbackTs: string): UsageRecord | null {
  const j = safeJson(line);
  if (!j) return null;
  const tokens = j.tokens as Record<string, unknown> | undefined;
  if (!tokens || typeof tokens !== 'object') return null;
  const input = (tokens.input ?? {}) as Record<string, unknown>;
  const output = (tokens.output ?? {}) as Record<string, unknown>;
  const cached = (tokens.cached ?? {}) as Record<string, unknown>;
  const inputTokens = num(input.promptTokenCount);
  const outputTokens = num(output.candidatesTokenCount);
  const cacheReadTokens = num(cached.cachedContentTokenCount);
  if (inputTokens === 0 && outputTokens === 0 && cacheReadTokens === 0) return null;
  const ts = typeof j.timestamp === 'string' ? j.timestamp : typeof j.timestamp === 'number' ? new Date(j.timestamp).toISOString() : fallbackTs;
  const model = (j.model as string) || findString(j, 'model', 3) || 'unknown';
  return { ts, platform: 'gemini', model, inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens: 0, reasoningTokens: 0 };
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
    else if (e.name.endsWith('.jsonl') && p.includes(`${sep}chats${sep}`)) out.push(p);
  }
}

export function createGeminiSource(home: string = homedir()): PlatformSource {
  const chatsRoot = join(home, '.gemini', 'tmp');
  return {
    platform: 'gemini',
    home: chatsRoot,
    listFiles: () => {
      const files: string[] = [];
      walk(chatsRoot, files);
      return files;
    },
    parseLine: parseGeminiLine,
  };
}
