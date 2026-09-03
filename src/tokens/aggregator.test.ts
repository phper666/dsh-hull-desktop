import { test } from 'node:test';
import { equal, deepEqual } from 'node:assert/strict';

import { bucketKey, getRangeWindow, isoWeekKey, summarize } from './aggregator';
import type { ScanSourceInfo } from './aggregator';
import type { CustomRange, UsageRecord } from './types';

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

test('getRangeWindow：day/week/month/total 双边界（本地时区日历窗口）', () => {
  const now = new Date(2026, 8, 2, 12, 45); // 本地 2026-09-02（周三）12:45
  const day = getRangeWindow('day', now);
  equal(day.fromMs, new Date(2026, 8, 2).getTime());
  equal(day.toMs, new Date(2026, 8, 2, 23, 59, 59, 999).getTime());
  const week = getRangeWindow('week', now);
  equal(week.fromMs, new Date(2026, 7, 31).getTime(), '本周一 2026-08-31'); // 周三 − 2 天
  equal(week.toMs, new Date(2026, 8, 2, 23, 59, 59, 999).getTime());
  const month = getRangeWindow('month', now);
  equal(month.fromMs, new Date(2026, 8, 1).getTime());
  equal(month.toMs, new Date(2026, 8, 30, 23, 59, 59, 999).getTime(), '月末 9/30');
  const total = getRangeWindow('total', now);
  equal(total.fromMs, new Date(2024, 9, 1).getTime(), '24 个月窗口：2024-10-01（本月-23 月）');
  equal(total.toMs, new Date(2026, 8, 2, 23, 59, 59, 999).getTime(), 'to 封顶今天');
});

test('getRangeWindow：周日归本周（周一起算，getDay 0 → 前周一）', () => {
  const sun = new Date(2026, 8, 6); // 2026-09-06 周日
  const week = getRangeWindow('week', sun);
  equal(week.fromMs, new Date(2026, 7, 31).getTime(), '周日 − 6 天 = 周一 8/31');
});

test('getRangeWindow：custom 区间 + from>to 交换', () => {
  const now = new Date(2026, 8, 2, 12, 0);
  const c: CustomRange = { from: '2026-09-01', to: '2026-09-05' };
  const w = getRangeWindow('custom', now, c);
  equal(w.fromMs, new Date(2026, 8, 1).getTime());
  equal(w.toMs, new Date(2026, 8, 5, 23, 59, 59, 999).getTime());
  const rev: CustomRange = { from: '2026-09-05', to: '2026-09-01' };
  const wr = getRangeWindow('custom', now, rev);
  equal(wr.fromMs, new Date(2026, 8, 1).getTime(), 'from>to → 交换');
  equal(wr.toMs, new Date(2026, 8, 5, 23, 59, 59, 999).getTime());
  const none = getRangeWindow('custom', now);
  equal(none.fromMs, 0);
  equal(none.toMs, 0, '缺 custom → 空窗');
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

test('范围=五档窗口：day/week/month/total/custom 双边界过滤 + 桶推导', () => {
  const now = new Date(2026, 8, 2, 12, 0); // 本地 2026-09-02 周三 12:00
  const G = now.toISOString();
  const records = [
    rec(L(2026, 8, 2, 9, 0), 'claude-code', 'm1', 100, 10), // 9/2 上午 → day/week/month/total
    rec(L(2026, 8, 2, 14, 0), 'codex', 'm2', 200, 20), // 9/2 下午（now 后、toMs 内）
    rec(L(2026, 8, 1, 10, 0), 'gemini', 'm3', 300, 30), // 9/1 → week/month/total（day 外）
    rec(L(2026, 7, 31, 10, 0), 'dsh', 'm4', 400, 40), // 8/31 周一 → week/total（month 外）
    rec(L(2025, 10, 2, 10, 0), 'dsh', 'm5', 500, 50), // 2025-10 → total 24 个月窗口内（month 外）
    rec(L(2027, 3, 1, 10, 0), 'dsh', 'm6', 600, 60), // 未来 → 全部档 toMs 封顶滤掉
  ];
  const sources: ScanSourceInfo[] = [{ platform: 'claude-code', home: '/x', files: 1, records: 1 }];

  const sD = summarize(records, 'day', sources, G);
  equal(sD.totals.totalTokens, 330, 'day 只含今天 2 条');
  equal(sD.series.length, 2, 'day 序列 hour 2 桶');
  equal(sD.byModel.length, 2);

  const sW = summarize(records, 'week', sources, G);
  equal(sW.totals.totalTokens, 1100, 'week 含 8/31 周一~今天 3 天');
  equal(sW.series.length, 3, 'week 序列 day 3 桶（8/31、9/1、9/2）');

  const sM = summarize(records, 'month', sources, G);
  equal(sM.totals.totalTokens, 660, 'month 只含本月 2 条（8/31 是 8 月 → 滤）');
  equal(sM.series.length, 2, 'month 序列 day 2 桶（9/1、9/2）');
  equal(sM.byPlatform.length, 3);

  const sT = summarize(records, 'total', sources, G);
  equal(sT.totals.totalTokens, 1650, 'total 24 个月含 5 条（未来滤）');
  equal(sT.series.length, 3, 'total 序列 month 3 桶（2025-10、2026-08、2026-09）');
  equal(sT.byPlatform.length, 4);

  const sC = summarize(records, 'custom', sources, G, { from: '2026-08-01', to: '2026-09-02' });
  equal(sC.totals.totalTokens, 1100, 'custom 8/1~9/2 含 4 条（2025-10 与未来滤）');
});

test('custom 跨度自适应桶：≤3 天 hour、≤90 天 day、否则 month', () => {
  const now = new Date(2026, 8, 2, 12, 0);
  const G = now.toISOString();
  const records = [
    rec(L(2026, 8, 2, 9, 0), 'codex', 'm1', 100, 10),
    rec(L(2026, 8, 2, 11, 0), 'codex', 'm2', 200, 20),
    rec(L(2026, 8, 1, 10, 0), 'codex', 'm3', 300, 30),
    rec(L(2026, 6, 1, 10, 0), 'codex', 'm4', 400, 40),
  ];
  const sH = summarize(records, 'custom', [], G, { from: '2026-09-02', to: '2026-09-02' }); // 1 天
  equal(sH.series.length, 2, '≤3 天 → hour 桶');
  deepEqual(sH.series.map((b) => b.bucket), [
    bucketKey(L(2026, 8, 2, 9, 0), 'hour'),
    bucketKey(L(2026, 8, 2, 11, 0), 'hour'),
  ]);
  const sD = summarize(records, 'custom', [], G, { from: '2026-06-15', to: '2026-09-02' }); // 80 天
  equal(sD.series.length, 3, '≤90 天 → day 桶（7/1、9/1、9/2）');
  deepEqual(sD.series.map((b) => b.bucket), [
    bucketKey(L(2026, 6, 1, 10, 0), 'day'),
    bucketKey(L(2026, 8, 1, 10, 0), 'day'),
    bucketKey(L(2026, 8, 2, 9, 0), 'day'),
  ]);
  const sM = summarize(records, 'custom', [], G, { from: '2026-01-01', to: '2026-09-02' }); // >90 天
  equal(sM.series.length, 2, '>90 天 → month 桶（7 月、9 月）');
  deepEqual(sM.series.map((b) => b.bucket), [
    bucketKey(L(2026, 6, 1, 10, 0), 'month'),
    bucketKey(L(2026, 8, 1, 10, 0), 'month'),
  ]);
});

test('toMs 封顶：未来时间戳记录被滤（脏数据不污染窗口）', () => {
  const now = new Date(2026, 8, 2, 12, 0);
  const G = now.toISOString();
  const records = [
    rec(L(2026, 8, 2, 10, 0), 'codex', 'm1', 100, 10), // 今天 → 内
    rec(L(2026, 8, 2, 23, 59), 'codex', 'm2', 200, 20), // 今天 23:59:00 → toMs(23:59:59.999) 内
    rec(L(2027, 1, 1, 0, 0), 'codex', 'm3', 400, 40), // 未来 → 滤
    rec(L(2026, 8, 3, 0, 0), 'codex', 'm4', 800, 80), // 明天 0 点 → toMs 外 → 滤
  ];
  const s = summarize(records, 'day', [], G);
  equal(s.totals.totalTokens, 330, 'day 只含今天 2 条');
  equal(s.byModel.length, 2);
  const sT = summarize(records, 'total', [], G);
  equal(sT.totals.totalTokens, 330, 'total 也滤未来（to 封顶今天）');
  equal(sT.byModel.length, 2);
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

test('total 档：最近 24 个月有界窗口（24 个月前被滤），序列 month 桶', () => {
  const now = new Date(2026, 8, 2, 12, 0); // 本地 2026-09-02 12:00
  const G = now.toISOString();
  const records = [
    rec(L(2026, 8, 2, 10, 0), 'claude-code', 'm1', 100, 10), // 本月（9 月）
    rec(L(2026, 7, 20, 9, 0), 'codex', 'm2', 200, 20), // 8 月
    rec(L(2026, 6, 15, 10, 0), 'gemini', 'm3', 300, 30), // 7 月
    rec(L(2024, 11, 20, 10, 0), 'dsh', 'm4', 400, 40), // 2024-12 → 24 个月窗口内（≥2024-10-01）
    rec(L(2024, 8, 20, 10, 0), 'dsh', 'm5', 500, 50), // 2024-09 → 窗口外（<2024-10-01）→ 滤
  ];
  const s = summarize(records, 'total', [], G);
  equal(s.totals.totalTokens, 1100, 'total 24 个月含 4 条（2024-09 被滤）');
  equal(s.series.length, 4, 'month 桶 4 个（24-12/26-7/26-8/26-9）');
  deepEqual(s.series.map((b) => b.bucket), [
    bucketKey(L(2024, 11, 20, 10, 0), 'month'),
    bucketKey(L(2026, 6, 15, 10, 0), 'month'),
    bucketKey(L(2026, 7, 20, 9, 0), 'month'),
    bucketKey(L(2026, 8, 2, 10, 0), 'month'),
  ]);
  equal(s.series[0].totalTokens, 440);
  equal(s.series[3].totalTokens, 110);
  equal(s.byModel.length, 4);
  equal(s.byPlatform.length, 4);
  // range 窗口边界断言
  equal(s.range.from, new Date(2024, 9, 1).toISOString());
  equal(s.range.to, new Date(2026, 8, 2, 23, 59, 59, 999).toISOString());
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
