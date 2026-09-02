/**
 * Kiro（VS Code fork）适配器（T2，SQLite + JSONL 混合）：
 * - 根：~/.kiro/**（防御式递归找 *.db / *.jsonl 含 token 数据）
 * - SQLite：devdata.sqlite 表 tokens_generated（id/model/provider/tokens_prompt/tokens_generated/timestamp）
 * - JSONL 兜底：tokens_generated.jsonl 每行 {"model","provider","promptTokens","generatedTokens"}（无时间戳 → fallbackTs）
 * - 多文件类型 → readFile：db 返回路径标记、jsonl 返回原文；parseFile 按标记分派
 * - 防御式：表/列缺失 → []；ts 缺省用文件 mtime（fallbackTs）
 */
import { readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import type { PlatformSource, UsageRecord } from '../types';
import { num, safeJson } from './shared';
import { hasTable, querySqlite } from './sqlite';

/** db 文件 readFile 标记前缀（SQLite 二进制不经 utf8 读取，路径透传） */
const DB_MARKER = '\u0000kiro-db:';

function rowTs(v: unknown, fallbackTs: string): string {
  if (v == null) return fallbackTs;
  const d = new Date(typeof v === 'number' ? v : String(v));
  return Number.isNaN(d.getTime()) ? fallbackTs : d.toISOString();
}

function listKiroFiles(dir: string, out: string[] = []): string[] {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out; // 子目录 EPERM/ENOENT → 跳过不中断
  }
  for (const entry of entries) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) listKiroFiles(p, out);
    else if (entry.name.endsWith('.db') || entry.name.endsWith('.sqlite') || entry.name.endsWith('.jsonl')) out.push(p);
  }
  return out;
}

/** 查询 tokens_generated 表 → UsageRecord[] */
export function parseKiroSource(dbPath: string, fallbackTs = new Date(0).toISOString()): UsageRecord[] {
  if (!hasTable(dbPath, 'tokens_generated')) return [];
  const rows = querySqlite(dbPath, 'SELECT * FROM tokens_generated');
  if (!rows) return [];
  const out: UsageRecord[] = [];
  for (const row of rows) {
    const inputTokens = num(row.tokens_prompt ?? row.promptTokens);
    const outputTokens = num(row.tokens_generated ?? row.generatedTokens);
    if (inputTokens === 0 && outputTokens === 0) continue;
    out.push({
      ts: rowTs(row.timestamp ?? row.created_at, fallbackTs),
      platform: 'kiro',
      model: typeof row.model === 'string' && row.model ? row.model : 'unknown',
      inputTokens,
      outputTokens,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      reasoningTokens: 0,
    });
  }
  return out;
}

/** JSONL 单行：{model, provider, promptTokens, generatedTokens} → 记录（无时间戳 → fallbackTs） */
export function parseKiroJsonlLine(line: string, fallbackTs: string): UsageRecord | null {
  const j = safeJson(line);
  if (!j) return null;
  const inputTokens = num(j.promptTokens ?? j.prompt_tokens);
  const outputTokens = num(j.generatedTokens ?? j.output_tokens ?? j.completion_tokens);
  if (inputTokens === 0 && outputTokens === 0) return null;
  return {
    ts: fallbackTs,
    platform: 'kiro',
    model: typeof j.model === 'string' && j.model ? j.model : 'unknown',
    inputTokens,
    outputTokens,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
  };
}

/** JSONL 全文 → UsageRecord[] */
export function parseKiroSourceText(text: string, fallbackTs: string): UsageRecord[] {
  const out: UsageRecord[] = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    const rec = parseKiroJsonlLine(line, fallbackTs);
    if (rec) out.push(rec);
  }
  return out;
}

/** 平台源：listFiles 递归找 *.db + *.jsonl；readFile 按类型标记/原文；parseFile 分派 */
export function createKiroSource(home: string = homedir()): PlatformSource {
  const kiroRoot = join(home, '.kiro');
  return {
    platform: 'kiro',
    home: kiroRoot,
    listFiles: () => listKiroFiles(kiroRoot),
    readFile: (path) => (path.endsWith('.db') || path.endsWith('.sqlite') ? `${DB_MARKER}${path}` : readFileSync(path, 'utf8')),
    parseFile: (text, fallbackTs) => {
      if (text.startsWith(DB_MARKER)) return parseKiroSource(text.slice(DB_MARKER.length), fallbackTs);
      return parseKiroSourceText(text, fallbackTs);
    },
  };
}
