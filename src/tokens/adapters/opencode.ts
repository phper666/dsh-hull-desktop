/**
 * opencode 平台适配器（SQLite 主源 + token-history 降级）：
 * - 主源 opencode.db 存在 **两套表**（v1/v2 并存，opencode v2.2.5 实测）：
 *   - v1 `message`：data JSON 的 role=assistant 行（v1 遗留，本机最后写入 2026-11-05）
 *   - v2 `session_message`：`type` 列='assistant'（data 里无 role），model 为对象 `{id,providerID,variant}`，
 *     v2 起的用量持续写这里（本机 56k+ 行，最新到当天）——只读 message 会漏掉 v2 全部用量
 *   - ⚠️ 两表**高度重叠**：2026-09 实测 v1 14,954 行 vs v2 14,947 行，其中 14,947 行按
 *     (session_id, time_created) 完全对齐，仅 7 行 v1 独有（0.05%）⇒ **v2 为主 + v1 仅补差集**
 *     （按 session_id+time_created 去重），绝不能两张表全量相加
 * - tokens 两表形状一致：{input,output,reasoning,cache{read,write}}，time_created（unix ms）=用量发生时间。
 *   ⚠️ tokens 是 **per-request 快照**（每行 total = 该行 input+output+reasoning+cache.read+cache.write）——
 *   同 TokenTracker 口径（其 normalizeOpencodeTokens 逐行计），逐行直接求和，**不做 session 级差分**
 *   （total 单调递增只是 context 随对话增长的表象，非累计语义）
 * - ⚠️ **SQL 投影取字段，不把 data blob 搬进 JS**：本机库 5.7GB，整行 data 传 JS 再 JSON.parse
 *   首扫实测 52.5s；json_extract 只投影 6 个数值列 + model 后 7.6s（快 7 倍）。
 *   tokens/model 的取值语义与 JSON.parse 后读 `$.tokens.*` / `$.model.id` 等价
 * - 降级 ~/.opencode/token-history/YYYY-MM.json（session 生命周期累计快照，timestamp=快照时刻——仅兜底）
 * - 降级链：db 存在且 message/session_message 任一可用 → 只用 db（不叠加）；db 缺失/不可用 → token-history；都无 → 空态
 * - db 路径：macOS ~/Library/Application Support/opencode/opencode.db、Linux ~/.local/share/opencode/opencode.db
 * 参考：docs/research/2026-09-02-agent-token-format-research.md §3、docs/design/Token视图v2-成本换算与SQLite兜底-design.md §二/§五
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import type { PlatformSource, UsageRecord } from '../types';
import { num, safeJson } from './shared';
import { hasTable, querySqlite } from './sqlite';

/** readFile 标记前缀（SQLite 二进制不经 utf8 读取，路径透传——同 zed adapter） */
const DB_MARKER = '\u0000sqlite:';

/** 单条会话记录 → 按 byModel 键拆 0..N 条 UsageRecord（空/零值模型跳过）——token-history 降级源 */
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
    // 对齐 anthropic 约定（与 claude/codex 一致）：opencode output 不含 reasoning，output 补入 reasoning 避免合计低估
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

/** 行时间戳：unix ms 数字 / ISO 字符串 → ISO；缺省/非法 → null（调用方跳过该行，禁止 mtime 兜底） */
function rowMsTs(v: unknown): string | null {
  if (v == null) return null;
  const d = new Date(typeof v === 'number' ? v : String(v));
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/** 两表共用的 SQL 投影：只取 tokens 数值列 + model（v2 对象 id / v1 modelID / v1 model 字符串），不传 data blob */
const PROJECTION = `json_extract(data,'$.tokens.input') AS ti,
  json_extract(data,'$.tokens.output') AS to_,
  json_extract(data,'$.tokens.reasoning') AS tr,
  json_extract(data,'$.tokens.cache.read') AS tcr,
  json_extract(data,'$.tokens.cache.write') AS tcw,
  COALESCE(json_extract(data,'$.model.id'), json_extract(data,'$.modelID'), json_extract(data,'$.model')) AS model`;

/** 单行（v1/v2 共用投影列：ti/to_/tr/tcr/tcw/model）→ UsageRecord；无 ts/无 tokens/全零 → null */
function rowToUsageRecord(row: Record<string, unknown>): UsageRecord | null {
  const timeCreated = typeof row.time_created === 'number' ? row.time_created : Number(row.time_created);
  if (!Number.isFinite(timeCreated) || timeCreated <= 0) return null; // 无行级真实时间戳 → 跳过
  // 对齐 anthropic 约定（与 claude/codex 一致）：opencode output 不含 reasoning，output 补入 reasoning 避免合计低估
  const reasoningTokens = num(row.tr);
  const outputTokens = num(row.to_) + reasoningTokens;
  const inputTokens = num(row.ti);
  const cacheReadTokens = num(row.tcr);
  const cacheWriteTokens = num(row.tcw);
  // 全 NULL（无 tokens）/ 全零行跳过
  if (!inputTokens && !outputTokens && !cacheReadTokens && !cacheWriteTokens) return null;
  const model = row.model;
  return {
    ts: new Date(timeCreated).toISOString(),
    platform: 'opencode',
    model: typeof model === 'string' && model ? model : 'unknown',
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    reasoningTokens,
  };
}

/** (session_id, time_created) 去重键——v1/v2 重叠行判定 */
const rowKey = (row: Record<string, unknown>): string => `${String(row.session_id)}\u0000${String(row.time_created)}`;

/**
 * 主源：opencode.db 双表合并 → UsageRecord[]（per-request 快照逐行直接计，对齐 TokenTracker）。
 * - v2 `session_message`（type='assistant'）全量 + v1 `message` 差集（同 session_id+time_created 已由 v2 覆盖则跳过）
 * - 两表查询均带 json_valid 守卫：单条损坏 JSON 不连累整表（json_extract 遇坏 JSON 会抛错）
 * - 防御式：两表都缺失/打开失败 → []；无行级 ts / tokens 全 NULL / 全零 → 跳过该行
 */
export function parseOpenCodeMessages(dbPath: string): UsageRecord[] {
  const hasV2 = hasTable(dbPath, 'session_message');
  const hasV1 = hasTable(dbPath, 'message');
  if (!hasV2 && !hasV1) return [];
  const out: UsageRecord[] = [];
  const seen = new Set<string>();
  if (hasV2) {
    const rows = querySqlite(dbPath, `SELECT session_id, time_created, ${PROJECTION} FROM "session_message" WHERE type='assistant' AND json_valid(data)`);
    if (rows) {
      for (const row of rows) {
        seen.add(rowKey(row));
        const rec = rowToUsageRecord(row);
        if (rec) out.push(rec);
      }
    }
  }
  if (hasV1) {
    const rows = querySqlite(
      dbPath,
      `SELECT session_id, time_created, ${PROJECTION} FROM "message" WHERE json_valid(data) AND json_extract(data,'$.role')='assistant'`,
    );
    if (rows) {
      for (const row of rows) {
        if (seen.has(rowKey(row))) continue; // v2 已覆盖（同请求）→ 不重复计
        const rec = rowToUsageRecord(row);
        if (rec) out.push(rec);
      }
    }
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
  // 降级链判定：db 存在且 message / session_message 任一表可用 → 用 db；否则 token-history
  const pickDb = (): string | null => {
    for (const p of dbPaths) {
      if (hasTable(p, 'session_message') || hasTable(p, 'message')) return p;
    }
    return null;
  };
  return {
    platform: 'opencode',
    home: tokenHistory,
    listFiles: () => {
      const db = pickDb();
      return db ? [db] : listTokenHistoryFiles(tokenHistory);
    },
    readFile: (path) => (path.endsWith('.db') ? `${DB_MARKER}${path}` : readFileSync(path, 'utf8')),
    parseFile: (text, fallbackTs) => {
      if (text.startsWith(DB_MARKER)) return parseOpenCodeMessages(text.slice(DB_MARKER.length));
      return parseOpenCodeFile(text, fallbackTs);
    },
  };
}
