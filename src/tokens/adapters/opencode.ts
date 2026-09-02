/**
 * opencode 平台适配器（T1 JSONL/JSON 型 + SQLite 兜底）：
 * - 主源 ~/.opencode/token-history/YYYY-MM.json，按月 JSON 数组（官方未收录，本机实测格式）
 * - 每条会话 { sessionID, projectID, timestamp(ms), totals{...}, byModel{模型名:{input,output,total,reasoning,cache:{read,write}}} }
 * - 语义：按 byModel 键拆多条 UsageRecord（模型级明细，totals 为汇总不单出记录）
 * - 兜底：官方主存储 opencode.db（Session 表，session 级 token 列）——token-history 无 json 文件时启用（两源永不叠加）
 *   db 路径：macOS ~/Library/Application Support/opencode/opencode.db、Linux ~/.local/share/opencode/opencode.db
 * 参考：docs/research/2026-09-02-agent-token-format-research.md §3、docs/design/Token视图v2-成本换算与SQLite兜底-design.md §二
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import type { PlatformSource, UsageRecord } from '../types';
import { num, safeJson } from './shared';
import { hasTable, querySqlite } from './sqlite';

/** readFile 标记前缀（SQLite 二进制不经 utf8 读取，路径透传——同 zed adapter） */
const DB_MARKER = '\u0000sqlite:';

/** 单条会话记录 → 按 byModel 键拆 0..N 条 UsageRecord（空/零值模型跳过） */
export function parseOpenCodeEntry(entry: unknown, fallbackTs: string): UsageRecord[] {
  if (!entry || typeof entry !== 'object') return [];
  const e = entry as Record<string, unknown>;
  const byModel = e.byModel;
  if (!byModel || typeof byModel !== 'object') return [];
  const ts = typeof e.timestamp === 'number' ? new Date(e.timestamp).toISOString() : fallbackTs;
  const out: UsageRecord[] = [];
  for (const [model, v] of Object.entries(byModel as Record<string, unknown>)) {
    if (!v || typeof v !== 'object') continue;
    const m = v as Record<string, unknown>;
    const cache = (m.cache ?? {}) as Record<string, unknown>;
    // 对齐 anthropic 约定（与 claude/codex 一致）：opencode byModel.output 不含 reasoning，output 补入 reasoning 避免合计低估
    const reasoningTokens = num(m.reasoning);
    const rec: UsageRecord = {
      ts,
      platform: 'opencode',
      model,
      inputTokens: num(m.input),
      outputTokens: num(m.output) + reasoningTokens,
      cacheReadTokens: num(cache.read),
      cacheWriteTokens: num(cache.write),
      reasoningTokens,
    };
    if (rec.inputTokens === 0 && rec.outputTokens === 0 && rec.cacheReadTokens === 0 && rec.cacheWriteTokens === 0 && rec.reasoningTokens === 0) continue;
    out.push(rec);
  }
  return out;
}

/** 整文件解析：JSON 数组（按月），全部会话记录展开 */
export function parseOpenCodeFile(text: string, fallbackTs: string): UsageRecord[] {
  const j = safeJson(text);
  if (!j) return [];
  const arr = Array.isArray(j) ? j : [j];
  const out: UsageRecord[] = [];
  for (const e of arr) out.push(...parseOpenCodeEntry(e, fallbackTs));
  return out;
}

/** 候选 db 路径（存在才返回） */
export function opencodeDbPaths(home: string): string[] {
  const candidates = [
    join(home, 'Library', 'Application Support', 'opencode', 'opencode.db'),
    join(home, '.local', 'share', 'opencode', 'opencode.db'),
  ];
  return candidates.filter((p) => existsSync(p));
}

/** Session 表所需列（官方 schema；防御式：列名可能随版本漂移，缺关键列 → 降级空态） */
const DB_TOKEN_COLS = ['PromptTokens', 'CompletionTokens', 'CacheCreationTokens', 'CacheReadTokens'] as const;
const DB_MODEL_COLS = ['Model', 'model'] as const;
const DB_TS_COLS = ['CreatedAt', 'createdAt', 'StartedAt', 'startedAt', 'created_at', 'started_at', 'Timestamp', 'timestamp'] as const;

/** 行时间戳：ISO 字符串 / unix ms 数字 → ISO；缺省/非法 → fallbackTs */
function rowTs(v: unknown, fallbackTs: string): string {
  if (v == null) return fallbackTs;
  const d = new Date(typeof v === 'number' ? v : String(v));
  return Number.isNaN(d.getTime()) ? fallbackTs : d.toISOString();
}

/**
 * SQLite 兜底：Session 表 → UsageRecord[]（session 级聚合，无 byModel 细分 → model 用行模型列或 'unknown'）。
 * 防御式：表缺失/打开失败/关键 token 列缺失 → []（降级空态，不抛）。
 */
export function parseOpenCodeDb(dbPath: string, fallbackTs = new Date(0).toISOString()): UsageRecord[] {
  if (!hasTable(dbPath, 'Session')) return [];
  const cols = querySqlite(dbPath, 'PRAGMA table_info("Session")');
  if (!cols) return [];
  const colNames = new Set(cols.map((c) => String(c.name ?? '')));
  const tokenCols = DB_TOKEN_COLS.filter((c) => colNames.has(c));
  if (!tokenCols.includes('PromptTokens') || !tokenCols.includes('CompletionTokens')) return []; // 关键 token 列缺失 → 降级空态
  const modelCol = DB_MODEL_COLS.find((c) => colNames.has(c));
  const tsCol = DB_TS_COLS.find((c) => colNames.has(c));
  // 只 SELECT 所需列（token 列 + 模型 + 时间戳），不拉内容列
  const needed = [...tokenCols, ...(modelCol ? [modelCol] : []), ...(tsCol ? [tsCol] : [])];
  const rows = querySqlite(dbPath, `SELECT ${needed.map((c) => `"${c.replace(/"/g, '""')}"`).join(', ')} FROM "Session"`);
  if (!rows) return [];
  const out: UsageRecord[] = [];
  for (const row of rows) {
    const rec: UsageRecord = {
      ts: tsCol ? rowTs(row[tsCol], fallbackTs) : fallbackTs,
      platform: 'opencode',
      model: (modelCol && typeof row[modelCol] === 'string' && row[modelCol]) || 'unknown',
      inputTokens: num(row.PromptTokens),
      outputTokens: num(row.CompletionTokens),
      cacheReadTokens: num(row.CacheReadTokens),
      cacheWriteTokens: num(row.CacheCreationTokens),
      reasoningTokens: 0,
    };
    if (rec.inputTokens === 0 && rec.outputTokens === 0 && rec.cacheReadTokens === 0 && rec.cacheWriteTokens === 0) continue;
    out.push(rec);
  }
  return out;
}

function listTokenHistoryFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => join(dir, f));
}

export function createOpenCodeSource(home: string = homedir()): PlatformSource {
  const tokenHistory = join(home, '.opencode', 'token-history');
  const dbPaths = opencodeDbPaths(home);
  return {
    platform: 'opencode',
    home: tokenHistory,
    listFiles: () => {
      // 主源有效（token-history 有 json 文件）→ 只用 token-history；缺失 → db 路径兜底（两源永不叠加）
      const thFiles = listTokenHistoryFiles(tokenHistory);
      return thFiles.length > 0 ? thFiles : dbPaths;
    },
    readFile: (path) => (path.endsWith('.db') ? `${DB_MARKER}${path}` : readFileSync(path, 'utf8')),
    parseFile: (text, fallbackTs) => {
      if (text.startsWith(DB_MARKER)) return parseOpenCodeDb(text.slice(DB_MARKER.length), fallbackTs);
      return parseOpenCodeFile(text, fallbackTs);
    },
  };
}
