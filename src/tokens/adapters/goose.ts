/**
 * Goose（Block AI agent）SQLite 适配器（T2）：
 * - db：~/.local/share/goose/sessions/sessions.db（Linux/旧版 macOS）；桌面版 macOS 另在
 *   ~/Library/Application Support/goose/sessions/sessions.db（双候选，取存在的）
 * - 表 sessions：total_tokens/input_tokens/output_tokens（单轮）+ accumulated_*（会话累计，优先）
 * - 模型在 model_config_json（JSON，model 字段）或 model 列
 * - 防御式：表/列缺失 → [] / 0；ts 缺省用文件 mtime（fallbackTs）
 */
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import type { PlatformSource, UsageRecord } from '../types';
import { num, safeJson } from './shared';
import { hasTable, querySqlite } from './sqlite';

/** 候选 db 路径（存在才返回） */
export function gooseDbPaths(home: string): string[] {
  const candidates = [
    join(home, '.local', 'share', 'goose', 'sessions', 'sessions.db'),
    join(home, 'Library', 'Application Support', 'goose', 'sessions', 'sessions.db'),
  ];
  return candidates.filter((p) => existsSync(p));
}

/** 会话时间：created_at（unix ms 或 ISO）→ ISO；缺省/非法 → fallbackTs */
function gooseTs(v: unknown, fallbackTs: string): string {
  if (v == null) return fallbackTs;
  const d = new Date(typeof v === 'number' ? v : String(v));
  return Number.isNaN(d.getTime()) ? fallbackTs : d.toISOString();
}

/** 模型：model 列优先，退化 model_config_json JSON 内 model/model_name/id */
function gooseModel(row: Record<string, unknown>): string {
  if (typeof row.model === 'string' && row.model) return row.model;
  const cfg = safeJson(String(row.model_config_json ?? ''));
  if (cfg && typeof cfg === 'object') {
    const c = cfg as Record<string, unknown>;
    if (typeof c.model === 'string') return c.model;
    if (typeof c.model_name === 'string') return c.model_name;
    if (typeof c.name === 'string') return c.name;
    if (typeof c.id === 'string') return c.id;
    const nested = c.model;
    if (nested && typeof nested === 'object') {
      const n = nested as Record<string, unknown>;
      if (typeof n.model === 'string') return n.model;
      if (typeof n.id === 'string') return n.id;
    }
  }
  return 'unknown';
}

/** 查询 sessions 表 → UsageRecord[]（累计列优先；无 token 行跳过） */
export function parseGooseSource(dbPath: string, fallbackTs = new Date(0).toISOString()): UsageRecord[] {
  if (!hasTable(dbPath, 'sessions')) return [];
  const rows = querySqlite(dbPath, 'SELECT * FROM sessions');
  if (!rows) return [];
  const out: UsageRecord[] = [];
  for (const row of rows) {
    const inputTokens = num(row.accumulated_input_tokens ?? row.input_tokens);
    const outputTokens = num(row.accumulated_output_tokens ?? row.output_tokens);
    const reasoningTokens = num(row.accumulated_reasoning_tokens ?? row.reasoning_tokens);
    if (inputTokens === 0 && outputTokens === 0 && reasoningTokens === 0) continue;
    out.push({
      ts: gooseTs(row.created_at, fallbackTs),
      platform: 'goose',
      model: gooseModel(row),
      inputTokens,
      outputTokens,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      reasoningTokens,
    });
  }
  return out;
}

/** 平台源：listFiles 返回存在的候选 db；parseFile 内 querySqlite（多候选只读首个，避免重复计数） */
export function createGooseSource(home = homedir()): PlatformSource {
  const paths = gooseDbPaths(home);
  const primary = paths[0];
  return {
    platform: 'goose',
    home: join(home, '.local', 'share', 'goose', 'sessions'),
    listFiles: () => paths,
    parseFile: (_text, fallbackTs) => (primary ? parseGooseSource(primary, fallbackTs) : []),
  };
}
