import { test } from 'node:test';
import { equal, deepEqual } from 'node:assert/strict';

import { bucketKey, isoWeekKey, rangeCutoffMs, summarize } from './aggregator';
import type { ScanSourceInfo } from './aggregator';
import type { UsageRecord } from './types';

const rec = (ts: string, platform: UsageRecord['platform'], model: string, inputTokens: number, outputTokens: number, cacheReadTokens = 0, cacheWriteTokens = 0): UsageRecord => ({
  ts, platform, model, inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, reasoningTokens: 0,
});

/** 本地时间构造（与日历对齐语义同时区，避免 UTC 边界坑） */
const L = (y: number, mo: number, d: number, h = 0, mi = 0) => new Date(y, mo, d, h, mi).toISOString();

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

test('rangeCutoffMs：日历对齐边界（本地时区整点/0 点/1 号/1/1）', () => {
  const now = new Date(2026, 8, 2, 12, 45); // 本地 2026-09-02 12:45
  equal(rangeCutoffMs('hour', now), new Date(2026, 8, 2, 12, 0).getTime());
  equal(rangeCutoffMs('day', now), new Date(2026, 8, 2).getTime());
  equal(rangeCutoffMs('month', now), new Date(2026, 8, 1).getTime());
  equal(rangeCutoffMs('year', now), new Date(2026, 0, 1).getTime());
  equal(rangeCutoffMs('all', now), 0, 'all 不过滤');
});

test('汇总：总计/透视/序列与排序（day 范围 → 今天 hour 桶）', () => {
  const now = new Date(2026, 8, 2, 18, 0); // 本地 2026-09-02 18:00
  const records = [
    rec(L(2026, 8, 2, 9, 0), 'claude-code', 'claude-sonnet-4-5', 1000, 200, 300, 100),
    rec(L(2026, 8, 2, 10, 0), 'claude-code', 'claude-sonnet-4-5', 500, 100),
    rec(L(2026, 8, 2, 9, 30), 'codex', 'gpt-5.2', 2000, 400),
    rec(L(2026, 8, 2, 17, 30), 'dsh', 'deepseek-v4', 100, 50), // 今天下午，仍在 day 内
  ];
  const s = summarize(records, 'day', [{ platform: 'claude-code', home: '/x', files: 2, records: 2 }], now.toISOString());
  // 总计（全部 4 条在「今天 0 点后」内）
  equal(s.totals.inputTokens, 3600);
  equal(s.totals.outputTokens, 750);
  equal(s.totals.cacheReadTokens, 300);
  equal(s.totals.cacheWriteTokens, 100);
  equal(s.totals.totalTokens, 4750);
  // 序列（hour 桶，升序）：09:00（claude+codex 合并）→ 10:00 → 17:30
  deepEqual(s.series.map((b) => b.bucket), [
    bucketKey(L(2026, 8, 2, 9, 0), 'hour'),
    bucketKey(L(2026, 8, 2, 10, 0), 'hour'),
    bucketKey(L(2026, 8, 2, 17, 30), 'hour'),
  ]);
  equal(s.series[0].totalTokens, 4000);
  equal(s.series[1].totalTokens, 600);
  equal(s.series[2].totalTokens, 150);
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

test('粒度=日历范围：hour/day/month/year 边界过滤 + 桶推导', () => {
  const now = new Date(2026, 8, 2, 12, 0); // 本地 2026-09-02 12:00
  const G = now.toISOString();
  const records = [
    rec(L(2026, 8, 2, 12, 30), 'claude-code', 'm1', 100, 10), // 本小时（12 点整点后）
    rec(L(2026, 8, 2, 9, 30), 'codex', 'm2', 200, 20), // 今天上午（hour 外、day 内）
    rec(L(2026, 8, 1, 10, 0), 'gemini', 'm3', 300, 30), // 昨天（day 外、month 内）
    rec(L(2026, 7, 2, 10, 0), 'dsh', 'm4', 400, 40), // 上月（month 外、year 内）
  ];
  const sources: ScanSourceInfo[] = [{ platform: 'claude-code', home: '/x', files: 1, records: 1 }];

  const sH = summarize(records, 'hour', sources, G);
  equal(sH.totals.totalTokens, 110, 'hour 只含本小时（12:30）');
  equal(sH.series.length, 1, 'hour 序列 min10 1 桶');
  equal(sH.byModel.length, 1, 'hour 透视只含 1 模型');

  const sD = summarize(records, 'day', sources, G);
  equal(sD.totals.totalTokens, 330, 'day 含今天全部 2 条（昨天被滤）');
  equal(sD.series.length, 2, 'day 序列 hour 2 桶');

  const sM = summarize(records, 'month', sources, G);
  equal(sM.totals.totalTokens, 660, 'month 含本月 3 条（上月被滤）');
  equal(sM.series.length, 2, 'month 序列 day 2 桶（9/2 与 9/1）');
  equal(sM.byPlatform.length, 3);

  const sY = summarize(records, 'year', sources, G);
  equal(sY.totals.totalTokens, 1100, 'year 含全部 4 条');
  equal(sY.series.length, 2, 'year 序列 month 2 桶（9 月与 8 月）');
  equal(sY.byPlatform.length, 4);
});

test('hour 范围：本小时内跨 40 分钟 → min10 多桶 + 上小时记录被滤', () => {
  const now = new Date(2026, 8, 2, 12, 0); // 本地 12:00，hour 边界 = 12:00:00
  const G = now.toISOString();
  const records = [
    rec(L(2026, 8, 2, 12, 5), 'claude-code', 'm1', 100, 10), // 12:00 桶
    rec(L(2026, 8, 2, 12, 30), 'codex', 'm2', 200, 20), // 12:30 桶
    rec(L(2026, 8, 2, 11, 50), 'dsh', 'm3', 400, 40), // 上小时 → 本小时边界外
  ];
  const s = summarize(records, 'hour', [], G);
  equal(s.totals.totalTokens, 330, 'hour 只含本小时 2 条');
  equal(s.series.length, 2, 'min10 桶 2 个（12:00 + 12:30）');
  deepEqual(s.series.map((b) => b.bucket), [
    bucketKey(L(2026, 8, 2, 12, 5), 'min10'),
    bucketKey(L(2026, 8, 2, 12, 30), 'min10'),
  ]);
  equal(s.series[0].totalTokens, 110);
  equal(s.series[1].totalTokens, 220);
});

test('day 范围：hour 桶 + 今天 0 点后（昨天记录被滤）', () => {
  const now = new Date(2026, 8, 2, 12, 0); // 本地 2026-09-02 12:00
  const G = now.toISOString();
  const records = [
    rec(L(2026, 8, 2, 9, 0), 'claude-code', 'm1', 100, 10), // 今天上午 → 内
    rec(L(2026, 8, 2, 11, 0), 'codex', 'm2', 200, 20), // 今天上午 → 内
    rec(L(2026, 8, 1, 23, 0), 'dsh', 'm3', 400, 40), // 昨天 23:00 → 今天 0 点外
  ];
  const s = summarize(records, 'day', [], G);
  equal(s.totals.totalTokens, 330, 'day 只含今天 2 条');
  equal(s.series.length, 2, 'hour 桶 2 个');
  deepEqual(s.series.map((b) => b.bucket), [
    bucketKey(L(2026, 8, 2, 9, 0), 'hour'),
    bucketKey(L(2026, 8, 2, 11, 0), 'hour'),
  ]);
  equal(s.series[0].totalTokens, 110);
  equal(s.series[1].totalTokens, 220);
});

test('all 档：不过滤全部计入（含去年记录），序列 month 桶', () => {
  const now = new Date(2026, 8, 2, 12, 0); // 本地 2026-09-02 12:00
  const G = now.toISOString();
  const records = [
    rec(L(2026, 8, 2, 10, 0), 'claude-code', 'm1', 100, 10), // 本月（9 月）
    rec(L(2026, 7, 20, 9, 0), 'codex', 'm2', 200, 20), // 上月（8 月）
    rec(L(2026, 6, 15, 10, 0), 'gemini', 'm3', 300, 30), // 7 月
    rec(L(2025, 11, 20, 10, 0), 'dsh', 'm4', 400, 40), // 去年 → year 档滤掉、all 保留
  ];
  const s = summarize(records, 'all', [], G);
  equal(s.totals.totalTokens, 1100, 'all 全部 4 条计入（含去年）');
  equal(s.series.length, 4, 'month 桶 4 个（25-11/26-7/26-8/26-9）');
  deepEqual(s.series.map((b) => b.bucket), [
    bucketKey(L(2025, 11, 20, 10, 0), 'month'),
    bucketKey(L(2026, 6, 15, 10, 0), 'month'),
    bucketKey(L(2026, 7, 20, 9, 0), 'month'),
    bucketKey(L(2026, 8, 2, 10, 0), 'month'),
  ]);
  equal(s.series[0].totalTokens, 440);
  equal(s.series[3].totalTokens, 110);
  equal(s.byModel.length, 4);
  equal(s.byPlatform.length, 4);
  // 对照：year 档滤掉去年记录（只 3 条）
  const sY = summarize(records, 'year', [], G);
  equal(sY.totals.totalTokens, 660, 'year 不含去年记录');
});

/* —— 成本（costUsd）语义：全定价 → 数值累加；任一未知 → null —— */
const close = (a: number, b: number) => Math.abs(a - b) < 1e-9;

test('成本：全定价模型 → totals/series/byModel 数值累加（手算）', () => {
  const now = new Date(2026, 8, 2, 12, 0);
  const G = now.toISOString();
  // deepseek-v4-flash（input 0.28 / output 0.42 / cacheRead 0.028 / cacheWrite 0.28，$/1M）
  const records = [
    rec(L(2026, 8, 2, 10, 0), 'codex', 'deepseek-v4-flash', 1_000_000, 500_000, 100_000, 50_000),
    rec(L(2026, 8, 2, 11, 0), 'codex', 'deepseek-v4-flash', 500_000, 250_000),
  ];
  const s = summarize(records, 'day', [], G);
  const c1 = (1e6 * 0.28 + 5e5 * 0.42 + 1e5 * 0.028 + 5e4 * 0.28) / 1e6; // 0.5068
  const c2 = (5e5 * 0.28 + 2.5e5 * 0.42) / 1e6; // 0.245
  close(s.totals.costUsd as number, c1 + c2);
  close(s.byModel[0].costUsd as number, c1 + c2);
  equal(s.series.length, 2);
  close(s.series[0].costUsd as number, c1);
  close(s.series[1].costUsd as number, c2);
  close(s.byPlatform[0].costUsd as number, c1 + c2);
});

test('成本：byPlatform/byModel 全已知 → 跨模型累加（总 0.8068）', () => {
  const now = new Date(2026, 8, 2, 12, 0);
  const G = now.toISOString();
  const records = [
    rec(L(2026, 8, 2, 10, 0), 'codex', 'deepseek-v4-flash', 1e6, 2e5), // 0.28 + 0.084 = 0.364
    rec(L(2026, 8, 2, 11, 0), 'codex', 'glm-5.2', 5e5, 1e5), // 0.30 + 0.24 = 0.54
  ];
  const s = summarize(records, 'day', [], G);
  const c1 = (1e6 * 0.28 + 2e5 * 0.42) / 1e6; // 0.364
  const c2 = (5e5 * 0.6 + 1e5 * 2.4) / 1e6; // 0.54
  close(s.totals.costUsd as number, c1 + c2);
  close(s.byPlatform[0].costUsd as number, c1 + c2);
  // byModel 按 totalTokens 降序：deepseek(1.2M) > glm(0.6M)
  close(s.byModel[0].costUsd as number, c1);
  close(s.byModel[1].costUsd as number, c2);
});

test('成本：混入未知模型 → totals/byPlatform null，series 行级各自语义', () => {
  const now = new Date(2026, 8, 2, 12, 0);
  const G = now.toISOString();
  const records = [
    rec(L(2026, 8, 2, 10, 0), 'codex', 'deepseek-v4-flash', 1000, 500),
    rec(L(2026, 8, 2, 11, 0), 'codex', 'unknown-model-x', 2000, 1000),
  ];
  const s = summarize(records, 'day', [], G);
  equal(s.totals.costUsd, null, '总计含未知 → null');
  equal(s.byPlatform[0].costUsd, null, '平台行混合 → null');
  // byModel 行级：已知模型数值、未知模型 null
  const priced = s.byModel.find((r) => r.model === 'deepseek-v4-flash')!;
  const unknown = s.byModel.find((r) => r.model === 'unknown-model-x')!;
  close(priced.costUsd as number, (1000 * 0.28 + 500 * 0.42) / 1e6);
  equal(unknown.costUsd, null);
  // series 行级：桶 1 数值、桶 2 null
  equal(s.series.length, 2);
  close(s.series[0].costUsd as number, (1000 * 0.28 + 500 * 0.42) / 1e6);
  equal(s.series[1].costUsd, null);
});

test('成本：空记录 → costUsd 0（不误标 null）', () => {
  const s = summarize([], 'month', [], '2026-08-30T23:00:00Z');
  equal(s.totals.costUsd, 0);
  deepEqual(s.series, []);
  deepEqual(s.byPlatform, []);
});
