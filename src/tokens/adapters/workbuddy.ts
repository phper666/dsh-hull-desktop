/**
 * WorkBuddy（腾讯）JSONL 适配器（T1 逐请求，与 TokenTracker 同源同口径）：
 * - 数据源：~/.workbuddy/projects/**\/*.jsonl —— 每行一个会话事件，只取带 providerData.usage 对象的行
 *   （同文件还有 message/reasoning/function_call/file-history-snapshot 等类型；function_call 行也带 usage，
 *    所以只按 usage 字段存在判定，不按 type 过滤——按 type 过滤会漏掉今日 14 行中的 12 行）
 * - 口径（实测对齐 TokenTracker）：usage.inputTokens **包含**缓存命中部分，故
 *   inputTokens = max(0, usage.inputTokens − Σ inputTokensDetails[].cached_tokens)，
 *   cacheReadTokens = Σ cached_tokens，outputTokens = usage.outputTokens，
 *   reasoning_tokens 是 output 的**子集**（不叠加，仅展示，加了会重复计）
 *   → aggregator 的 total = input + output + cacheRead + cacheWrite = usage.inputTokens + usage.outputTokens = usage.totalTokens
 * - 实证（2026-11-06，14 条 usage 行，model=glm-5.3-flash）：Σ totalTokens = 3,511,818，与 TokenTracker 3.5M 一致；
 *   旧的 workbuddy.db → session_usage.used 只得 254,361，是会话级粗粒度数字、非 token 口径，
 *   且与逐请求总量不同 metric，**不能两源相加**（否则总量被重复计一遍）
 * - 防御式：坏 JSON / 无 timestamp / usage 非对象 / 全零行 → 跳过；只读（CON-R002）
 */
import { readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import type { PlatformSource, UsageRecord } from '../types';
import { num, safeJson } from './shared';

export function workbuddyProjectsDir(home: string): string {
  return join(home, '.workbuddy', 'projects');
}

/** Σ details[].<key>（非数组/缺字段 → 0） */
function sumDetails(v: unknown, key: string): number {
  if (!Array.isArray(v)) return 0;
  let total = 0;
  for (const item of v) {
    if (item && typeof item === 'object') total += num((item as Record<string, unknown>)[key]);
  }
  return total;
}

/** timestamp（unix ms）→ ISO；缺失/非法 → null（不 mtime 兜底，宁缺勿错） */
function lineTs(v: unknown): string | null {
  if (v == null) return null;
  const d = new Date(typeof v === 'number' ? v : String(v));
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/** 单行 → UsageRecord：仅 providerData.usage 对象行；input 扣缓存，output 不叠加 reasoning */
export function parseWorkbuddyLine(line: string, _fallbackTs: string): UsageRecord | null {
  const j = safeJson(line);
  const providerData = j?.providerData as Record<string, unknown> | undefined;
  const usage = providerData?.usage as Record<string, unknown> | undefined;
  if (!usage || typeof usage !== 'object') return null;
  const ts = lineTs(j?.timestamp);
  if (!ts) return null;

  const cached = sumDetails(usage.inputTokensDetails, 'cached_tokens');
  const inputTokens = Math.max(0, num(usage.inputTokens) - cached);
  const outputTokens = num(usage.outputTokens);
  const reasoningTokens = sumDetails(usage.outputTokensDetails, 'reasoning_tokens');
  if (inputTokens === 0 && outputTokens === 0 && cached === 0 && reasoningTokens === 0) return null;

  const model = typeof providerData?.model === 'string' && providerData.model !== 'auto' ? providerData.model : 'unknown';
  return {
    ts,
    platform: 'workbuddy',
    model,
    inputTokens,
    outputTokens,
    cacheReadTokens: cached,
    cacheWriteTokens: 0,
    reasoningTokens,
  };
}

function listJsonlFiles(dir: string, out: string[]): void {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return; // 目录不存在/EPERM → 跳过不中断
  }
  for (const entry of entries) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) listJsonlFiles(p, out);
    else if (entry.name.endsWith('.jsonl')) out.push(p);
  }
}

/** 平台源（home 可注入测试）：递归收集 projects 下 *.jsonl，逐行解析 */
export function createWorkbuddySource(home: string = homedir()): PlatformSource {
  const projectsDir = workbuddyProjectsDir(home);
  return {
    platform: 'workbuddy',
    home: projectsDir,
    listFiles: () => {
      const out: string[] = [];
      listJsonlFiles(projectsDir, out);
      return out;
    },
    parseLine: parseWorkbuddyLine,
  };
}
