/**
 * ZCode（OpenCode-fork CLI）SQLite 适配器（T2）：
 * - db：~/.zcode/cli/db/db.sqlite（sessions/messages 表，token 列）
 * - 防御式：遍历表找含 token 列的表，逐行归一化（snake/camel 双命名）
 * - 无 token 行 → 跳过；表/列缺失 → []；ts 缺省用文件 mtime（fallbackTs）
 */
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import type { PlatformSource, UsageRecord } from '../types';
import { toRecord } from './shared';
import { querySqlite } from './sqlite';

export function zcodeDbPath(home: string): string {
  return join(home, '.zcode', 'cli', 'db', 'db.sqlite');
}

/** 驼峰/蛇形 token 字段归一化 → toRecord 认得的蛇形键 */
const TOKEN_KEY_MAP: Record<string, string> = {
  input_tokens: 'input_tokens', inputTokens: 'input_tokens', tokens_in: 'input_tokens', tokensIn: 'input_tokens',
  output_tokens: 'output_tokens', outputTokens: 'output_tokens', tokens_out: 'output_tokens', tokensOut: 'output_tokens',
  cache_read_input_tokens: 'cache_read_input_tokens', cacheReadInputTokens: 'cache_read_input_tokens', cached_input_tokens: 'cache_read_input_tokens', cache_read_tokens: 'cache_read_tokens', cacheReadTokens: 'cache_read_tokens',
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

function zcodeRowToRecord(row: Record<string, unknown>, fallbackTs: string): UsageRecord | null {
  const usage = pickTokens(row);
  const model =
    (typeof row.model === 'string' && row.model) ||
    (typeof row.model_id === 'string' && row.model_id) ||
    (typeof row.modelID === 'string' ? row.modelID : 'unknown');
  const ts = rowTs(row.created_at ?? row.timestamp ?? row.createdAt, fallbackTs);
  return toRecord({ ts, platform: 'zcode', model }, usage);
}

function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

/** 所需列白名单：token 归一化键 + model/ts 键（不拉内容列/正文） */
const NEEDED_COLS = new Set<string>([
  ...Object.keys(TOKEN_KEY_MAP),
  'model', 'model_id', 'modelID',
  'created_at', 'timestamp', 'createdAt',
]);

/** 查询 db：遍历表找含 token 列的表 → 只 SELECT 所需列 → UsageRecord[] */
export function parseZcodeSource(dbPath: string, fallbackTs = new Date(0).toISOString()): UsageRecord[] {
  const tables = querySqlite(dbPath, "SELECT name FROM sqlite_master WHERE type='table'");
  if (!tables) return [];
  const out: UsageRecord[] = [];
  for (const t of tables) {
    const name = String(t.name ?? '');
    if (!name) continue;
    const cols = querySqlite(dbPath, `PRAGMA table_info(${quoteIdent(name)})`);
    if (!cols) continue;
    const selCols = cols.map((c) => String(c.name ?? '')).filter((c) => NEEDED_COLS.has(c));
    if (!selCols.some((c) => /token/i.test(c))) continue;
    const rows = querySqlite(dbPath, `SELECT ${selCols.map(quoteIdent).join(', ')} FROM ${quoteIdent(name)}`);
    if (!rows) continue;
    for (const row of rows) {
      const rec = zcodeRowToRecord(row, fallbackTs);
      if (rec) out.push(rec);
    }
  }
  return out;
}

/** 平台源：listFiles 返回存在的 db；parseFile 内 querySqlite */
export function createZcodeSource(home = homedir()): PlatformSource {
  const dbPath = zcodeDbPath(home);
  return {
    platform: 'zcode',
    home: join(home, '.zcode', 'cli', 'db'),
    listFiles: () => (existsSync(dbPath) ? [dbPath] : []),
    parseFile: (_text, fallbackTs) => parseZcodeSource(dbPath, fallbackTs),
  };
}
