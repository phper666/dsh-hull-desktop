/**
 * dsh adapter（~/.dsh/sessions 递归 *.jsonl.zstd，支持 DSH_HOME env）：
 * - readFile：多帧 zstd 解压——dsh 会话文件是拼接帧容器（单次 zstdDecompressSync 只解第一帧，其余事件静默丢失）
 * - 行形态：{type, seq, time(epoch ms), data}；usage 两载体——
 *   ① assistant/chunk 事件 data.chunk.type==='usage' 的 data.chunk.usage（camelCase，实测形态）
 *   ② assistant/message 事件 data.usage（camelCase 实测；snake_case 兜底）
 *   ③ 既有路径（顶层 message.usage / findUsageShape snake_case）保留
 * - 口径 DISJOINT（同 TokenTracker）：inputTokens=纯未缓存 input，cache read/write、reasoning 分列直接映射（不拆分）
 * - 整文件解析（parseDshFile）：request/header 维护 lastModel（chunk 行无模型 → fallback）；
 *   同请求（turn:step）的流式 usage 快照（多 chunk + message 终值重复）→ 每请求取最后一次非零值（防快照重复计数）
 * 只读（CON-R002 红线：绝不写 DSH_HOME）。
 */
import { readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import * as nodeZlib from 'node:zlib';

import type { PlatformSource, UsageRecord } from '../types';
import { findString, findUsageShape, num, safeJson, toRecord } from './shared';

const ZSTD_MAGIC_LE = 0xfd2fb528;

/**
 * 多帧 zstd 解压：逐帧定位（当前帧后找下一帧 magic），每次 zstdDecompressSync(rest) 只解出 rest 的第一帧。
 * 单帧文件（无更多 magic）同样正常。
 */
function zstdDecompressMultiFrame(buf: Buffer): string {
  const zstd = (nodeZlib as unknown as { zstdDecompressSync?: (b: Buffer) => Buffer }).zstdDecompressSync;
  if (typeof zstd !== 'function') throw new Error('当前 Node 无内置 zstd 解压能力');
  if (buf.length < 4 || buf.readUInt32LE(0) !== ZSTD_MAGIC_LE) throw new Error('非 zstd 文件（缺 magic）');
  let rest = buf;
  const parts: string[] = [];
  while (rest.length > 4 && rest.readUInt32LE(0) === ZSTD_MAGIC_LE) {
    parts.push(zstd(rest).toString('utf8'));
    const next = rest.indexOf(Buffer.from([0x28, 0xb5, 0x2f, 0xfd]), 4);
    if (next === -1) break;
    rest = rest.subarray(next);
  }
  return parts.join('\n');
}

/** epoch ms 数字 / ISO 字符串 → ISO；缺省/非法 → null（调用方跳过该行，禁止 mtime 兜底） */
function epochMsToIso(v: unknown): string | null {
  if (v == null) return null;
  const d = new Date(typeof v === 'number' ? v : String(v));
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/** usage 归一化（camelCase 实测形态 + snake_case 兜底）→ toRecord 认得的蛇形键；DISJOINT 直接映射不拆分 */
function normalizeUsage(u: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const input = u.inputTokens ?? u.input_tokens;
  const output = u.outputTokens ?? u.output_tokens;
  const reasoning = u.reasoningTokens ?? u.reasoning_tokens;
  const cacheRead = u.cacheReadTokens ?? u.cacheReadInputTokens ?? u.cache_read_tokens ?? u.cache_read_input_tokens;
  const cacheWrite = u.cacheWriteTokens ?? u.cacheWriteInputTokens ?? u.cache_write_tokens ?? u.cache_write_input_tokens;
  if (input != null) out.input_tokens = input;
  if (output != null) out.output_tokens = output;
  if (reasoning != null) out.reasoning_tokens = reasoning;
  if (cacheRead != null) out.cache_read_tokens = cacheRead;
  if (cacheWrite != null) out.cache_write_tokens = cacheWrite;
  return out;
}

function usageNonzero(u: Record<string, unknown>): boolean {
  return num(u.input_tokens) + num(u.output_tokens) + num(u.reasoning_tokens) + num(u.cache_read_tokens) + num(u.cache_write_tokens) > 0;
}

/** 事件行 → {usage(蛇形), model(行内模型或 null)}；无 usage / 全零 → null */
function extractDshEvent(j: Record<string, unknown>): { usage: Record<string, unknown>; model: string | null } | null {
  const data = (j.data && typeof j.data === 'object' ? j.data : undefined) as Record<string, unknown> | undefined;
  // ① assistant/chunk：data.chunk.type==='usage' → data.chunk.usage（camelCase 实测）
  if (j.type === 'assistant/chunk') {
    const chunk = data?.chunk as Record<string, unknown> | undefined;
    if (chunk && chunk.type === 'usage' && chunk.usage && typeof chunk.usage === 'object') {
      const usage = normalizeUsage(chunk.usage as Record<string, unknown>);
      return usageNonzero(usage) ? { usage, model: null } : null; // chunk 行无模型 → parseDshFile 用 lastModel
    }
    return null;
  }
  // ② assistant/message：data.usage（camelCase 实测 / snake_case 兜底）；模型 data.message.source.model
  if (j.type === 'assistant/message') {
    const u = data?.usage;
    if (u && typeof u === 'object') {
      const usage = normalizeUsage(u as Record<string, unknown>);
      if (!usageNonzero(usage)) return null;
      const msg = data?.message as Record<string, unknown> | undefined;
      const src = msg?.source as Record<string, unknown> | undefined;
      return { usage, model: (typeof src?.model === 'string' && src.model) || null };
    }
    // 无 data.usage → 走既有兜底
  }
  // ③ 既有路径（CC 同源 message.usage / findUsageShape snake_case）
  const msg = j.message as Record<string, unknown> | undefined;
  const legacy = (msg?.usage as Record<string, unknown> | undefined) || (j.usage as Record<string, unknown> | undefined) || findUsageShape(j) || undefined;
  if (!legacy) return null;
  const usage = normalizeUsage(legacy);
  if (!usageNonzero(usage)) return null;
  return { usage, model: (typeof msg?.model === 'string' && msg.model) || findString(j, 'model', 3) || null };
}

/** 行时间戳：j.time（epoch ms）?? j.timestamp（ISO）→ ISO；非法 → null */
function lineTs(j: Record<string, unknown>): string | null {
  return epochMsToIso(j.time ?? j.timestamp);
}

/**
 * dsh 行解析（无状态单行，保持既有签名）：两形态 usage 载体 + 既有 message.usage 兜底。
 * 模型只取行内（无跨行 fallback）；时间 j.time ?? j.timestamp，缺省用 fallbackTs。
 */
export function parseDshLine(line: string, fallbackTs: string): UsageRecord | null {
  const j = safeJson(line);
  if (!j) return null;
  if (j.type === 'session') return null; // 会话头无用量
  const ev = extractDshEvent(j);
  if (!ev) return null;
  const ts = lineTs(j) ?? (typeof j.timestamp === 'string' ? j.timestamp : fallbackTs);
  return toRecord({ ts, platform: 'dsh', model: ev.model || 'unknown' }, ev.usage);
}

/**
 * dsh 整文件解析（多帧解压后文本）：
 * - request/header 行维护 lastModel（data.header.config.model）——chunk 行无模型时 fallback（TokenTracker 同语义）
 * - 同请求（data.turn:data.step）的流式 usage 快照：多 chunk（中间值+尾部零值）+ message 终值重复
 *   → 每请求只取最后一次非零 usage（防快照重复计数）；无 turn/step 的行各自成记录
 * - 无行级时间戳的 usage 行跳过（mtime 兜底会污染时间分布，宁缺勿错）
 */
export function parseDshFile(text: string): UsageRecord[] {
  let lastModel: string | null = null;
  const pending = new Map<string, { ts: string; usage: Record<string, unknown>; model: string }>();
  const out: UsageRecord[] = [];
  for (const line of text.split('\n')) {
    if (!line) continue;
    const j = safeJson(line);
    if (!j) continue;
    if (j.type === 'request/header') {
      const header = (j.data as Record<string, unknown> | undefined)?.header as Record<string, unknown> | undefined;
      const config = header?.config as Record<string, unknown> | undefined;
      if (config && typeof config.model === 'string' && config.model) lastModel = config.model;
      continue;
    }
    const ev = extractDshEvent(j);
    if (!ev) continue;
    const ts = lineTs(j);
    if (!ts) continue; // 无行级真实时间戳 → 跳过
    const model = ev.model || lastModel || 'unknown';
    const data = (j.data && typeof j.data === 'object' ? j.data : undefined) as Record<string, unknown> | undefined;
    const key = data?.turn != null && data?.step != null ? `t${data.turn}:s${data.step}` : null;
    if (key) {
      pending.set(key, { ts, usage: ev.usage, model }); // 同请求快照去重：最后非零 wins
    } else {
      const rec = toRecord({ ts, platform: 'dsh', model }, ev.usage);
      if (rec) out.push(rec);
    }
  }
  for (const p of pending.values()) {
    const rec = toRecord({ ts: p.ts, platform: 'dsh', model: p.model }, p.usage);
    if (rec) out.push(rec);
  }
  return out;
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

export function createDshSource(home = homedir()): PlatformSource {
  const sessionsDir = process.env.DSH_HOME ? join(process.env.DSH_HOME, 'sessions') : join(home, '.dsh', 'sessions');
  return {
    platform: 'dsh',
    home: sessionsDir,
    listFiles: () => {
      const out: string[] = [];
      listFilesRecursive(sessionsDir, '.jsonl.zstd', out);
      return out;
    },
    readFile: (path) => zstdDecompressMultiFrame(readFileSync(path)),
    parseFile: (text) => parseDshFile(text),
  };
}
