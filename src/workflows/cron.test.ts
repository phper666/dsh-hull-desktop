/**
 * cron 解析器单测：5 字段（分 时 日 月 周，本地时区），支持星/逗/横/斜杠语法，vixie DOM/DOW 或语义。
 * 确定性：cronNext 注入 from，断言不依赖当前时间。
 */
import { test } from 'node:test';
import { deepEqual, equal, ok, throws } from 'node:assert/strict';

import { cronNext, parseCron } from './cron';

/** 本地时区 Date 构造辅助（new Date(y,m,d,h,min) 即本地） */
const at = (y: number, m: number, d: number, h = 0, min = 0) => new Date(y, m - 1, d, h, min, 0, 0);
const sameMinute = (a: Date, b: Date) =>
  a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate() && a.getHours() === b.getHours() && a.getMinutes() === b.getMinutes();

// ── parseCron：合法/非法 ──

test('parseCron：合法表达式解析出各字段集合', () => {
  const p = parseCron('*/15 9-18 1,15 * 1-5');
  deepEqual([...p.minutes], [0, 15, 30, 45]);
  deepEqual([...p.hours], [9, 10, 11, 12, 13, 14, 15, 16, 17, 18]);
  deepEqual([...p.doms], [1, 15]);
  deepEqual([...p.months], [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
  deepEqual([...p.dows], [1, 2, 3, 4, 5]);
  equal(p.domRestricted, true);
  equal(p.dowRestricted, true);
});

test('parseCron：* 不受限 + 7 归并为 0（周日）', () => {
  const p = parseCron('0 12 * * 0,7');
  deepEqual([...p.doms], Array.from({ length: 31 }, (_, i) => i + 1));
  equal(p.domRestricted, false);
  deepEqual([...p.dows], [0]);
  equal(p.dowRestricted, true);
});

test('parseCron：字段数/范围/步长/倒序 非法即抛错', () => {
  throws(() => parseCron('* * * *'), /5 个字段/);
  throws(() => parseCron('* * * * * *'), /5 个字段/);
  throws(() => parseCron('60 * * * *'), /分钟/);
  throws(() => parseCron('* 24 * * *'), /小时/);
  throws(() => parseCron('* * 0 * *'), /日/);
  throws(() => parseCron('* * * 13 *'), /月/);
  throws(() => parseCron('* * * * 8'), /星期/);
  throws(() => parseCron('a * * * *'), /非法/);
  throws(() => parseCron('*/0 * * * *'), /步长/);
  throws(() => parseCron('10-5 * * * *'), /范围/);
  throws(() => parseCron(''), /5 个字段/);
});

// ── cronNext：确定性计算 ──

test('cronNext：*/15 向上取整到下一刻度', () => {
  const e = '*/15 * * * *';
  ok(sameMinute(cronNext(e, at(2026, 9, 2, 10, 7)), at(2026, 9, 2, 10, 15)));
  ok(sameMinute(cronNext(e, at(2026, 9, 2, 10, 59)), at(2026, 9, 2, 11, 0)));
});

test('cronNext：严格大于 from（恰在触发点上 → 下一周期）', () => {
  const e = '0 12 * * 0'; // 周日 12:00
  // 2026-09-06 是周日
  ok(sameMinute(cronNext(e, at(2026, 9, 6, 12, 0)), at(2026, 9, 13, 12, 0)));
  ok(sameMinute(cronNext(e, at(2026, 9, 6, 12, 1)), at(2026, 9, 13, 12, 0)));
});

test('cronNext：工作日 1-5 跳过周末', () => {
  const e = '0 9 * * 1-5';
  // 2026-09-05 周六 → 下一个周一 09-07
  ok(sameMinute(cronNext(e, at(2026, 9, 5, 12, 0)), at(2026, 9, 7, 9, 0)));
  // 周五 09-04 09:00 之后 → 下周一
  ok(sameMinute(cronNext(e, at(2026, 9, 4, 9, 0)), at(2026, 9, 7, 9, 0)));
});

test('cronNext：跨年月（每年 3 月 1 日）', () => {
  const e = '0 0 1 3 *';
  ok(sameMinute(cronNext(e, at(2026, 9, 2, 8, 0)), at(2027, 3, 1, 0, 0)));
});

test('cronNext：2 月 29 日（平年跳过，闰年命中）', () => {
  const e = '30 14 29 2 *';
  ok(sameMinute(cronNext(e, at(2026, 9, 2)), at(2028, 2, 29, 14, 30)));
});

test('cronNext：年末最后一刻', () => {
  const e = '59 23 31 12 *';
  ok(sameMinute(cronNext(e, at(2026, 1, 1, 0, 0)), at(2026, 12, 31, 23, 59)));
});

test('cronNext：DOM/DOW 同时受限 = 或语义（vixie cron）', () => {
  const e = '0 0 13 * 5'; // 每月 13 号 或 周五
  // 2026-09-01（周二）→ 最近的是周五 09-04（早于 13 号周日）
  ok(sameMinute(cronNext(e, at(2026, 9, 1, 0, 0)), at(2026, 9, 4, 0, 0)));
  // 从 09-04 起 → 下一命中 09-11（周五，早于 13 号）
  ok(sameMinute(cronNext(e, at(2026, 9, 4, 0, 1)), at(2026, 9, 11, 0, 0)));
  // 09-11 起 → 13 号周日
  ok(sameMinute(cronNext(e, at(2026, 9, 11, 0, 1)), at(2026, 9, 13, 0, 0)));
});

test('cronNext：分钟边界（23:59 → 次日 00:00）', () => {
  const e = '7 6 * * *';
  ok(sameMinute(cronNext(e, at(2026, 8, 31, 23, 59)), at(2026, 9, 1, 6, 7)));
});
