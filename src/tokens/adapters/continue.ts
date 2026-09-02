/**
 * Continue（VS Code 扩展）SQLite 适配器（T2）：
 * - db：~/.continue/devdata.sqlite
 * - 表 tokens_generated：模型+token 事件日志，列 {model, provider, promptTokens, generatedTokens}
 *   （防御式：同时兼容 tokens_prompt/tokens_generated 旧命名）
 * - 防御式：表/列缺失 → [] / 0；ts 缺省用文件 mtime（fallbackTs）
 */
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import type { PlatformSource, UsageRecord } from '../types';
import { num } from './shared';
import { hasTable, querySqlite } from './sqlite';

export function continueDbPath(home: string): string {
  return join(home, '.continue', 'devdata.sqlite');
}

/** 行时间：timestamp 列（ISO 或 unix ms）→ ISO；缺省 → fallbackTs */
function rowTs(v: unknown, fallbackTs: string): string {
  if (v == null) return fallbackTs;
  const d = new Date(typeof v === 'number' ? v : String(v));
  return Number.isNaN(d.getTime()) ? fallbackTs : d.toISOString();
}

/** 查询 tokens_generated → UsageRecord[]（promptTokens→input，generatedTokens→output） */
export function parseContinueSource(dbPath: string, fallbackTs = new Date(0).toISOString()): UsageRecord[] {
  if (!hasTable(dbPath, 'tokens_generated')) return [];
  const rows = querySqlite(dbPath, 'SELECT * FROM tokens_generated');
  if (!rows) return [];
  const out: UsageRecord[] = [];
  for (const row of rows) {
    const inputTokens = num(row.promptTokens ?? row.tokens_prompt);
    const outputTokens = num(row.generatedTokens ?? row.tokens_generated);
    if (inputTokens === 0 && outputTokens === 0) continue;
    out.push({
      ts: rowTs(row.timestamp ?? row.created_at, fallbackTs),
      platform: 'continue',
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

/** 平台源：listFiles 返回存在的 db；parseFile 内 querySqlite */
export function createContinueSource(home = homedir()): PlatformSource {
  const dbPath = continueDbPath(home);
  return {
    platform: 'continue',
    home: join(home, '.continue'),
    listFiles: () => (existsSync(dbPath) ? [dbPath] : []),
    parseFile: (_text, fallbackTs) => parseContinueSource(dbPath, fallbackTs),
  };
}
