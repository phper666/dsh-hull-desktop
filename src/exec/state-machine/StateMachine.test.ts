/**
 * L1 状态机单测（StateMachine.ts）
 * 迁移表驱动 + 非法迁移防护（dev throw / prod log-ignore）+ 事件 emit（onExecutionUpdate 源）
 */
import { test } from 'node:test';
import { equal, ok, throws } from 'node:assert/strict';

import { StateMachine, type ExecutionStatusEvent } from './StateMachine';
import type { ExecutionStatus } from '../../kanban/types';
import { EXEC_TRANSITIONS } from './transitions';

function make(dev = false) {
  const events: ExecutionStatusEvent[] = [];
  const sm = new StateMachine('t_1', { dev });
  sm.on('status', (e) => events.push(e));
  return { sm, events };
}

test('初始态 idle + 事件 emit（onExecutionUpdate 源）', () => {
  const { sm, events } = make();
  equal(sm.current, 'idle');
  ok(sm.transition('queued'));
  equal(sm.current, 'queued');
  equal(events.length, 1);
  equal(events[0].taskId, 't_1');
  equal(events[0].executionStatus, 'queued');
});

test('E1 主链路：idle→queued→running→succeeded→（列轨 verify→done 走 moveTask 不在此机）', () => {
  const { sm, events } = make();
  sm.transition('queued');
  sm.transition('running');
  sm.transition('succeeded');
  equal(sm.current, 'succeeded');
  equal(events.map((e) => e.executionStatus).join(','), 'queued,running,succeeded');
});

test('非法迁移：dev throw', () => {
  const { sm } = make(true);
  ok(sm.transition('queued'));
  // running 不可直接回 idle / succeeded 不可直接 running
  throws(() => sm.transition('succeeded'), /非法状态迁移/);
  equal(sm.current, 'queued', '迁移失败状态不变');
});

test('非法迁移：prod log-ignore 返回 false（对齐 M1 D7）', () => {
  const { sm } = make(false);
  ok(sm.transition('queued'));
  equal(sm.transition('succeeded'), false);
  equal(sm.current, 'queued', '非法迁移被忽略，状态保持');
});

test('8 态全合法迁移逐条验证（对 EXEC_TRANSITIONS 表）', () => {
  const all: ExecutionStatus[] = ['idle', 'queued', 'running', 'paused', 'interrupted', 'cancelled', 'failed', 'succeeded'];
  for (const target of all) {
    for (const from of all) {
      const sm = new StateMachine('t_1', { dev: false });
      // 构造到达 from 的合法路径（直接设初态不可行——用私有路径：先合法走一遍）
      // 简化：直接断言迁移表目标集合与逐条可达性（从 idle 全表驱动）
      const expected = EXEC_TRANSITIONS[from].includes(target);
      const actual = legalFrom(from, target);
      equal(actual, expected, `${from}→${target} 与迁移表一致`);
    }
  }
});

/** 用状态机从 idle 逐态迁移到达 from 后验证 from→target 是否合法 */
function legalFrom(from: ExecutionStatus, target: ExecutionStatus): boolean {
  // 自构建一条到达 from 的合法路径（idle 可达性）
  const sm = new StateMachine('t_1', { dev: false });
  if (from === 'idle') return sm.transition(target) && target === 'queued';
  const path = pathTo(from);
  if (!path) return false;
  for (const s of path) sm.transition(s);
  return sm.transition(target);
}

/** 到各态的合法路径（idle 起始） */
function pathTo(from: ExecutionStatus): ExecutionStatus[] | null {
  switch (from) {
    case 'queued': return ['queued'];
    case 'running': return ['queued', 'running'];
    case 'paused': return ['queued', 'running', 'paused'];
    case 'interrupted': return ['queued', 'running', 'interrupted'];
    case 'cancelled': return ['queued', 'cancelled'];
    case 'failed': return ['queued', 'running', 'failed'];
    case 'succeeded': return ['queued', 'running', 'succeeded'];
    case 'idle': return [];
    default: return null;
  }
}

test('各态事件载荷：含 taskId + executionStatus', () => {
  const { sm, events } = make();
  sm.transition('queued');
  sm.transition('running');
  equal(events[1].taskId, 't_1');
  equal(events[1].executionStatus, 'running');
});
