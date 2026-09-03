/**
 * 用量聚合器：UsageRecord[] → 桶序列 + 平台/模型透视。
 * 纯函数（无 IO），单测覆盖；桶键本地时区。
 * 范围 = 日历对齐窗口（TokenTracker 同构五档）：day=今天、week=本周（周一起）、month=本月、total=最近 24 个月（有界）、custom=用户区间：
 * getRangeWindow 产出 {fromMs,toMs} 双边界（to = 当天 23:59:59.999 本地封顶——未来时间戳脏数据被右边界挡住），
 * summarize 按双边界过滤 records（fromMs <= ts <= toMs），全视图（总计/序列/透视）只含窗口内记录；UsageSummary.range 填实际窗口 ISO。
 * 序列分桶粒度按范围推导：day→hour 桶、week/month→day 桶、total→month 桶、custom→跨度自适应（≤3 天 hour、≤90 天 day、否则 month）。
 * 成本（costUsd）：行内全部 record 模型命中 PRICING_SEED → 数值累加；任一未命中 → null（诚实不估算，UI 显示「—」）。
 */
import type { CustomRange, UsageBucket, UsageDimensionRow, UsageGranularity, UsageRecord, UsageSummary, UsageTotals } from './types';
import { computeCost, matchPrice } from './pricing';

type MutableTotals = {
  inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number; reasoningTokens: number; totalTokens: number;
  costUsd: number; costKnown: boolean;
};

/** 当天 23:59:59.999（本地）——窗口右边界封顶 */
function dayEndMs(y: number, m: number, d: number): number {
  return new Date(y, m, d, 23, 59, 59, 999).getTime();
}

/** 范围窗口（本地时区）：day=今天、week=本周一 00:00~周日 23:59:59.999（周一起，getDay 转周一偏移）、month=本月 1 号~月末、total=最近 24 个月（本月-23 月 1 号~今天）、custom=用户区间（from>to 交换） */
export function getRangeWindow(period: UsageGranularity, now: Date, custom?: CustomRange): { fromMs: number; toMs: number } {
  const y = now.getFullYear(), m = now.getMonth(), d = now.getDate();
  switch (period) {
    case 'day':
      return { fromMs: new Date(y, m, d).getTime(), toMs: dayEndMs(y, m, d) };
    case 'week': {
      const offset = (now.getDay() + 6) % 7; // 周一=0（getDay：日=0…六=6）
      const mon = new Date(y, m, d - offset); // Date 负日期自动回滚
      return { fromMs: new Date(mon.getFullYear(), mon.getMonth(), mon.getDate()).getTime(), toMs: dayEndMs(y, m, d) };
    }
    case 'month':
      return { fromMs: new Date(y, m, 1).getTime(), toMs: dayEndMs(y, m + 1, 0) }; // 月末 = 下月 0 号
    case 'total':
      return { fromMs: new Date(y, m - 23, 1).getTime(), toMs: dayEndMs(y, m, d) }; // 24 个月窗口（含本月）
    case 'custom': {
      if (!custom || !custom.from || !custom.to) return { fromMs: 0, toMs: 0 }; // 缺参 → 空窗
      let from = custom.from, to = custom.to;
      if (from > to) { const tmp = from; from = to; to = tmp; } // from>to → 交换（YYYY-MM-DD 字典序=时间序）
      return { fromMs: new Date(`${from}T00:00:00`).getTime(), toMs: new Date(`${to}T23:59:59.999`).getTime() };
    }
  }
}

/** 序列分桶粒度（独立类型：'min10'/'week' 保留兼容 bucketKey/isoWeekKey，范围推导仅产出 hour/day/month） */
export type BucketGran = 'min10' | 'hour' | 'day' | 'week' | 'month';

/** 范围档 → 序列分桶粒度（custom 由 customBucketGran 按跨度自适应覆盖） */
const RANGE_BUCKET: Record<UsageGranularity, BucketGran> = {
  day: 'hour',
  week: 'day',
  month: 'day',
  total: 'month',
  custom: 'month',
};

/** custom 跨度自适应：≤3 天 hour、≤90 天 day、否则 month */
function customBucketGran(custom?: CustomRange): BucketGran {
  if (!custom || !custom.from || !custom.to) return 'month';
  const days = Math.round((new Date(`${custom.to}T23:59:59.999`).getTime() - new Date(`${custom.from}T00:00:00`).getTime()) / 86400000) + 1;
  if (days <= 3) return 'hour';
  if (days <= 90) return 'day';
  return 'month';
}

function emptyTotals(): MutableTotals {
  return { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, totalTokens: 0, costUsd: 0, costKnown: true };
}

function addTotals(t: MutableTotals, r: UsageRecord): void {
  t.inputTokens += r.inputTokens;
  t.outputTokens += r.outputTokens;
  t.cacheReadTokens += r.cacheReadTokens;
  t.cacheWriteTokens += r.cacheWriteTokens;
  t.reasoningTokens += r.reasoningTokens || 0;
  t.totalTokens += r.inputTokens + r.outputTokens + r.cacheReadTokens + r.cacheWriteTokens;
  const p = matchPrice(r.model);
  if (!p) {
    t.costKnown = false; // 行内任一未知 → 整行 null（已未知则不再累加）
  } else if (t.costKnown) {
    t.costUsd += computeCost(r, p);
  }
}

function finalize(t: MutableTotals): UsageTotals {
  const { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, reasoningTokens, totalTokens, costUsd, costKnown } = t;
  return { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, reasoningTokens, totalTokens, costUsd: costKnown ? costUsd : null };
}

/** ISO 周键（ISO-8601：周一起始，含 1/4 的那周为第 1 周）——YYYY-Www */
export function isoWeekKey(d: Date): string {
  const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const day = t.getUTCDay() || 7; // 周日=7
  t.setUTCDate(t.getUTCDate() + 4 - day); // 本周四
  const yearStart = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((t.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
  const mm = String(week).padStart(2, '0');
  return `${t.getUTCFullYear()}-W${mm}`;
}

/** 桶键（本地时区）：min10=YYYY-MM-DD HH:MM（10 分钟取整）/ hour / day / week / month */
export function bucketKey(ts: string, granularity: BucketGran): string {
  const d = new Date(ts);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  const h = String(d.getHours()).padStart(2, '0');
  switch (granularity) {
    case 'min10':
      return `${y}-${m}-${day} ${h}:${String(Math.floor(d.getMinutes() / 10) * 10).padStart(2, '0')}`;
    case 'hour':
      return `${y}-${m}-${day} ${h}:00`;
    case 'week':
      return isoWeekKey(d);
    case 'month':
      return `${y}-${m}`;
    case 'day':
    default:
      return `${y}-${m}-${day}`;
  }
}

export interface ScanSourceInfo {
  platform: UsageRecord['platform'];
  home: string;
  files: number;
  records: number;
  error?: string;
}

/** 汇总：按范围窗口 {from,to} 双边界过滤 records → 桶序列（升序）+ 平台/模型透视 + 全局总计 */
export function summarize(
  records: UsageRecord[],
  granularity: UsageGranularity,
  sources: ScanSourceInfo[],
  generatedAt = new Date().toISOString(),
  custom?: CustomRange
): UsageSummary {
  // 范围 = 日历对齐窗口：fromMs <= ts <= toMs（右边界封顶挡未来时间戳脏数据）
  const { fromMs, toMs } = getRangeWindow(granularity, new Date(generatedAt), custom);
  const scoped = records.filter((r) => {
    const t = new Date(r.ts).getTime();
    return t >= fromMs && t <= toMs;
  });
  const bucketGran = granularity === 'custom' ? customBucketGran(custom) : RANGE_BUCKET[granularity];
  const grand = emptyTotals();
  const buckets = new Map<string, MutableTotals & { records: number }>();
  const byPlatform = new Map<string, MutableTotals>();
  const byModel = new Map<string, MutableTotals>();

  for (const r of scoped) {
    addTotals(grand, r);
    const key = bucketKey(r.ts, bucketGran);
    let b = buckets.get(key);
    if (!b) {
      b = { ...emptyTotals(), records: 0 };
      buckets.set(key, b);
    }
    addTotals(b, r);
    b.records += 1;
    const pk = r.platform;
    let p = byPlatform.get(pk);
    if (!p) {
      p = emptyTotals();
      byPlatform.set(pk, p);
    }
    addTotals(p, r);
    const mk = `${r.platform}::${r.model}`;
    let mo = byModel.get(mk);
    if (!mo) {
      mo = emptyTotals();
      byModel.set(mk, mo);
    }
    addTotals(mo, r);
  }

  const series: UsageBucket[] = [...buckets.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : 1))
    .map(([bucket, t]) => ({ bucket, records: t.records, ...finalize(t) }));

  const dimRows = (m: Map<string, MutableTotals>): UsageDimensionRow[] =>
    [...m.entries()]
      .map(([k, t]) => {
        const [platform, model] = k.split('::');
        return { platform: platform as UsageRecord['platform'], model: model || 'unknown', ...finalize(t) };
      })
      .sort((a, b) => b.totalTokens - a.totalTokens);

  return {
    granularity,
    generatedAt,
    range: { from: new Date(fromMs).toISOString(), to: new Date(toMs).toISOString() },
    totals: finalize(grand),
    series,
    byPlatform: dimRows(byPlatform),
    byModel: dimRows(byModel),
    sources,
  };
}
