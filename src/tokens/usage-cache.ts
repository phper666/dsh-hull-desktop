/**
 * Token 小时桶持久化缓存（Token 视图 v2.1 §五 B——准确率/性能根治）：
 * - 写时算对：全量 scanAllSources → buildBuckets（platform::model::hourKey 累加）→ 落盘
 * - 读时快：平台组合指纹（per-file fileFingerprint 排序后 sha256）命中 → 桶直接还原 records，不重扫
 * - 源文件任何变化（增/删/改）→ 指纹变 → 自动重扫；CACHE_VERSION bump → 缓存自动失效
 * - 还原的 records ts 精度只到小时（查询聚合按桶求和不受影响）
 * 纯模块（node fs），不依赖 aggregator（并行 Lane A 在改）；集成由 TokenUsageIpc 调用 loadOrScan。
 */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';

import type { PlatformSource, UsageRecord } from './types';
import { fileFingerprint } from './adapters/shared';
import { scanAllSources } from './TokenUsageScanner';

/** 聚合逻辑改版时 bump → 旧缓存自动失效重扫 */
export const CACHE_VERSION = 1;

export interface BucketTotals {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  reasoningTokens: number;
}

export interface TokenBucketCache {
  version: number;
  generatedAt: string;
  /** key = `${platform}::${model}::${hourKey}`，hourKey = 'YYYY-MM-DD HH:00'（本地时区） */
  buckets: Record<string, BucketTotals>;
  /** platform → 组合指纹（该平台全部源文件的 fileFingerprint 排序后 sha256） */
  fingerprints: Record<string, string>;
}

/** hourKey（本地时区）：与 aggregator bucketKey(ts,'hour') 格式对齐（自行实现，不 import aggregator——并行 Lane A 在改） */
function hourKey(ts: string): string {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return '';
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  const h = String(d.getHours()).padStart(2, '0');
  return `${y}-${m}-${day} ${h}:00`;
}

/** 'YYYY-MM-DD HH:00'（本地时区）→ ISO 字符串；解析失败 → null */
function hourToIso(hour: string): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):00$/.exec(hour);
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]));
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/** 从 UsageRecord[] 建桶（纯函数）：同 platform::model::hour 合并累加五项 token */
export function buildBuckets(records: UsageRecord[]): Record<string, BucketTotals> {
  const buckets: Record<string, BucketTotals> = {};
  for (const r of records) {
    const hk = hourKey(r.ts);
    if (!hk) continue; // 无效时间戳 → 跳过
    const key = `${r.platform}::${r.model}::${hk}`;
    const b = buckets[key] ?? { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 };
    b.inputTokens += r.inputTokens;
    b.outputTokens += r.outputTokens;
    b.cacheReadTokens += r.cacheReadTokens;
    b.cacheWriteTokens += r.cacheWriteTokens;
    b.reasoningTokens += r.reasoningTokens || 0;
    buckets[key] = b;
  }
  return buckets;
}

/** 平台组合指纹：per-file fileFingerprint 排序后 sha256；空文件列表 → 'empty' */
export function platformFingerprint(platform: string, files: string[]): string {
  if (files.length === 0) return 'empty';
  const fps = files.map((f) => fileFingerprint(f)).sort();
  return createHash('sha256').update(`${platform}:${fps.join(',')}`).digest('hex');
}

function fingerprintsEqual(a: Record<string, string>, b: Record<string, string>): boolean {
  const ka = Object.keys(a);
  if (ka.length !== Object.keys(b).length) return false;
  return ka.every((k) => b[k] !== undefined && b[k] === a[k]);
}

/** 桶 → UsageRecord[]（ts=hourKey 解析回 ISO，精度到小时；platform/model 从 key 拆） */
function bucketsToRecords(buckets: Record<string, BucketTotals>): UsageRecord[] {
  const out: UsageRecord[] = [];
  for (const [key, t] of Object.entries(buckets)) {
    const i1 = key.indexOf('::');
    if (i1 < 0) continue;
    const i2 = key.indexOf('::', i1 + 2);
    if (i2 < 0) continue;
    const ts = hourToIso(key.slice(i2 + 2));
    if (!ts) continue;
    out.push({ ts, platform: key.slice(0, i1) as UsageRecord['platform'], model: key.slice(i1 + 2, i2), ...t });
  }
  return out;
}

/** 读缓存 JSON：缺失/损坏 JSON/版本不符/结构不符 → null（视为无缓存） */
export function readCache(cachePath: string): TokenBucketCache | null {
  try {
    const raw = readFileSync(cachePath, 'utf8');
    const j = JSON.parse(raw) as TokenBucketCache;
    if (!j || typeof j !== 'object') return null;
    if (j.version !== CACHE_VERSION) return null;
    if (!j.buckets || typeof j.buckets !== 'object' || !j.fingerprints || typeof j.fingerprints !== 'object') return null;
    return j;
  } catch {
    return null;
  }
}

/** 写缓存 JSON（覆盖） */
export function writeCache(cachePath: string, cache: TokenBucketCache): void {
  writeFileSync(cachePath, JSON.stringify(cache), 'utf8');
}

/**
 * 主入口：全部平台指纹与缓存一致 → 从桶还原 records（fromCache=true）；
 * 任一指纹不符/缓存缺失/损坏/版本不符 → scanAllSources 重建桶 → 落盘（fromCache=false）。
 */
export function loadOrScan(cachePath: string, sources: PlatformSource[]): { records: UsageRecord[]; fromCache: boolean } {
  const fpMap: Record<string, string> = {};
  for (const src of sources) {
    fpMap[src.platform] = platformFingerprint(src.platform, src.listFiles());
  }
  const cache = readCache(cachePath);
  if (cache && fingerprintsEqual(cache.fingerprints, fpMap)) {
    return { records: bucketsToRecords(cache.buckets), fromCache: true };
  }
  const { records } = scanAllSources(sources);
  const newCache: TokenBucketCache = {
    version: CACHE_VERSION,
    generatedAt: new Date().toISOString(),
    buckets: buildBuckets(records),
    fingerprints: fpMap,
  };
  writeCache(cachePath, newCache);
  return { records, fromCache: false };
}
