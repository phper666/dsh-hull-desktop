import { test } from 'node:test';
import { equal, deepEqual } from 'node:assert/strict';

import { bucketKey, isoWeekKey, summarize } from './aggregator';
import type { ScanSourceInfo } from './aggregator';
import type { UsageRecord } from './types';

const rec = (ts: string, platform: UsageRecord['platform'], model: string, inputTokens: number, outputTokens: number, cacheReadTokens = 0, cacheWriteTokens = 0): UsageRecord => ({
  ts, platform, model, inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, reasoningTokens: 0,
});

test('桶键：min10/hour/day/month', () => {
  equal(bucketKey('2026-08-30T14:23:00+08:00', 'min10'), '2026-08-30 14:20');
  equal(bucketKey('2026-08-30T14:59:00+08:00', 'min10'), '2026-08-30 14:50');
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

test('汇总：总计/透视/序列与排序（day 范围 → hour 桶，24h 窗口）', () => {
  const records = [
    rec('2026-08-30T09:00:00+08:00', 'claude-code', 'claude-sonnet-4-5', 1000, 200, 300, 100),
    rec('2026-08-30T10:00:00+08:00', 'claude-code', 'claude-sonnet-4-5', 500, 100),
    rec('2026-08-30T09:30:00+08:00', 'codex', 'gpt-5.2', 2000, 400),
    rec('2026-08-29T23:00:00+08:00', 'dsh', 'deepseek-v4', 100, 50), // 前一天深夜，仍在 24h 窗口内
  ];
  const s = summarize(records, 'day', [{ platform: 'claude-code', home: '/x', files: 2, records: 2 }], '2026-08-30T02:00:00Z');
  // 总计（全部 4 条在 24h 窗口内）
  equal(s.totals.inputTokens, 3600);
  equal(s.totals.outputTokens, 750);
  equal(s.totals.cacheReadTokens, 300);
  equal(s.totals.cacheWriteTokens, 100);
  equal(s.totals.totalTokens, 4750);
  // 序列（hour 桶，升序）：前夜 23:00 → 09:00（claude+codex 合并）→ 10:00
  deepEqual(s.series.map((b) => b.bucket), [
    bucketKey('2026-08-29T23:00:00+08:00', 'hour'),
    bucketKey('2026-08-30T09:00:00+08:00', 'hour'),
    bucketKey('2026-08-30T10:00:00+08:00', 'hour'),
  ]);
  equal(s.series[0].totalTokens, 150);
  equal(s.series[1].totalTokens, 4000);
  equal(s.series[2].totalTokens, 600);
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

test('粒度=时间范围：hour/day/month/year 窗口过滤 + 桶推导', () => {
  const G = '2026-09-02T12:00:00Z';
  const records = [
    rec('2026-09-02T11:00:00Z', 'claude-code', 'm1', 100, 10), // 近 1h
    rec('2026-08-31T12:00:00Z', 'codex', 'm2', 200, 20), // 近 2 天
    rec('2026-07-24T12:00:00Z', 'dsh', 'm3', 300, 30), // 40 天前（month=30d 外、year 内）
  ];
  const sources: ScanSourceInfo[] = [{ platform: 'claude-code', home: '/x', files: 1, records: 1 }];

  const sH = summarize(records, 'hour', sources, G);
  equal(sH.totals.totalTokens, 110, 'hour 只含近 1h 1 条');
  equal(sH.series.length, 1, 'hour 序列 min10 1 桶');
  equal(sH.byModel.length, 1, 'hour 透视只含 1 模型');

  const sD = summarize(records, 'day', sources, G);
  equal(sD.totals.totalTokens, 110, 'day 只含近 24h 1 条');
  equal(sD.series.length, 1, 'day 序列 hour 1 桶');

  const sM = summarize(records, 'month', sources, G);
  equal(sM.totals.totalTokens, 330, 'month 含近 30d 2 条（40 天前被滤）');
  equal(sM.series.length, 2, 'month 序列 day 2 桶');
  equal(sM.byPlatform.length, 2);

  const sY = summarize(records, 'year', sources, G);
  equal(sY.totals.totalTokens, 660, 'year 含全部 3 条');
  equal(sY.series.length, 3, 'year 序列 month 3 桶（9/8/7 月各 1 条）');
  equal(sY.byPlatform.length, 3);
});

test('hour 范围：跨 40 分钟 → min10 多桶 + 只含近 1h', () => {
  const G = '2026-09-02T12:00:00Z';
  const records = [
    rec('2026-09-02T11:55:00Z', 'claude-code', 'm1', 100, 10), // 5 分钟前
    rec('2026-09-02T11:30:00Z', 'codex', 'm2', 200, 20), // 30 分钟前
    rec('2026-09-02T10:00:00Z', 'dsh', 'm3', 400, 40), // 2 小时前 → 范围外
  ];
  const s = summarize(records, 'hour', [], G);
  equal(s.totals.totalTokens, 330, 'hour 只含近 1h 2 条');
  equal(s.series.length, 2, 'min10 桶 2 个（11:50 + 11:30）');
  deepEqual(s.series.map((b) => b.bucket), [
    bucketKey('2026-09-02T11:30:00Z', 'min10'),
    bucketKey('2026-09-02T11:55:00Z', 'min10'),
  ]);
  equal(s.series[0].totalTokens, 220);
  equal(s.series[1].totalTokens, 110);
});

test('day 范围：hour 桶 + 只含近 24h', () => {
  const G = '2026-09-02T12:00:00Z';
  const records = [
    rec('2026-09-02T11:00:00Z', 'claude-code', 'm1', 100, 10), // 1 小时前
    rec('2026-09-01T13:00:00Z', 'codex', 'm2', 200, 20), // 23 小时前 → 24h 内
    rec('2026-09-01T11:00:00Z', 'dsh', 'm3', 400, 40), // 25 小时前 → 范围外
  ];
  const s = summarize(records, 'day', [], G);
  equal(s.totals.totalTokens, 330, 'day 只含近 24h 2 条');
  equal(s.series.length, 2, 'hour 桶 2 个');
  deepEqual(s.series.map((b) => b.bucket), [
    bucketKey('2026-09-01T13:00:00Z', 'hour'),
    bucketKey('2026-09-02T11:00:00Z', 'hour'),
  ]);
  equal(s.series[0].totalTokens, 220);
  equal(s.series[1].totalTokens, 110);
});
