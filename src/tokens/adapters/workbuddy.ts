/**
 * WorkBuddy（腾讯）SQLite 适配器（总量级，T2 模式）：
 * - db：~/.workbuddy/workbuddy.db → session_usage 表（per-session）
 * - 列：session_id / used（会话总 token 消耗）/ size / updated_at（unix ms）/ credit_json（模型哈希，不可拆模型）
 * - 口径：used 全记输出侧（WorkBuddy 未提供输入/输出拆分，注释明示）；模型不可知 → 成本列「—」（aggregator 诚实不估算）
 * - 防御式：db/表/列缺失、查询失败 → []；绝不写（querySqlite readonly；CON-R002 精神）
 */
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import type { PlatformSource, UsageRecord } from '../types';
import { querySqlite } from './sqlite';

export function workbuddyDbPath(home: string): string {
  return join(home, '.workbuddy', 'workbuddy.db');
}

/** updated_at（unix ms 数字）→ ISO；非法/缺失 → null */
function rowTs(v: unknown): string | null {
  if (v == null) return null;
  const d = new Date(typeof v === 'number' ? v : String(v));
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/** session_usage → UsageRecord[]：used 全记输出侧；used 非数/updated_at 缺失 → 跳过该行 */
export function parseWorkbuddySource(dbPath: string): UsageRecord[] {
  if (!existsSync(dbPath)) return [];
  const rows = querySqlite(dbPath, 'SELECT used, updated_at FROM "session_usage" WHERE used IS NOT NULL AND updated_at IS NOT NULL');
  if (!rows) return [];
  const out: UsageRecord[] = [];
  for (const row of rows) {
    const used = typeof row.used === 'number' ? row.used : null;
    const ts = rowTs(row.updated_at);
    if (used === null || !ts) continue;
    out.push({
      ts,
      platform: 'workbuddy',
      model: 'unknown',
      inputTokens: 0,
      outputTokens: used,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      reasoningTokens: 0,
    });
  }
  return out;
}

/** 平台源（home 可注入测试）：db 存在才 listFiles；parseFile 直读 sqlite（文本入参忽略，同 zcode 模式） */
export function createWorkbuddySource(home: string = homedir()): PlatformSource {
  const dbPath = workbuddyDbPath(home);
  return {
    platform: 'workbuddy',
    home: dbPath,
    listFiles: () => (existsSync(dbPath) ? [dbPath] : []),
    parseFile: () => parseWorkbuddySource(dbPath),
  };
}
