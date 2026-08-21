/**
 * L2 HeartbeatMonitor 单测（B3 design §4.3，Q-026/E31）
 *
 * - Q-026 活动心跳：text_chunk 活动重置 idle 计时器（非总时长）→ 连续窗口内重置不超时
 * - 连续无活动 → timeout 事件（引擎层 failed("疑似卡死") + kill + exec-timeout-heartbeat 回写）
 * - E31（P1-1）：paused 中不心跳判定（stop 销毁计时器）→ 无 timeout；恢复转 running → 重新绑定新窗口
 */
import { test } from 'node:test';
import { equal, ok } from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';

import { HeartbeatMonitor, type HeartbeatTimeoutEvent } from './HeartbeatMonitor';

/** 注入短窗口（秒级测试，不跑真实 30min） */
function make(seconds: number) {
  const hb = new HeartbeatMonitor({ maxExecutionIdleMinutes: seconds / 60 });
  const timeouts: HeartbeatTimeoutEvent[] = [];
  hb.on('timeout', (e) => timeouts.push(e));
  return { hb, timeouts };
}

/** 确认某任务已绑定计时器（内部 map 只读探测） */
function hasTimer(hb: HeartbeatMonitor, taskId: string): boolean {
  return (hb as unknown as { timers: Map<string, unknown> }).timers.has(taskId);
}

test('E20 连续无活动 → timeout 事件（failed("疑似卡死") 源）', async () => {
  const { hb, timeouts } = make(0.05); // 50ms 窗口
  hb.reset('t_1');
  await sleep(100);
  equal(timeouts.length, 1);
  equal(timeouts[0].taskId, 't_1');
  equal(timeouts[0].idleMinutes, 0.05 / 60);
  // 触发后计时器已销毁（一次触发，非循环）
  equal(hasTimer(hb, 't_1'), false);
  hb.clearAll();
});

test('Q-026 活动心跳重置 idle 计时器（非总时长，持续活动不超时）', async () => {
  const { hb, timeouts } = make(0.1); // 100ms 窗口
  hb.reset('t_1');
  // 每 40ms 活动一次 → 每次重置窗口（连续 <窗口 间隔）→ 总 240ms 远超单窗口但不超时
  for (let i = 0; i < 6; i++) {
    await sleep(40);
    hb.reset('t_1');
  }
  equal(timeouts.length, 0, '持续活动不触发心跳超时');
  equal(hasTimer(hb, 't_1'), true);
  hb.clearAll();
});

test('E31 活动后停止计时（paused/interrupted/succeeded/failed/cancelled）→ 不触发超时', async () => {
  const { hb, timeouts } = make(0.05);
  hb.reset('t_1');
  hb.stop('t_1'); // paused 等迁出 running → 销毁计时器（E31）
  await sleep(100);
  equal(timeouts.length, 0, 'paused 中不心跳判定（P1-1）');
  equal(hasTimer(hb, 't_1'), false);
});

test('E31 恢复/重跑转 running → 重新绑定计时器（全新窗口，非累计）', async () => {
  const { hb, timeouts } = make(0.05);
  hb.reset('t_1');
  hb.stop('t_1');
  await sleep(60);
  equal(timeouts.length, 0, 'stop 期间流逝时间不计入新窗口');
  hb.reset('t_1'); // resumeExecution → 重新绑定（新窗口）
  await sleep(100);
  equal(timeouts.length, 1, '重新绑定后新窗口超时触发');
  equal(timeouts[0].taskId, 't_1');
  hb.clearAll();
});

test('reset 覆盖既有计时器（窗口推窗，非多定时器叠加）', async () => {
  const { hb, timeouts } = make(0.05);
  hb.reset('t_1');
  hb.reset('t_1'); // 覆盖
  hb.reset('t_1');
  equal(hasTimer(hb, 't_1'), true);
  await sleep(100);
  equal(timeouts.length, 1, '覆盖后仅单次触发');
  hb.clearAll();
});

test('stop 幂等：未绑定任务无操作；多任务独立计时', async () => {
  const { hb, timeouts } = make(0.05);
  hb.stop('t_unknown'); // 未绑定 → 无操作不抛
  hb.reset('t_1');
  hb.reset('t_2');
  hb.stop('t_1');
  await sleep(100);
  equal(timeouts.length, 1);
  equal(timeouts[0].taskId, 't_2', '仅未 stop 的任务触发');
  hb.clearAll();
  equal(hb.size, 0);
});

test('默认 maxExecutionIdleMinutes=30（契约 CON-R032）', () => {
  const hb = new HeartbeatMonitor();
  const maxMs = (hb as unknown as { maxIdleMs: number }).maxIdleMs;
  equal(maxMs, 30 * 60_000);
  ok(hasTimer(hb, 'none') === false); // 未 reset 无绑定
});
