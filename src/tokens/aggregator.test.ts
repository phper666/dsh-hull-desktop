import { test } from 'node:test';
import { equal, deepEqual } from 'node:assert/strict';

import { bucketKey, isoWeekKey, summarize } from './aggregator';
import type { ScanSourceInfo } from './aggregator';
import type { UsageRecord } from './types';

const rec = (ts: string, platform: UsageRecord['platform'], model: string, inputTokens: number, outputTokens: number, cacheReadTokens = 0, cacheWriteTokens = 0): UsageRecord => ({
  ts, platform, model, inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, reasoningTokens: 0,
});

test('桶键：hour/day/month', () => {
  equal(bucketKey('2026-08-30T14:23:00+08:00', 'hour'), '2026-08-30 14:00');
  equal(bucketKey('2026-08-30T14:23:00+08:00', 'day'), '2026-08-30');
  equal(bucketKey('2026-08-30T14:23:00+08:00', 'month'), '2026-08');
});

test('桶键：ISO 周（周一起始，跨年归属）', () => {
  // 2024-01-04 周四 → 2024-W01；2024-01-01 周一 → 2024-W01；2023-12-31 周日 → 2023-W52
  equal(isoWeekKey(new Date(2024, 0, 4)), '2024-W01');
  equal(isoWeekKey(new Date(2024, 0, 1)), '2024-W01');
  equal(isoWeekKey(new Date(2023, 11, 31)), '2023-W52');
  equal(bucketKey('2024-01-04T10:00:00+08:00', 'week'), '2024-W01');
});

test('汇总：总计/透视/序列与排序', () => {
  const records = [
    rec('2026-08-30T09:00:00+08:00', 'claude-code', 'claude-sonnet-4-5', 1000, 200, 300, 100),
    rec('2026-08-30T10:00:00+08:00', 'claude-code', 'claude-sonnet-4-5', 500, 100),
    rec('2026-08-30T09:30:00+08:00', 'codex', 'gpt-5.2', 2000, 400),
    rec('2026-08-29T09:00:00+08:00', 'dsh', 'deepseek-v4', 100, 50),
  ];
  const s = summarize(records, 'day', [{ platform: 'claude-code', home: '/x', files: 2, records: 2 }], '2026-08-30T23:00:00Z');
  // 总计
  equal(s.totals.inputTokens, 3600);
  equal(s.totals.outputTokens, 750);
  equal(s.totals.cacheReadTokens, 300);
  equal(s.totals.cacheWriteTokens, 100);
  equal(s.totals.totalTokens, 4750);
  // 序列升序：08-29 → 08-30
  deepEqual(s.series.map((b) => b.bucket), ['2026-08-29', '2026-08-30']);
  equal(s.series[1].totalTokens, 4600);
  equal(s.series[0].totalTokens, 150);
  // 平台透视按合计降序：codex 2400 > claude-code 2200 > dsh 150
  equal(s.byPlatform[0].platform, 'codex');
  equal(s.byPlatform[0].totalTokens, 2400);
  equal(s.byPlatform[1].platform, 'claude-code');
  // 模型透视
  equal(s.byModel[0].model, 'gpt-5.2');
  equal(s.byModel.length, 3);
  equal(s.granularity, 'day');
});

test('空记录 → 零总计空序列', () => {
  const s = summarize([], 'month', [], '2026-08-30T23:00:00Z');
  equal(s.totals.totalTokens, 0);
  deepEqual(s.series, []);
  deepEqual(s.byPlatform, []);
});

test('粒度=时间范围：hour/day/month 窗口过滤全视图（总计+序列）', () => {
  const G = '2026-09-02T12:00:00Z';
  const records = [
    rec('2026-09-02T11:00:00Z', 'claude-code', 'm1', 100, 10), // 近 1h
    rec('2026-08-31T12:00:00Z', 'codex', 'm2', 200, 20), // 近 2 天
    rec('2026-07-24T12:00:00Z', 'dsh', 'm3', 300, 30), // 40 天前（月窗口内，日/时窗口外）
  ];
  const sources: ScanSourceInfo[] = [{ platform: 'claude-code', home: '/x', files: 1, records: 1 }];

  const sH = summarize(records, 'hour', sources, G);
  equal(sH.totals.totalTokens, 110, 'hour 只含 24h 内 1 条');
  equal(sH.series.length, 1, 'hour 序列 1 桶');
  equal(sH.byModel.length, 1, 'hour 透视只含 1 模型');

  const sD = summarize(records, 'day', sources, G);
  equal(sD.totals.totalTokens, 330, 'day 含近 2 条、不含 40 天前');
  equal(sD.series.length, 2, 'day 序列 2 桶');

  const sM = summarize(records, 'month', sources, G);
  equal(sM.totals.totalTokens, 660, 'month 含全部 3 条');
  equal(sM.series.length, 3, 'month 序列 3 桶（9月/8月/7月 各 1 条）');
  equal(sM.byPlatform.length, 3);
});
