/**
 * L1 MockProvider 接口级内存桩单测（MockProvider.ts）
 * 确定性事件注入：success(selfCheck true/false)/permission/stream(流式心跳)/timeout/cancel
 * 可控延迟（P2-B3-1）：delayMs 保证并行峰值 ≥2（L2 E13 用）
 */
import { test } from 'node:test';
import { equal, ok } from 'node:assert/strict';

import { MockProvider } from './MockProvider';
import type { ExecutionEvent, ExecutionResult } from './ExecutionProvider';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test('mock success（默认）：running→result→succeeded，selfCheck passed=true', async () => {
  const statuses: string[] = [];
  let result: ExecutionResult | undefined;
  const provider = new MockProvider();
  provider.execute(
    { taskId: 't_1', title: 't' },
    {
      onStatus: (s) => statuses.push(s),
      onEvent: () => {},
      onResult: (r) => (result = r),
    },
  );
  await sleep(5);
  equal(statuses.join(','), 'running,succeeded');
  equal(result?.exitCode, 0);
  equal(result?.selfCheck?.passed, true);
});

test('mock selfCheck passed=false：selfCheck 原样回传（passed=false 数据，E12 语义归引擎 VerifyGate）', async () => {
  const statuses: string[] = [];
  let result: ExecutionResult | undefined;
  const provider = new MockProvider({ outcome: { kind: 'success', selfCheck: { passed: false } } });
  provider.execute(
    { taskId: 't_1', title: 't' },
    { onStatus: (s) => statuses.push(s), onEvent: () => {}, onResult: (r) => (result = r) },
  );
  await sleep(5);
  // 通道侧成功回执（exitCode 0 + selfCheck 数据）；任务态 failed 由 VerifyGate（L2）按 passed=false 判定
  equal(statuses.join(','), 'running,succeeded');
  equal(result?.selfCheck?.passed, false);
  equal(result?.exitCode, 0);
});

test('mock timeout：→failed（心跳超时语义，E20）', async () => {
  const statuses: string[] = [];
  const provider = new MockProvider({ outcome: { kind: 'timeout' } });
  provider.execute(
    { taskId: 't_1', title: 't' },
    { onStatus: (s) => statuses.push(s), onEvent: () => {}, onResult: () => {} },
  );
  await sleep(5);
  equal(statuses.join(','), 'running,failed');
});

test('mock 可控延迟：delayMs 后回执，delay 期间保持 running', async () => {
  const statuses: string[] = [];
  const provider = new MockProvider({ outcome: { kind: 'success', selfCheck: { passed: true } }, delayMs: 40 });
  provider.execute(
    { taskId: 't_1', title: 't' },
    { onStatus: (s) => statuses.push(s), onEvent: () => {}, onResult: () => {} },
  );
  await sleep(10);
  equal(statuses.join(','), 'running', 'delay 期间未完成');
  await sleep(50);
  equal(statuses.join(','), 'running,succeeded', 'delay 后完成');
});

test('mock 流式：text_chunk 事件按序注入（活动心跳，E21）', async () => {
  const events: string[] = [];
  const provider = new MockProvider({ outcome: { kind: 'stream', chunks: ['a', 'b', 'c'] }, streamIntervalMs: 2 });
  provider.execute(
    { taskId: 't_1', title: 't' },
    { onStatus: () => {}, onEvent: (e) => events.push(e.kind === 'text_chunk' ? e.text : ''), onResult: () => {} },
  );
  await sleep(30);
  equal(events.join(','), 'a,b,c');
});

test('mock permission：注入 permission_request 事件', async () => {
  const events: ExecutionEvent[] = [];
  const provider = new MockProvider({
    outcome: {
      kind: 'permission',
      events: [{ kind: 'permission_request', id: 'req_1', message: '允许执行?' }],
    },
  });
  provider.execute(
    { taskId: 't_1', title: 't' },
    { onStatus: () => {}, onEvent: (e) => events.push(e), onResult: () => {} },
  );
  await sleep(5);
  equal(events.length, 1);
  equal(events[0].kind, 'permission_request');
});

test('mock cancel：cancel 后结果丢弃，无 onResult（E4 语义）', async () => {
  const statuses: string[] = [];
  let resultCalled = false;
  const provider = new MockProvider({ outcome: { kind: 'success', selfCheck: { passed: true } }, delayMs: 30 });
  const handle = provider.execute(
    { taskId: 't_1', title: 't' },
    { onStatus: (s) => statuses.push(s), onEvent: () => {}, onResult: () => (resultCalled = true) },
  );
  await sleep(5);
  await handle.cancel();
  await sleep(40);
  equal(resultCalled, false, 'cancel 后无结果回执');
  equal(statuses.includes('succeeded'), false, 'cancel 后不 succeeded');
});

test('mock spec 只读暴露注入配置', () => {
  const provider = new MockProvider({ outcome: { kind: 'timeout' }, delayMs: 12 });
  equal(provider.spec.delayMs, 12);
  equal(provider.spec.outcome.kind, 'timeout');
});
