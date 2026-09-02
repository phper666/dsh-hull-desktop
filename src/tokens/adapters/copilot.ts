/**
 * GitHub Copilot SQLite 适配器（T2）：
 * - db：~/.copilot/session-store.db
 * - 表 assistant_usage_events（per-request usage）：model/input_tokens/output_tokens/
 *   cache_read_tokens/cache_write_tokens/reasoning_tokens/created_at
 * - 防御式：表/列缺失 → []；ts 缺省用文件 mtime（fallbackTs）
 */
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import type { PlatformSource, UsageRecord } from '../types';
import { toRecord } from './shared';
import { hasTable, querySqlite } from './sqlite';

export function copilotDbPath(home: string): string {
  return join(home, '.copilot', 'session-store.db');
}

function rowTs(v: unknown, fallbackTs: string): string {
  if (v == null) return fallbackTs;
  const d = new Date(typeof v === 'number' ? v : String(v));
  return Number.isNaN(d.getTime()) ? fallbackTs : d.toISOString();
}

/** 查询 assistant_usage_events → UsageRecord[]（含缓存读/写/推理） */
export function parseCopilotSource(dbPath: string, fallbackTs = new Date(0).toISOString()): UsageRecord[] {
  if (!hasTable(dbPath, 'assistant_usage_events')) return [];
  const rows = querySqlite(dbPath, 'SELECT * FROM assistant_usage_events');
  if (!rows) return [];
  const out: UsageRecord[] = [];
  for (const row of rows) {
    const usage: Record<string, unknown> = {};
    for (const k of ['input_tokens', 'output_tokens', 'cache_read_tokens', 'cache_write_tokens', 'reasoning_tokens'] as const) {
      if (row[k] != null) usage[k] = row[k];
    }
    const rec = toRecord(
      {
        ts: rowTs(row.created_at, fallbackTs),
        platform: 'copilot',
        model: typeof row.model === 'string' && row.model ? row.model : 'unknown',
      },
      usage
    );
    if (rec) out.push(rec);
  }
  return out;
}

/** 平台源：listFiles 返回存在的 db；parseFile 内 querySqlite */
export function createCopilotSource(home = homedir()): PlatformSource {
  const dbPath = copilotDbPath(home);
  return {
    platform: 'copilot',
    home: join(home, '.copilot'),
    listFiles: () => (existsSync(dbPath) ? [dbPath] : []),
    parseFile: (_text, fallbackTs) => parseCopilotSource(dbPath, fallbackTs),
  };
}
