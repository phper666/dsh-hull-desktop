/**
 * 用量聚合器：UsageRecord[] → 桶序列 + 平台/模型透视。
 * 纯函数（无 IO），单测覆盖；桶键本地时区。
 * 粒度 = 日历对齐范围（本地时区）：hour=本小时整点起、day=今天 0 点、month=本月 1 号、year=今年 1/1：
 * summarize 按 generatedAt 所在日历边界过滤 records，全视图（总计/序列/透视）只含边界后记录。
 * 序列分桶粒度按范围推导（RANGE_BUCKET）：hour 范围 → 10 分钟桶、day → 小时桶、month → 天桶、year → 月桶。
 */
import type { UsageBucket, UsageDimensionRow, UsageGranularity, UsageRecord, UsageSummary, UsageTotals } from './types';

type MutableTotals = { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number; reasoningTokens: number; totalTokens: number };

/** 日历对齐边界（本地时区，Date 无参构造即本地）：hour=本小时整点、day=今天 0 点、month=本月 1 号、year=今年 1/1 */
export function rangeCutoffMs(granularity: UsageGranularity, now: Date): number {
  const y = now.getFullYear(), m = now.getMonth(), d = now.getDate();
  switch (granularity) {
    case 'hour':  return new Date(y, m, d, now.getHours()).getTime();
    case 'day':   return new Date(y, m, d).getTime();
    case 'month': return new Date(y, m, 1).getTime();
    case 'year':  return new Date(y, 0, 1).getTime();
  }
}

/** 序列分桶粒度（独立类型：'week' 保留兼容 bucketKey/isoWeekKey，范围推导不再产出） */
export type BucketGran = 'min10' | 'hour' | 'day' | 'week' | 'month';

/** 范围档 → 序列分桶粒度（解耦：1 小时范围用 10 分钟桶才有多桶） */
const RANGE_BUCKET: Record<UsageGranularity, BucketGran> = {
  hour: 'min10',
  day: 'hour',
  month: 'day',
  year: 'month',
};

function emptyTotals(): MutableTotals {
  return { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, totalTokens: 0 };
}

function addTotals(t: MutableTotals, r: UsageRecord): void {
  t.inputTokens += r.inputTokens;
  t.outputTokens += r.outputTokens;
  t.cacheReadTokens += r.cacheReadTokens;
  t.cacheWriteTokens += r.cacheWriteTokens;
  t.reasoningTokens += r.reasoningTokens || 0;
  t.totalTokens += r.inputTokens + r.outputTokens + r.cacheReadTokens + r.cacheWriteTokens;
}

function finalize(t: MutableTotals): UsageTotals {
  const { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, reasoningTokens, totalTokens } = t;
  return { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, reasoningTokens, totalTokens };
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

/** 汇总：按粒度时间范围过滤 records → 桶序列（升序）+ 平台/模型透视 + 全局总计 */
export function summarize(
  records: UsageRecord[],
  granularity: UsageGranularity,
  sources: ScanSourceInfo[],
  generatedAt = new Date().toISOString()
): UsageSummary {
  // 粒度 = 日历对齐范围：只聚合 generatedAt 所在日历边界之后的记录
  const cutoff = rangeCutoffMs(granularity, new Date(generatedAt));
  const scoped = records.filter((r) => new Date(r.ts).getTime() >= cutoff);
  const grand = emptyTotals();
  const buckets = new Map<string, MutableTotals & { records: number }>();
  const byPlatform = new Map<string, MutableTotals>();
  const byModel = new Map<string, MutableTotals>();

  for (const r of scoped) {
    addTotals(grand, r);
    const key = bucketKey(r.ts, RANGE_BUCKET[granularity]);
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
    totals: finalize(grand),
    series,
    byPlatform: dimRows(byPlatform),
    byModel: dimRows(byModel),
    sources,
  };
}
