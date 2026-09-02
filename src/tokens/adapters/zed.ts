/**
 * Zed Agent SQLite 适配器（T2）：
 * - db：~/Library/Application Support/Zed/ 下 SQLite（递归找 *.db，主表 threads）
 * - 表 threads：cumulative_token_usage（JSON 含 input_tokens/output_tokens 等）或拆列；模型 model 列
 * - 多 db 文件 → readFile 返回路径标记，parseFile 按标记逐文件查询（避免重复计数）
 * - 防御式：无 token 列/行 → 跳过；ts 缺省用文件 mtime（fallbackTs）
 */
import { readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import type { PlatformSource, UsageRecord } from '../types';
import { num, safeJson, toRecord } from './shared';
import { hasTable, querySqlite } from './sqlite';

/** readFile 标记前缀（SQLite 二进制不经 utf8 读取，路径透传） */
const DB_MARKER = '\u0000sqlite:';

export function zedHome(home = homedir()): string {
  return join(home, 'Library', 'Application Support', 'Zed');
}

function listDbFiles(dir: string, out: string[] = []): string[] {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out; // 子目录 EPERM/ENOENT → 跳过不中断
  }
  for (const entry of entries) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) listDbFiles(p, out);
    else if (entry.name.endsWith('.db')) out.push(p);
  }
  return out;
}

/** 线程行 → 记录：cumulative_token_usage JSON 并入拆列；toRecord 归一化 */
function zedRowToRecord(row: Record<string, unknown>, fallbackTs: string): UsageRecord | null {
  const usage: Record<string, unknown> = {};
  if (row.cumulative_token_usage != null) {
    const j = safeJson(String(row.cumulative_token_usage));
    if (j && typeof j === 'object') Object.assign(usage, j);
  }
  for (const k of ['input_tokens', 'output_tokens', 'cache_read_tokens', 'cache_write_tokens', 'reasoning_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens'] as const) {
    if (row[k] != null) usage[k] = row[k];
  }
  const model =
    (typeof row.model === 'string' && row.model) ||
    (typeof usage.model === 'string' ? usage.model : 'unknown');
  const ts =
    (typeof row.updated_at === 'string' && row.updated_at) ||
    (typeof row.created_at === 'string' && row.created_at) ||
    fallbackTs;
  return toRecord({ ts, platform: 'zed', model }, usage);
}

/** 查询单 db 的 threads 表 → UsageRecord[] */
export function parseZedSource(dbPath: string, fallbackTs = new Date(0).toISOString()): UsageRecord[] {
  if (!hasTable(dbPath, 'threads')) return [];
  const rows = querySqlite(dbPath, 'SELECT * FROM threads');
  if (!rows) return [];
  const out: UsageRecord[] = [];
  for (const row of rows) {
    const rec = zedRowToRecord(row, fallbackTs);
    if (rec) out.push(rec);
  }
  return out;
}

/** 平台源：listFiles 递归找 *.db；readFile 透传 db 路径；parseFile 按标记逐文件查询 */
export function createZedSource(home: string = homedir()): PlatformSource {
  const dir = zedHome(home);
  return {
    platform: 'zed',
    home: dir,
    listFiles: () => listDbFiles(dir),
    readFile: (path) => `${DB_MARKER}${path}`,
    parseFile: (text, fallbackTs) => {
      if (!text.startsWith(DB_MARKER)) return [];
      return parseZedSource(text.slice(DB_MARKER.length), fallbackTs);
    },
  };
}
