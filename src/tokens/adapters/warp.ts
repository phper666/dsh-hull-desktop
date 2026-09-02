/**
 * Warp Terminal SQLite 适配器（T2）：
 * - db：~/.warp/remote-server/codebase-indexes/index.sqlite
 * - ConversationUsageMetadata.token_usage：按模型数组（ModelTokenUsage）JSON 字段
 * - 防御式：遍历表找含 token_usage/token 列的表，逐行解析 JSON 数组 → 每模型一条记录
 * - ts 缺省用文件 mtime（fallbackTs）；表/列缺失 → []
 */
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import type { PlatformSource, UsageRecord } from '../types';
import { safeJson, toRecord } from './shared';
import { querySqlite } from './sqlite';

export function warpDbPath(home: string): string {
  return join(home, '.warp', 'remote-server', 'codebase-indexes', 'index.sqlite');
}

/** 驼峰/蛇形 token 字段归一化 → toRecord 认得的蛇形键 */
const TOKEN_KEY_MAP: Record<string, string> = {
  input_tokens: 'input_tokens', inputTokens: 'input_tokens', prompt_tokens: 'input_tokens', promptTokens: 'input_tokens',
  output_tokens: 'output_tokens', outputTokens: 'output_tokens', generated_tokens: 'output_tokens', generatedTokens: 'output_tokens', completion_tokens: 'output_tokens',
  cache_read_input_tokens: 'cache_read_input_tokens', cacheReadInputTokens: 'cache_read_input_tokens', cached_input_tokens: 'cache_read_input_tokens', cachedInputTokens: 'cache_read_input_tokens', cache_read_tokens: 'cache_read_tokens', cacheReadTokens: 'cache_read_tokens',
  cache_creation_input_tokens: 'cache_creation_input_tokens', cacheCreationInputTokens: 'cache_creation_input_tokens', cache_write_tokens: 'cache_write_tokens', cacheWriteTokens: 'cache_write_tokens',
  reasoning_tokens: 'reasoning_tokens', reasoningTokens: 'reasoning_tokens', reasoning_output_tokens: 'reasoning_tokens',
};

function pickTokens(obj: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    const t = TOKEN_KEY_MAP[k];
    if (t && v != null) out[t] = v;
  }
  return out;
}

function rowTs(v: unknown, fallbackTs: string): string {
  if (v == null) return fallbackTs;
  const d = new Date(typeof v === 'number' ? v : String(v));
  return Number.isNaN(d.getTime()) ? fallbackTs : d.toISOString();
}

/** 行内 token_usage JSON（数组、单对象、或 {token_usage: [...]} 包裹）→ 每模型一条记录 */
function warpRowToRecords(row: Record<string, unknown>, tokenCol: string, fallbackTs: string): UsageRecord[] {
  const raw = row[tokenCol];
  if (raw == null) return [];
  const j = safeJson(String(raw));
  if (!j) return [];
  let arr: unknown[] = Array.isArray(j) ? j : [];
  if (arr.length === 0 && j.token_usage !== undefined) {
    arr = Array.isArray(j.token_usage) ? j.token_usage : [j.token_usage];
  }
  if (arr.length === 0) arr = [j];
  const ts = rowTs(row.timestamp ?? row.created_at, fallbackTs);
  const out: UsageRecord[] = [];
  for (const item of arr) {
    if (!item || typeof item !== 'object') continue;
    const u = item as Record<string, unknown>;
    const model = (typeof u.model === 'string' && u.model) || (typeof row.model === 'string' ? row.model : 'unknown');
    const rec = toRecord({ ts, platform: 'warp', model }, pickTokens(u));
    if (rec) out.push(rec);
  }
  return out;
}

function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

/** 查询 db：找含 token 列的表，解析 token_usage JSON → UsageRecord[] */
export function parseWarpSource(dbPath: string, fallbackTs = new Date(0).toISOString()): UsageRecord[] {
  const tables = querySqlite(dbPath, "SELECT name FROM sqlite_master WHERE type='table'");
  if (!tables) return [];
  const out: UsageRecord[] = [];
  for (const t of tables) {
    const name = String(t.name ?? '');
    if (!name) continue;
    const cols = querySqlite(dbPath, `PRAGMA table_info(${quoteIdent(name)})`);
    if (!cols) continue;
    const tokenCol = cols.map((c) => String(c.name ?? '')).find((n) => /token_usage|token|usage/i.test(n));
    if (!tokenCol) continue;
    const rows = querySqlite(dbPath, `SELECT * FROM ${quoteIdent(name)}`);
    if (!rows) continue;
    for (const row of rows) out.push(...warpRowToRecords(row, tokenCol, fallbackTs));
  }
  return out;
}

/** 平台源：listFiles 返回存在的 db；parseFile 内 querySqlite */
export function createWarpSource(home = homedir()): PlatformSource {
  const dbPath = warpDbPath(home);
  return {
    platform: 'warp',
    home: join(home, '.warp', 'remote-server', 'codebase-indexes'),
    listFiles: () => (existsSync(dbPath) ? [dbPath] : []),
    parseFile: (_text, fallbackTs) => parseWarpSource(dbPath, fallbackTs),
  };
}
