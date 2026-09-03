/**
 * ZCode（OpenCode-fork CLI）SQLite 适配器（T2）：
 * - db：~/.zcode/cli/db/db.sqlite
 * - 精确路径：model_usage 表（per-request per-model，正确数据源）——显式列 SELECT，
 *   model_id=模型、started_at（unix ms）=时间，input/output/reasoning/cache 各列直接映射；
 *   status 有值即计（error/cancelled 也消耗了 token，不参与过滤）
 * - 降级路径：model_usage 表不存在时，泛化遍历含 token 列的表（旧逻辑）——但行级真实 ts 提取不到 → 跳过该行
 *   （禁止 mtime 兜底：全表挤进单一 mtime 时刻会污染时间分布，宁缺勿错）
 * - 防御式：model_usage 缺关键列（schema 漂移）→ []；表/列缺失 → []；绝不写（querySqlite readonly）
 */
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import type { PlatformSource, UsageRecord } from '../types';
import { num, toRecord } from './shared';
import { hasTable, querySqlite } from './sqlite';

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

/** 行时间戳：ISO 字符串 / unix ms 数字 → ISO；缺省/非法 → null（调用方跳过该行，禁止 mtime 兜底） */
function rowTs(v: unknown): string | null {
  if (v == null) return null;
  const d = new Date(typeof v === 'number' ? v : String(v));
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/** 降级泛化路径行映射：行级真实 ts 提取不到 → 跳过（宁缺勿错） */
function zcodeRowToRecord(row: Record<string, unknown>): UsageRecord | null {
  const usage = pickTokens(row);
  if (Object.keys(usage).length === 0) return null;
  const ts = rowTs(row.created_at ?? row.timestamp ?? row.createdAt ?? row.time_created ?? row.started_at ?? row.startedAt);
  if (!ts) return null; // 无行级真实时间戳 → 跳过（mtime 兜底会污染时间分布）
  const model =
    (typeof row.model === 'string' && row.model) ||
    (typeof row.model_id === 'string' && row.model_id) ||
    (typeof row.modelID === 'string' ? row.modelID : 'unknown');
  return toRecord({ ts, platform: 'zcode', model }, usage);
}

function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

/** model_usage 表显式列（本机 PRAGMA 实测：per-request per-model；status 保留供未来过滤，当前有值即计） */
const MODEL_USAGE_COLS = [
  'model_id', 'started_at',
  'input_tokens', 'output_tokens', 'reasoning_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens',
  'status',
] as const;
/** 关键 token 列（缺任一 → 判 schema 漂移 → []，不降级误读） */
const MODEL_USAGE_KEY = ['input_tokens', 'output_tokens'] as const;

/** 精确路径：model_usage 表 → UsageRecord[]（前提：hasTable 已确认表存在）；缺关键列/查询失败 → null */
function parseModelUsage(dbPath: string): UsageRecord[] | null {
  const cols = querySqlite(dbPath, 'PRAGMA table_info("model_usage")');
  if (!cols) return null;
  const colNames = new Set(cols.map((c) => String(c.name ?? '')));
  if (!MODEL_USAGE_KEY.every((c) => colNames.has(c))) return null; // 关键 token 列缺失 → 判漂移
  const selCols = MODEL_USAGE_COLS.filter((c) => colNames.has(c));
  const rows = querySqlite(dbPath, `SELECT ${selCols.map(quoteIdent).join(', ')} FROM "model_usage"`);
  if (!rows) return null;
  const out: UsageRecord[] = [];
  for (const row of rows) {
    const ts = rowTs(row.started_at);
    if (!ts) continue;
    const rec: UsageRecord = {
      ts,
      platform: 'zcode',
      model: (typeof row.model_id === 'string' && row.model_id) || 'unknown',
      inputTokens: num(row.input_tokens),
      outputTokens: num(row.output_tokens),
      cacheReadTokens: num(row.cache_read_input_tokens),
      cacheWriteTokens: num(row.cache_creation_input_tokens),
      reasoningTokens: num(row.reasoning_tokens),
    };
    if (rec.inputTokens === 0 && rec.outputTokens === 0 && rec.cacheReadTokens === 0 && rec.cacheWriteTokens === 0 && rec.reasoningTokens === 0) continue;
    out.push(rec);
  }
  return out;
}

/** 降级路径所需列白名单：token 归一化键 + model/ts 键（不拉内容列/正文） */
const NEEDED_COLS = new Set<string>([
  ...Object.keys(TOKEN_KEY_MAP),
  'model', 'model_id', 'modelID',
  'created_at', 'timestamp', 'createdAt', 'time_created', 'started_at', 'startedAt',
]);

/** 降级路径：泛化遍历含 token 列的表（model_usage 不存在时）；行级 ts 提取不到 → 跳过该行 */
function parseGeneric(dbPath: string): UsageRecord[] {
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
      const rec = zcodeRowToRecord(row);
      if (rec) out.push(rec);
    }
  }
  return out;
}

/** 查询 db：精确 model_usage 优先（漂移 → []）→ 表缺失降级泛化扫描（无行级 ts 行跳过） */
export function parseZcodeSource(dbPath: string): UsageRecord[] {
  if (hasTable(dbPath, 'model_usage')) {
    return parseModelUsage(dbPath) ?? [];
  }
  return parseGeneric(dbPath);
}

/** 平台源：listFiles 返回存在的 db；parseFile 内 querySqlite */
export function createZcodeSource(home = homedir()): PlatformSource {
  const dbPath = zcodeDbPath(home);
  return {
    platform: 'zcode',
    home: join(home, '.zcode', 'cli', 'db'),
    listFiles: () => (existsSync(dbPath) ? [dbPath] : []),
    parseFile: (_text) => parseZcodeSource(dbPath),
  };
}
