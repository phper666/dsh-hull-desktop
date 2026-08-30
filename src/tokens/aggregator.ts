/**
 * 用量聚合器：UsageRecord[] → 粒度桶序列 + 平台/模型透视。
 * 纯函数（无 IO），单测覆盖；桶键本地时区。
 */
import type { UsageBucket, UsageDimensionRow, UsageGranularity, UsageRecord, UsageSummary, UsageTotals } from './types';

type MutableTotals = { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number; totalTokens: number };

function emptyTotals(): MutableTotals {
  return { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 0 };
}

function addTotals(t: MutableTotals, r: UsageRecord): void {
  t.inputTokens += r.inputTokens;
  t.outputTokens += r.outputTokens;
  t.cacheReadTokens += r.cacheReadTokens;
  t.cacheWriteTokens += r.cacheWriteTokens;
  t.totalTokens += r.inputTokens + r.outputTokens + r.cacheReadTokens + r.cacheWriteTokens;
}

function finalize(t: MutableTotals): UsageTotals {
  const { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, totalTokens } = t;
  return { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, totalTokens };
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

/** 桶键（本地时区） */
export function bucketKey(ts: string, granularity: UsageGranularity): string {
  const d = new Date(ts);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  const h = String(d.getHours()).padStart(2, '0');
  switch (granularity) {
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

/** 汇总：桶序列（升序）+ 平台/模型透视 + 全局总计 */
export function summarize(
  records: UsageRecord[],
  granularity: UsageGranularity,
  sources: ScanSourceInfo[],
  generatedAt = new Date().toISOString()
): UsageSummary {
  const grand = emptyTotals();
  const buckets = new Map<string, MutableTotals & { records: number }>();
  const byPlatform = new Map<string, MutableTotals>();
  const byModel = new Map<string, MutableTotals>();

  for (const r of records) {
    addTotals(grand, r);
    const key = bucketKey(r.ts, granularity);
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
        return { platform: platform as UsageRecord['platform'], model: model ?? 'unknown', ...finalize(t) };
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
