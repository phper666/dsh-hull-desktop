/**
 * opencode 平台适配器（SQLite 主源 + token-history 降级）：
 * - 主源 opencode.db message 表（per-message 真实用量，无累计快照失真）：
 *   data JSON 的 role=assistant 行含 tokens{input,output,reasoning,cache{read,write}}，time_created（unix ms）=用量真实发生时间
 * - 降级 ~/.opencode/token-history/YYYY-MM.json（session 生命周期累计快照，timestamp=快照时刻——历史堆近期 + 时间分布失真，仅兜底）
 * - 降级链：db 存在且 message 表可用 → 只用 db（不叠加）；db 缺失/不可用 → token-history；都无 → 空态
 * - db 路径：macOS ~/Library/Application Support/opencode/opencode.db、Linux ~/.local/share/opencode/opencode.db
 * 参考：docs/research/2026-09-02-agent-token-format-research.md §3、docs/design/Token视图v2-成本换算与SQLite兜底-design.md §二/§五
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import type { PlatformSource, UsageRecord } from '../types';
import { findString, num, safeJson } from './shared';
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

/**
 * 主源：opencode.db message 表 → UsageRecord[]（per-message 粒度，真实发生时间）。
 * - 只 SELECT 所需列（id/session_id/time_created/data）；data JSON role=assistant 且 tokens 存在才计
 * - output 补入 reasoning（与 token-history byModel 语义一致）；全零 token 行跳过
 * - 防御式：表缺失/打开失败 → []；data 解析失败/无行级 ts → 跳过该行
 */
export function parseOpenCodeMessages(dbPath: string): UsageRecord[] {
  if (!hasTable(dbPath, 'message')) return [];
  const rows = querySqlite(dbPath, 'SELECT id, session_id, time_created, data FROM "message"');
  if (!rows) return [];
  const out: UsageRecord[] = [];
  for (const row of rows) {
    const ts = rowMsTs(row.time_created);
    if (!ts) continue; // 无行级真实时间戳 → 跳过（mtime 兜底会污染时间分布）
    let d: unknown;
    try {
      d = JSON.parse(String(row.data));
    } catch {
      continue; // data 解析失败 → 跳过
    }
    if (!d || typeof d !== 'object') continue;
    const e = d as Record<string, unknown>;
    if (e.role !== 'assistant') continue;
    const t = e.tokens;
    if (!t || typeof t !== 'object') continue;
    const tokens = t as Record<string, unknown>;
    const cache = (tokens.cache ?? {}) as Record<string, unknown>;
    const reasoningTokens = num(tokens.reasoning);
    const rec: UsageRecord = {
      ts,
      platform: 'opencode',
      model:
        (typeof e.modelID === 'string' && e.modelID) ||
        (typeof e.model === 'string' && e.model) ||
        findString(e, 'model', 3) ||
        'unknown',
      inputTokens: num(tokens.input),
      outputTokens: num(tokens.output) + reasoningTokens,
      cacheReadTokens: num(cache.read),
      cacheWriteTokens: num(cache.write),
      reasoningTokens,
    };
    if (rec.inputTokens === 0 && rec.outputTokens === 0 && rec.cacheReadTokens === 0 && rec.cacheWriteTokens === 0 && rec.reasoningTokens === 0) continue;
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
  // 降级链判定：db 存在且 message 表可用 → 用 db；否则 token-history
  const pickDb = (): string | null => {
    for (const p of dbPaths) {
      if (hasTable(p, 'message')) return p;
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
