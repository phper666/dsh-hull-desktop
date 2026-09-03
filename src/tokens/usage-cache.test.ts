import { test } from 'node:test';
import { equal, ok, deepEqual } from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { buildBuckets, platformFingerprint, readCache, writeCache, loadOrScan, CACHE_VERSION } from './usage-cache';
import type { PlatformSource, UsageRecord, TokenPlatform } from './types';

const rec = (ts: string, platform: TokenPlatform, model: string, inputTokens: number, outputTokens: number, cacheReadTokens = 0, cacheWriteTokens = 0, reasoningTokens = 0): UsageRecord => ({
  ts, platform, model, inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, reasoningTokens,
});

/** 本地时间构造（hourKey 本地时区，避免 UTC 边界坑） */
const L = (h: number, mi = 0) => new Date(2026, 8, 2, h, mi).toISOString();

/** 手写 PlatformSource fixture：readFile 读 JSON 数组文件 → parseFile 展开 */
function recSource(platform: TokenPlatform, files: string[]): PlatformSource {
  return {
    platform,
    home: `/fixture/${platform}`,
    listFiles: () => files,
    readFile: (f) => readFileSync(f, 'utf8'),
    parseFile: (text) => {
      const arr = JSON.parse(text) as Array<{ ts: string; model: string; input: number; output: number; reasoning?: number }>;
      return arr.map((e) => rec(e.ts, platform, e.model, e.input, e.output, 0, 0, e.reasoning ?? 0));
    },
  };
}

test('buildBuckets：同 hour 同 model 合并累加；不同 hour/model 分桶；hourKey 本地时区格式', () => {
  const b = buildBuckets([
    rec(L(12, 10), 'zcode', 'm1', 100, 10, 5, 1, 2),
    rec(L(12, 50), 'zcode', 'm1', 50, 5, 0, 0, 0),
    rec(L(13, 5), 'zcode', 'm1', 7, 1, 0, 0, 0),
    rec(L(12, 20), 'claude-code', 'm2', 200, 20, 0, 0, 0),
  ]);
  equal(Object.keys(b).length, 3, '同 hour 同 model 合并为 1 桶');
  deepEqual(b['zcode::m1::2026-09-02 12:00'], { inputTokens: 150, outputTokens: 15, cacheReadTokens: 5, cacheWriteTokens: 1, reasoningTokens: 2 });
  deepEqual(b['zcode::m1::2026-09-02 13:00'], { inputTokens: 7, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 });
  deepEqual(b['claude-code::m2::2026-09-02 12:00'], { inputTokens: 200, outputTokens: 20, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 });
  equal(Object.keys(buildBuckets([])).length, 0, '空 records → 空桶');
  equal(Object.keys(buildBuckets([rec('not-a-date', 'zcode', 'm', 1, 1)])).length, 0, '无效时间戳跳过');
});

test('platformFingerprint：同文件集稳定（排序无关）；文件变化变；空集 empty', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hull-uc-fp-'));
  try {
    const f1 = join(dir, 'a.jsonl');
    const f2 = join(dir, 'b.jsonl');
    writeFileSync(f1, 'x');
    writeFileSync(f2, 'y');
    const a = platformFingerprint('zcode', [f1, f2]);
    equal(a, platformFingerprint('zcode', [f2, f1]), '文件顺序无关');
    equal(a, platformFingerprint('zcode', [f1, f2]), '重复调用稳定');
    equal(platformFingerprint('zcode', []), 'empty', '空集 → empty');
    // 文件内容变化（size 必然变）→ 指纹变
    writeFileSync(f1, 'xxxxxxxxxxxxxxxx');
    ok(a !== platformFingerprint('zcode', [f1, f2]), '文件内容变化 → 指纹变');
    // 新增文件 → 指纹变
    const f3 = join(dir, 'c.jsonl');
    writeFileSync(f3, 'z');
    ok(a !== platformFingerprint('zcode', [f1, f2, f3]), '新增文件 → 指纹变');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('readCache/writeCache：往返合法；缺失/损坏/版本不符 → null', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hull-uc-rw-'));
  try {
    const p = join(dir, 'cache.json');
    equal(readCache(p), null, '缺失 → null');
    writeFileSync(p, '{broken');
    equal(readCache(p), null, '损坏 JSON → null');
    writeFileSync(p, JSON.stringify({ version: CACHE_VERSION, generatedAt: 't', buckets: { k: { inputTokens: 1, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 } }, fingerprints: { zcode: 'empty' } }));
    const c = readCache(p);
    ok(c, '合法 → 返回');
    equal(c?.buckets['k']?.inputTokens, 1);
    equal(c?.fingerprints['zcode'], 'empty');
    // 版本不符 → null
    writeFileSync(p, JSON.stringify({ version: CACHE_VERSION + 1, generatedAt: 't', buckets: {}, fingerprints: {} }));
    equal(readCache(p), null, '版本不符 → null');
    // writeCache 往返
    const p2 = join(dir, 'cache2.json');
    const cache = { version: CACHE_VERSION, generatedAt: 't', buckets: {}, fingerprints: { zcode: 'empty' } };
    writeCache(p2, cache);
    deepEqual(readCache(p2), cache);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('loadOrScan：首扫落盘（fromCache=false）→ 指纹未变二扫命中（fromCache=true，桶还原精度内）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hull-uc-l1-'));
  try {
    const cachePath = join(dir, 'cache.json');
    const srcDir = join(dir, 'src');
    mkdirSync(srcDir, { recursive: true });
    const f = join(srcDir, 'sessions.jsonl');
    writeFileSync(f, JSON.stringify([{ ts: L(12, 15), model: 'm1', input: 100, output: 10 }]));
    const sources = [recSource('zcode', [f])];

    const first = loadOrScan(cachePath, sources);
    equal(first.fromCache, false, '首扫无缓存 → 重扫');
    equal(first.records.length, 1);
    equal(first.records[0].inputTokens, 100);
    equal(first.records[0].ts, L(12, 15));
    ok(existsSync(cachePath), '落盘');

    const second = loadOrScan(cachePath, sources);
    equal(second.fromCache, true, '指纹未变 → 命中缓存');
    equal(second.records.length, 1);
    equal(second.records[0].platform, 'zcode');
    equal(second.records[0].model, 'm1');
    equal(second.records[0].inputTokens, 100, '桶还原精度内等价');
    equal(second.records[0].ts, L(12, 0), 'ts 精度截断到小时');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('loadOrScan：源文件变化（追加记录）→ 指纹变 → 重扫', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hull-uc-l2-'));
  try {
    const cachePath = join(dir, 'cache.json');
    const srcDir = join(dir, 'src');
    mkdirSync(srcDir, { recursive: true });
    const f = join(srcDir, 'sessions.jsonl');
    writeFileSync(f, JSON.stringify([{ ts: L(12, 0), model: 'm1', input: 100, output: 10 }]));
    const sources = [recSource('zcode', [f])];

    equal(loadOrScan(cachePath, sources).fromCache, false);
    writeFileSync(f, JSON.stringify([
      { ts: L(12, 0), model: 'm1', input: 100, output: 10 },
      { ts: L(13, 0), model: 'm2', input: 50, output: 5 },
    ]));
    const third = loadOrScan(cachePath, sources);
    equal(third.fromCache, false, '源变化 → 重扫');
    equal(third.records.length, 2);
    // 新状态再次命中
    equal(loadOrScan(cachePath, sources).fromCache, true);
    equal(loadOrScan(cachePath, sources).records.length, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('loadOrScan：缓存损坏 / CACHE_VERSION 不符 → 重扫', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hull-uc-l3-'));
  try {
    const cachePath = join(dir, 'cache.json');
    const srcDir = join(dir, 'src');
    mkdirSync(srcDir, { recursive: true });
    const f = join(srcDir, 'sessions.jsonl');
    writeFileSync(f, JSON.stringify([{ ts: L(12, 0), model: 'm1', input: 100, output: 10 }]));
    const sources = [recSource('zcode', [f])];

    equal(loadOrScan(cachePath, sources).fromCache, false);
    writeFileSync(cachePath, '{broken json');
    const damaged = loadOrScan(cachePath, sources);
    equal(damaged.fromCache, false, '缓存损坏 → 重扫');
    equal(damaged.records.length, 1);
    // 版本不符
    writeFileSync(cachePath, JSON.stringify({ version: CACHE_VERSION + 1, generatedAt: 'x', buckets: {}, fingerprints: {} }));
    const wrongVer = loadOrScan(cachePath, sources);
    equal(wrongVer.fromCache, false, '版本不符 → 重扫');
    equal(wrongVer.records.length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('loadOrScan：多平台——任一平台源变化 → 重扫；其余平台指纹不匹配也重扫', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hull-uc-l4-'));
  try {
    const cachePath = join(dir, 'cache.json');
    const d1 = join(dir, 's1');
    const d2 = join(dir, 's2');
    mkdirSync(d1, { recursive: true });
    mkdirSync(d2, { recursive: true });
    const f1 = join(d1, 'a.jsonl');
    const f2 = join(d2, 'b.jsonl');
    writeFileSync(f1, JSON.stringify([{ ts: L(12, 0), model: 'm1', input: 100, output: 10 }]));
    writeFileSync(f2, JSON.stringify([{ ts: L(12, 0), model: 'm2', input: 50, output: 5 }]));
    const sources = [recSource('zcode', [f1]), recSource('claude-code', [f2])];

    const first = loadOrScan(cachePath, sources);
    equal(first.fromCache, false);
    equal(first.records.length, 2);

    // 只改 zcode 源 → 重扫；claude 未变但仍整体重扫（指纹表不一致）
    writeFileSync(f1, JSON.stringify([{ ts: L(12, 0), model: 'm1', input: 999, output: 10 }]));
    const second = loadOrScan(cachePath, sources);
    equal(second.fromCache, false, '任一平台变化 → 重扫');
    equal(second.records.find((r) => r.platform === 'zcode')?.inputTokens, 999);
    // 新状态命中
    equal(loadOrScan(cachePath, sources).fromCache, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
