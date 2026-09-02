/**
 * Qoder（Trae 系 IDE）SQLite 适配器（T2）：
 * - db：~/Library/Application Support/Qoder/SharedClientCache/cache/db/local.db
 *   （Win：%APPDATA%/Qoder/...；本适配器按 macOS 默认）
 * - 表 chat_message：assistant 行含 token_info（JSON：prompt_tokens/cached_tokens/completion_tokens）
 * - Qoder 的 prompt_tokens 已含 cached_tokens → 拆分：input = prompt - cached，cacheRead = cached
 * - 模型在 model_info JSON（model_key/modelKey）；ts 用 gmt_create（epoch ms）
 * - 防御式：表/列缺失 → []；ts 缺省用文件 mtime（fallbackTs）
 */
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import type { PlatformSource, UsageRecord } from '../types';
import { num, safeJson } from './shared';
import { hasTable, querySqlite } from './sqlite';

export function qoderDbPath(home: string): string {
  return join(home, 'Library', 'Application Support', 'Qoder', 'SharedClientCache', 'cache', 'db', 'local.db');
}

function qoderTs(v: unknown, fallbackTs: string): string {
  if (v == null) return fallbackTs;
  const d = new Date(typeof v === 'number' ? v : String(v));
  return Number.isNaN(d.getTime()) ? fallbackTs : d.toISOString();
}

function qoderModel(row: Record<string, unknown>): string {
  if (typeof row.model === 'string' && row.model) return row.model;
  const mi = safeJson(String(row.model_info ?? ''));
  if (mi && typeof mi === 'object') {
    const m = mi as Record<string, unknown>;
    if (typeof m.model_key === 'string') return m.model_key;
    if (typeof m.modelKey === 'string') return m.modelKey;
    if (typeof m.model === 'string') return m.model;
    if (typeof m.id === 'string') return m.id;
  }
  return 'unknown';
}

/** 查询 chat_message assistant 行 → UsageRecord[]（cached input 拆分） */
export function parseQoderSource(dbPath: string, fallbackTs = new Date(0).toISOString()): UsageRecord[] {
  if (!hasTable(dbPath, 'chat_message')) return [];
  const rows = querySqlite(
    dbPath,
    "SELECT * FROM chat_message WHERE role='assistant' AND token_info IS NOT NULL"
  );
  if (!rows) return [];
  const out: UsageRecord[] = [];
  for (const row of rows) {
    const ti = safeJson(String(row.token_info ?? ''));
    if (!ti) continue;
    const prompt = num(ti.prompt_tokens);
    const cached = num(ti.cached_tokens);
    const completion = num(ti.completion_tokens);
    const inputTokens = Math.max(0, prompt - cached);
    const cacheReadTokens = Math.min(prompt, cached);
    if (inputTokens === 0 && cacheReadTokens === 0 && completion === 0) continue;
    out.push({
      ts: qoderTs(row.gmt_create, fallbackTs),
      platform: 'qoder',
      model: qoderModel(row),
      inputTokens,
      outputTokens: completion,
      cacheReadTokens,
      cacheWriteTokens: 0,
      reasoningTokens: 0,
    });
  }
  return out;
}

/** 平台源：listFiles 返回存在的 db；parseFile 内 querySqlite */
export function createQoderSource(home = homedir()): PlatformSource {
  const dbPath = qoderDbPath(home);
  return {
    platform: 'qoder',
    home: join(home, 'Library', 'Application Support', 'Qoder'),
    listFiles: () => (existsSync(dbPath) ? [dbPath] : []),
    parseFile: (_text, fallbackTs) => parseQoderSource(dbPath, fallbackTs),
  };
}
