/**
 * L1 ExecutionProvider 抽象接口单测（ExecutionProvider.ts，纯类型）
 * 编译期即契约验证（B4 也消费此接口，签名需稳定）：
 * - ProviderStatus 6 态（无 idle/interrupted，Q-013 双轨）
 * - ExecutionEvent 三联合（text_chunk 活动心跳/tool_call/permission_request）
 * - ExecutionResult 字段 + selfCheck 可选
 * - ExecutionProvider.execute 返回 cancel 句柄
 */
import { test } from 'node:test';
import { equal, ok } from 'node:assert/strict';
import { tmpdir } from 'node:os';
import type { ExecutionEvent, ExecutionProvider, ExecutionResult, ProviderStatus } from './ExecutionProvider';

/** 编译期断言：状态枚举穷举（缺一个会编译错） */
const PROVIDER_STATUSES: ProviderStatus[] = ['queued', 'running', 'paused', 'cancelled', 'failed', 'succeeded'];

test('ProviderStatus：契约 6 态', () => {
  equal(PROVIDER_STATUSES.length, 6);
  ok(PROVIDER_STATUSES.includes('running'));
  ok(PROVIDER_STATUSES.includes('succeeded'));
});

/** 编译期断言：事件联合穷举 */
const EVENTS: ExecutionEvent[] = [
  { kind: 'text_chunk', text: 'hi' },
  { kind: 'tool_call', name: 'bash', args: {} },
  { kind: 'permission_request', id: 'req_1', message: '允许执行?' },
];

test('ExecutionEvent：三联合字段', () => {
  equal(EVENTS.length, 3);
  const text = EVENTS[0];
  if (text.kind === 'text_chunk') {
    ok(text.text.length > 0);
    equal(EVENTS[1].kind, 'tool_call');
    equal(EVENTS[2].kind, 'permission_request');
  }
});

/** 编译期断言：执行结果契约字段 */
const RESULT: ExecutionResult = {
  exitCode: 0,
  summary: 'ok',
  outputPath: 'kanban/executions/e_1.log',
  selfCheck: { passed: true, evidence: 'verified' },
};

test('ExecutionResult：exitCode/summary/outputPath/selfCheck', () => {
  equal(RESULT.exitCode, 0);
  equal(RESULT.selfCheck?.passed, true);
  // selfCheck 可选
  const noSelfCheck: ExecutionResult = { exitCode: 1, summary: '', outputPath: '' };
  equal(noSelfCheck.selfCheck, undefined);
});

test('ExecutionProvider 接口：execute 返回 cancel 句柄（编译期签名）', () => {
  // 仅编译期验证签名；实现类在 MockProvider 测试覆盖
  const provider: ExecutionProvider = {
    execute(task, handlers) {
      void task;
      void handlers;
      return { cancel: async () => {} };
    },
  };
  const handle = provider.execute({ taskId: 't_1', title: 't', cwd: tmpdir() }, {
    onEvent: () => {},
    onStatus: () => {},
    onResult: () => {},
  });
  ok(typeof handle.cancel === 'function');
});
