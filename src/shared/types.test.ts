import { test } from 'node:test';
import { equal, deepEqual, ok } from 'node:assert/strict';

import { RuntimePhase, type RuntimeSnapshot, type PhaseTransitionTable } from './types';
import {
  HullError,
  StartTimeoutError,
  SpawnFailedError,
  DshMissingError,
  ChildExitedError,
} from './errors';

test('RuntimePhase 枚举值 = 契约四阶段字符串', () => {
  equal(RuntimePhase.Idle, 'idle');
  equal(RuntimePhase.Starting, 'starting');
  equal(RuntimePhase.Ready, 'ready');
  equal(RuntimePhase.Failed, 'failed');
});

test('PhaseTransitionTable 类型可用，可承载迁移语义', () => {
  // 设计 D7：TRANSITIONS: Record<Phase, Phase[]>（表实例归 RuntimeManager，此处验证类型可承载）
  const table: PhaseTransitionTable = {
    [RuntimePhase.Idle]: [RuntimePhase.Starting],
    [RuntimePhase.Starting]: [RuntimePhase.Ready, RuntimePhase.Failed],
    [RuntimePhase.Ready]: [RuntimePhase.Starting, RuntimePhase.Failed],
    [RuntimePhase.Failed]: [RuntimePhase.Starting],
  };
  deepEqual(table[RuntimePhase.Idle], [RuntimePhase.Starting]);
  deepEqual(table[RuntimePhase.Starting], [RuntimePhase.Ready, RuntimePhase.Failed]);
  ok(!table[RuntimePhase.Idle].includes(RuntimePhase.Ready));
  ok(table[RuntimePhase.Failed].includes(RuntimePhase.Starting));
});

test('RuntimeSnapshot 四字段可用', () => {
  const snap: RuntimeSnapshot = {
    phase: RuntimePhase.Ready,
    message: 'dsh 就绪',
    launchDirectory: '/tmp/dsh',
    url: 'http://127.0.0.1:53421',
  };
  equal(snap.phase, 'ready');
  equal(snap.message, 'dsh 就绪');
  equal(snap.launchDirectory, '/tmp/dsh');
  equal(snap.url, 'http://127.0.0.1:53421');
});

test('HullError 基类：Error 子类 + code 字段', () => {
  const err = new HullError('test-code', 'boom');
  ok(err instanceof Error);
  equal(err.name, 'HullError');
  equal(err.code, 'test-code');
  equal(err.message, 'boom');
});

test('StartTimeoutError：name/code/message 正确', () => {
  const err = new StartTimeoutError('dsh 就绪超时');
  ok(err instanceof HullError);
  equal(err.name, 'StartTimeoutError');
  equal(err.code, 'start-timeout');
  equal(err.message, 'dsh 就绪超时');
});

test('SpawnFailedError / DshMissingError / ChildExitedError：name/code 正确', () => {
  const cases: Array<[HullError, string, string]> = [
    [new SpawnFailedError('spawn 失败'), 'SpawnFailedError', 'spawn-failed'],
    [new DshMissingError('overlay 缺失'), 'DshMissingError', 'dsh-missing'],
    [new ChildExitedError('子进程提前退出'), 'ChildExitedError', 'child-exited'],
  ];
  for (const [err, name, code] of cases) {
    ok(err instanceof HullError);
    equal(err.name, name);
    equal(err.code, code);
  }
});
