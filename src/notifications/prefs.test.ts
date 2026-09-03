/**
 * 通知偏好策略单测（V2b §八）：按源开关 + 免打扰时段（含跨午夜）。
 * shouldSystemPush 只约束系统通知；中心存储/未读语义不受影响。
 */
import { test } from 'node:test';
import { equal, ok } from 'node:assert/strict';

import { DEFAULT_NOTIF_PREFS, inDndWindow, normalizeNotifPrefs, shouldSystemPush, type NotifPrefs } from './prefs';

const at = (h: number, m: number) => new Date(2026, 8, 3, h, m, 0, 0);

test('normalizeNotifPrefs：合法透传 / 非法回退默认（布尔/时段格式/时:分范围）', () => {
  const raw = { systemPushWorkflow: false, systemPushBoardExec: true, dndEnabled: true, dndFrom: '23:30', dndTo: '07:15' };
  const p = normalizeNotifPrefs(raw);
  equal(p.systemPushWorkflow, false);
  equal(p.dndEnabled, true);
  equal(p.dndFrom, '23:30');
  equal(p.dndTo, '07:15');

  const bad = normalizeNotifPrefs({ systemPushWorkflow: 'yes', dndFrom: '24:99', dndTo: '7:00', dndEnabled: 1 });
  deepEqualLike(bad, DEFAULT_NOTIF_PREFS);
  const junk = normalizeNotifPrefs(null);
  deepEqualLike(junk, DEFAULT_NOTIF_PREFS);
});

function deepEqualLike(a: NotifPrefs, b: NotifPrefs): void {
  ok(JSON.stringify(a) === JSON.stringify(b), `${JSON.stringify(a)} ≈ ${JSON.stringify(b)}`);
}

test('inDndWindow：常规区间 / 跨午夜 / 边界含头不含尾', () => {
  equal(inDndWindow(22 * 60 + 30, '22:00', '08:00'), true, '22:30 ∈ 跨午夜 DND（22:00→次日 08:00）');
  equal(inDndWindow(23 * 60 + 59, '22:00', '08:00'), true, '23:59 ∈ 跨午夜 DND');
  equal(inDndWindow(7 * 60 + 59, '22:00', '08:00'), true, '07:59 ∈ 跨午夜 DND');
  equal(inDndWindow(12 * 60, '22:00', '08:00'), false, '12:00 不在跨午夜区间');
  equal(inDndWindow(9 * 60, '22:00', '08:00'), false, '09:00 不在跨午夜区间');
  equal(inDndWindow(23 * 60 + 59, '23:30', '07:15'), true);
  equal(inDndWindow(7 * 60 + 14, '23:30', '07:15'), true);
  equal(inDndWindow(7 * 60 + 15, '23:30', '07:15'), false, '尾点不含');
  equal(inDndWindow(23 * 60 + 30, '23:30', '07:15'), true, '头点含');
  equal(inDndWindow(12 * 60, '11:00', '13:00'), true, '常规区间内');
  equal(inDndWindow(14 * 60, '11:00', '13:00'), false);
});

test('shouldSystemPush：源开关 + DND 组合（storage/未读不受影响由调用方保证）', () => {
  const base: NotifPrefs = { systemPushWorkflow: true, systemPushBoardExec: true, dndEnabled: false, dndFrom: '22:00', dndTo: '08:00' };
  equal(shouldSystemPush('workflow', base, at(10, 0)), true);
  equal(shouldSystemPush('workflow', { ...base, systemPushWorkflow: false }, at(10, 0)), false, '源开关关闭');
  equal(shouldSystemPush('board-exec', { ...base, systemPushBoardExec: false }, at(10, 0)), false, '只影响对应源');
  equal(shouldSystemPush('workflow', { ...base, dndEnabled: true }, at(23, 0)), false, 'DND 内不推');
  equal(shouldSystemPush('workflow', { ...base, dndEnabled: true }, at(9, 0)), true, 'DND 外照推（09:00 不在 22:00→08:00）');
  equal(shouldSystemPush('board-exec', { ...base, dndEnabled: true, dndFrom: '11:00', dndTo: '13:00' }, at(12, 0)), false, '常规 DND');
});
