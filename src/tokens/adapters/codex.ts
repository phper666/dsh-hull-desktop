/**
 * codex adapter（~/.codex/sessions 递归 *.jsonl，支持 CODEX_HOME env）：
 * - 新版 rollout-*.jsonl：token_count 事件在 payload（total_token_usage 为会话累计值，多流交错无稳定 stream id）
 *   → codex-usage-delta 状态机恢复增量（每事件一条增量记录）；模型从 turn_context/session_meta 或 payload.model 提取
 * - 兼容旧格式（event_msg/token_count，同一累计语义走同一状态机）
 * 只读（CON-R002）。
 */
import { readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import type { PlatformSource, UsageRecord } from '../types';
import { canonicalUsage, consumeUsageDelta, createUsageDeltaState, type CanonicalUsage } from '../codex-usage-delta';
import { num, safeJson } from './shared';

/** 事件对象 → token_count 的 info（新版 payload.info / 旧版 payload.msg.info；非 token_count → null） */
function tokenCountInfo(obj: Record<string, unknown>): { total: unknown; last: unknown } | null {
  const payload = obj.payload;
  if (!payload || typeof payload !== 'object') return null;
  const p = payload as Record<string, unknown>;
  let info: Record<string, unknown> | null = null;
  if (p.type === 'token_count') {
    info = p.info && typeof p.info === 'object' ? (p.info as Record<string, unknown>) : p;
  } else {
    const msg = p.msg;
    if (msg && typeof msg === 'object' && (msg as Record<string, unknown>).type === 'token_count') {
      const mInfo = (msg as Record<string, unknown>).info;
      info = mInfo && typeof mInfo === 'object' ? (mInfo as Record<string, unknown>) : null;
    }
  }
  if (!info) return null;
  const total = info.total_token_usage ?? info;
  if (!canonicalUsage(total)) return null;
  return { total, last: info.last_token_usage ?? null };
}

/** 增量 → UsageRecord；codex input_tokens 含 cached 子集 → 拆出纯 input（与 claude 语义一致，避免重复计费） */
function deltaToRecord(j: Record<string, unknown>, delta: CanonicalUsage, model: string, fallbackTs: string): UsageRecord | null {
  const inputTokens = num(delta.input_tokens - delta.cached_input_tokens);
  const outputTokens = num(delta.output_tokens);
  const cacheReadTokens = num(delta.cached_input_tokens);
  const cacheWriteTokens = num(delta.cache_creation_input_tokens);
  const reasoningTokens = num(delta.reasoning_output_tokens);
  if (inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens + reasoningTokens === 0) return null;
  return {
    ts: typeof j.timestamp === 'string' ? j.timestamp : fallbackTs,
    platform: 'codex',
    model,
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    reasoningTokens,
  };
}

/**
 * 整文件解析：逐行读 token_count 事件，累计值经 delta 状态机转增量，每事件一条增量记录（重复快照幂等去重）。
 */
export function parseCodexFile(text: string, fallbackTs: string): UsageRecord[] {
  const state = createUsageDeltaState();
  const records: UsageRecord[] = [];
  let model = 'unknown';
  for (const line of text.split('\n')) {
    if (!line) continue;
    const j = safeJson(line);
    if (!j) continue;
    const payload = j.payload;
    if (!payload || typeof payload !== 'object') continue;
    const p = payload as Record<string, unknown>;
    if ((j.type === 'turn_context' || j.type === 'session_meta') && typeof p.model === 'string') model = p.model;
    const tc = tokenCountInfo(j);
    if (!tc) continue;
    if (typeof p.model === 'string') model = p.model;
    const delta = consumeUsageDelta(state, tc.last, tc.total);
    if (!delta) continue;
    const rec = deltaToRecord(j, delta, model, fallbackTs);
    if (rec) records.push(rec);
  }
  return records;
}

function listFilesRecursive(dir: string, ext: string, out: string[]): void {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return; // 子目录 EPERM/ENOENT → 跳过不中断
  }
  for (const entry of entries) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) listFilesRecursive(p, ext, out);
    else if (entry.name.endsWith(ext)) out.push(p);
  }
}

export function createCodexSource(home = homedir()): PlatformSource {
  const sessionsDir = process.env.CODEX_HOME ? join(process.env.CODEX_HOME, 'sessions') : join(home, '.codex', 'sessions');
  return {
    platform: 'codex',
    home: sessionsDir,
    listFiles: () => {
      const out: string[] = [];
      listFilesRecursive(sessionsDir, '.jsonl', out);
      return out;
    },
    parseFile: (text, fallbackTs) => parseCodexFile(text, fallbackTs),
  };
}
