/**
 * 平台适配器扫描器（多平台 token 用量采集）：
 * - claude-code：~/.claude/projects 下全部 .jsonl（assistant 行 message.usage，格式公开稳定）
 * - codex：~/.codex/sessions 下全部 .jsonl（防御式提取 usage 形态对象）
 * - dsh：~/.dsh/sessions 下全部 session.jsonl.zstd（zstd JSONL；会话头 createdAt 兜底时间戳）
 * 原则：只读（CON-R002 红线：绝不写 DSH_HOME）；单文件失败隔离；逐行流式（大文件友好）。
 * 可测性：行解析为导出的纯函数（parseClaudeLine/parseCodexLine/parseDshLine），文件遍历薄封装。
 */
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import * as nodeZlib from 'node:zlib';

import type { TokenPlatform, UsageRecord } from './types';
import type { ScanSourceInfo } from './aggregator';

/** zstd 解压（Node ≥22.15/23.8 内置；不可用 → dsh 源抛错由调用方隔离） */
function zstdDecompress(buf: Buffer): string {
  const zstd = (nodeZlib as unknown as { zstdDecompressSync?: (b: Buffer) => Buffer }).zstdDecompressSync;
  if (typeof zstd !== 'function') throw new Error('当前 Node 无内置 zstd 解压能力');
  return zstd(buf).toString('utf8');
}

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.floor(v) : 0;
}

function safeJson(line: string): Record<string, unknown> | null {
  try {
    const j = JSON.parse(line);
    return typeof j === 'object' && j !== null ? (j as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** 深度 ≤4 找「usage 形态」对象（input/output 数值字段齐备）——codex/dsh 等内部格式防御式提取 */
function findUsageShape(obj: unknown, depth = 0): Record<string, unknown> | null {
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

function toRecord(partial: Omit<UsageRecord, 'inputTokens' | 'outputTokens' | 'cacheReadTokens' | 'cacheWriteTokens'>, usage: Record<string, unknown>): UsageRecord | null {
  const inputTokens = num(usage.input_tokens);
  const outputTokens = num(usage.output_tokens);
  const cacheReadTokens = num(usage.cache_read_input_tokens) + num(usage.cached_input_tokens) + num(usage.cache_read_tokens);
  const cacheWriteTokens = num(usage.cache_creation_input_tokens) + num(usage.cache_write_tokens);
  if (inputTokens === 0 && outputTokens === 0 && cacheReadTokens === 0 && cacheWriteTokens === 0) return null;
  return { ...partial, inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens };
}

/** claude-code 行：type=assistant 且 message.usage 存在（官方 transcripts 结构） */
export function parseClaudeLine(line: string, fallbackTs: string): UsageRecord | null {
  const j = safeJson(line);
  if (!j || j.type !== 'assistant') return null;
  const msg = j.message as Record<string, unknown> | undefined;
  const usage = msg?.usage as Record<string, unknown> | undefined;
  if (!usage || typeof usage !== 'object') return null;
  const rec = toRecord(
    { ts: typeof j.timestamp === 'string' ? j.timestamp : fallbackTs, platform: 'claude-code', model: (msg?.model as string) || 'unknown' },
    usage
  );
  return rec;
}

/** codex 行：防御式深找 usage 形态（格式内部，宽容变化） */
export function parseCodexLine(line: string, fallbackTs: string): UsageRecord | null {
  const j = safeJson(line);
  if (!j) return null;
  const usage = findUsageShape(j);
  if (!usage) return null;
  const model = (j.model as string) || findString(j, 'model', 3) || 'unknown';
  return toRecord({ ts: typeof j.timestamp === 'string' ? j.timestamp : fallbackTs, platform: 'codex', model }, usage);
}

/** dsh 行（zstd 解压后）：优先 message.usage（dsh 会话结构与 CC 同源），退化防御式深找；时间戳缺省用会话头 createdAt */
export function parseDshLine(line: string, fallbackTs: string): UsageRecord | null {
  const j = safeJson(line);
  if (!j) return null;
  if (j.type === 'session') return null; // 会话头无用量
  const msg = j.message as Record<string, unknown> | undefined;
  let usage: Record<string, unknown> | undefined = (msg?.usage as Record<string, unknown> | undefined) || (j.usage as Record<string, unknown> | undefined) || undefined;
  if (!usage) usage = findUsageShape(j) ?? undefined;
  if (!usage) return null;
  const model = ((msg?.model as string) || findString(j, 'model', 3)) || 'unknown';
  return toRecord({ ts: typeof j.timestamp === 'string' ? j.timestamp : fallbackTs, platform: 'dsh', model }, usage);
}

function findString(obj: unknown, key: string, depth: number): string | null {
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

// ── 文件遍历 ──

const HOME = homedir();

export interface PlatformSource {
  platform: TokenPlatform;
  home: string;
  /** 返回目录下全部目标文件（绝对路径） */
  listFiles: () => string[];
  /** 逐行解析（默认路径） */
  parseLine?: (line: string, fallbackTs: string) => UsageRecord | null;
  /** 整文件解析（累计值/特殊语义平台，如 codex）——设置后 parseLine 不生效 */
  parseFile?: (text: string, fallbackTs: string) => UsageRecord[];
  /** dsh 需解压（zstd）；返回解压后文本，失败抛错由调用方隔离 */
  readFile?: (path: string) => string;
}

function listFilesRecursive(dir: string, ext: string, out: string[]): void {
  if (!existsSync(dir)) return;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) listFilesRecursive(p, ext, out);
    else if (entry.name.endsWith(ext)) out.push(p);
  }
}

/** 平台源注册表（home 可注入便于测试） */
export function platformSources(home = HOME): PlatformSource[] {
  const claudeHome = process.env.CLAUDE_CONFIG_DIR ? join(process.env.CLAUDE_CONFIG_DIR, 'projects') : join(home, '.claude', 'projects');
  const codexHome = process.env.CODEX_HOME ? join(process.env.CODEX_HOME, 'sessions') : join(home, '.codex', 'sessions');
  const dshHome = process.env.DSH_HOME ? join(process.env.DSH_HOME, 'sessions') : join(home, '.dsh', 'sessions');
  return [
    {
      platform: 'claude-code',
      home: claudeHome,
      listFiles: () => {
        const out: string[] = [];
        listFilesRecursive(claudeHome, '.jsonl', out);
        return out;
      },
      parseLine: parseClaudeLine,
    },
    {
      platform: 'codex',
      home: codexHome,
      listFiles: () => {
        const out: string[] = [];
        listFilesRecursive(codexHome, '.jsonl', out);
        return out;
      },
      // 准确性关键：codex 的 token_count 事件是「会话累计值」而非增量——逐行累加会重复计数。
      // 语义：每个会话文件取时间序最后一条 total_token_usage 作为该会话总量（单记录）
      parseFile: (text, fallbackTs) => {
        const records: UsageRecord[] = [];
        let last: UsageRecord | null = null;
        let lastTs = '';
        for (const line of text.split('\n')) {
          if (!line) continue;
          const rec = parseCodexLine(line, fallbackTs);
          if (!rec) continue;
          if (!last || (rec.ts && rec.ts >= lastTs)) {
            last = rec;
            lastTs = rec.ts;
          }
        }
        if (last) records.push(last);
        return records;
      },
    },
    {
      platform: 'dsh',
      home: dshHome,
      listFiles: () => {
        const out: string[] = [];
        listFilesRecursive(dshHome, '.jsonl.zstd', out);
        return out;
      },
      parseLine: parseDshLine,
      readFile: (path) => zstdDecompress(readFileSync(path)),
    },
  ];
}

/** mtime 兜底时间戳（无 timestamp 字段的行） */
function fileFallbackTs(path: string): string {
  try {
    return statSync(path).mtime.toISOString();
  } catch {
    return new Date(0).toISOString();
  }
}

/** 扫描全部平台 → 记录 + 各源概况（单源失败隔离） */
export function scanAllSources(sources: PlatformSource[] = platformSources()): { records: UsageRecord[]; sources: ScanSourceInfo[] } {
  const records: UsageRecord[] = [];
  const infos: ScanSourceInfo[] = [];
  const seen = new Set<string>(); // 准确性：跨文件去重（claude 同一 assistant 消息可能在多文件重复出现）
  for (const src of sources) {
    const info: ScanSourceInfo = { platform: src.platform, home: src.home, files: 0, records: 0 };
    try {
      const files = src.listFiles();
      info.files = files.length;
      for (const file of files) {
        try {
          const text = src.readFile ? src.readFile(file) : readFileSync(file, 'utf8');
          const fallbackTs = fileFallbackTs(file);
          if (src.parseFile) {
            records.push(...src.parseFile(text, fallbackTs));
            continue;
          }
          for (const line of text.split('\n')) {
            if (!line) continue;
            const rec = src.parseLine?.(line, fallbackTs);
            if (!rec) continue;
            // 去重键：claude 用 message.id+requestId（同一 API 响应在主会话/子代理文件重复出现只计一次）
            const j = safeJson(line);
            const msgId = (j?.message as Record<string, unknown> | undefined)?.id;
            const dedupeKey = `${src.platform}:${(msgId as string) || fileFingerprint(file)}:${(j?.requestId as string) || ''}:${rec.ts}`;
            if (src.platform === 'claude-code') {
              if (seen.has(dedupeKey)) continue;
              seen.add(dedupeKey);
            }
            records.push(rec);
          }
        } catch {
          // 单文件失败隔离（损坏/解压失败）→ 跳过
        }
      }
      info.records = records.filter((r) => r.platform === src.platform).length;
    } catch (err) {
      info.error = (err as Error).message;
    }
    infos.push(info);
  }
  return { records, sources: infos };
}

/** 文件指纹（调试/未来缓存增量用） */
/** 路线图平台（格式待逐一验证后实现适配器；TokenTracker 已覆盖 34 工具可参考） */
export const ROADMAP_PLATFORMS = ['Gemini CLI', 'OpenCode', 'Cursor', 'Zed', 'GitHub Copilot', 'Qoder', 'Goose', 'ZCode', 'Kiro'];

export function fileFingerprint(path: string): string {
  try {
    const s = statSync(path);
    return createHash('sha1').update(`${path}:${s.size}:${s.mtimeMs}`).digest('hex').slice(0, 16);
  } catch {
    return '';
  }
}
