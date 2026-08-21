/**
 * L1 迁移表常量单测（transitions.ts）
 * 对契约 §执行态轨道矩阵测：每态合法迁移集 + 双轨（Verify/Done 列轨不在 8 态）+ 系统收敛目标态
 */
import { test } from 'node:test';
import { deepEqual, equal, ok } from 'node:assert/strict';
import type { ExecutionStatus } from '../../kanban/types';
import { COLUMN_TYPES, EXEC_TRANSITIONS, EXECUTION_STATUSES, VERIFY_COLUMN_TYPE, DONE_COLUMN_TYPE } from './transitions';

test('EXEC_TRANSITIONS：契约 18 行矩阵完整（每态合法迁移集）', () => {
  deepEqual(EXEC_TRANSITIONS.idle, ['queued']);
  deepEqual(EXEC_TRANSITIONS.queued, ['running', 'cancelled', 'failed']);
  deepEqual(EXEC_TRANSITIONS.running, ['paused', 'interrupted', 'cancelled', 'succeeded', 'failed']);
  deepEqual(EXEC_TRANSITIONS.paused, ['running', 'cancelled']);
  deepEqual(EXEC_TRANSITIONS.interrupted, ['queued', 'succeeded']);
  deepEqual(EXEC_TRANSITIONS.failed, ['queued', 'succeeded']);
  deepEqual(EXEC_TRANSITIONS.succeeded, ['queued']);
  deepEqual(EXEC_TRANSITIONS.cancelled, ['queued']);
});

test('EXEC_TRANSITIONS：8 态全覆盖，无遗漏态键', () => {
  for (const s of EXECUTION_STATUSES) {
    ok(Array.isArray(EXEC_TRANSITIONS[s]), `${s} 有迁移表`);
  }
  equal(EXECUTION_STATUSES.length, 8);
});

test('重跑规则（Q-023）：可点执行态（非 running/queued/paused）→queued', () => {
  // 契约：任何态点「执行」→ queued（重跑规则 Q-023）；running/queued 中重复触发 → exec-state-conflict（E28）；
  // paused 恢复走 resumeExecution（paused→running，§接口详情 #4），不经过 executeTask 入队
  const reExecutable: ExecutionStatus[] = ['idle', 'interrupted', 'cancelled', 'failed', 'succeeded'];
  for (const s of reExecutable) {
    ok(EXEC_TRANSITIONS[s].includes('queued'), `${s} 可重跑→queued`);
  }
  // running/queued 无 queued 出边（守卫：不可重复入队）；paused 恢复=重新执行（resume 语义）
  ok(!EXEC_TRANSITIONS.running.includes('queued'));
  ok(!EXEC_TRANSITIONS.queued.includes('queued'));
  ok(!EXEC_TRANSITIONS.paused.includes('queued'));
});

test('双轨解耦：Verify/Done 是列轨，不在 8 态枚举内（Q-013）', () => {
  // 8 态不含 verify/done
  ok(!EXECUTION_STATUSES.includes('verify' as ExecutionStatus));
  ok(!EXECUTION_STATUSES.includes('done' as ExecutionStatus));
  // 列轨模板 type
  ok(COLUMN_TYPES.includes('verify'));
  ok(COLUMN_TYPES.includes('done'));
  equal(VERIFY_COLUMN_TYPE, 'verify');
  equal(DONE_COLUMN_TYPE, 'done');
});

test('确认迁移：verify 列 → done（人工把关 CON-R028）', () => {
  // verify→done 是列轨流转（confirmVerify 走 B1 moveTask），执行态不变
  ok(EXEC_TRANSITIONS.succeeded.includes('queued'), 'succeeded 仍可重跑');
  // 契约：succeeded + verify 列 → done 人工确认，执行态保持 succeeded（双轨）
  equal(EXEC_TRANSITIONS.succeeded[0], 'queued', '执行态轨道不含列迁移');
});

test('系统收敛目标态合法性：running/queued 收敛 → failed/cancelled 均合法', () => {
  // 心跳超时 running→failed；重启收敛 running/paused/interrupted→failed；取消 queued/running/paused→cancelled
  ok(EXEC_TRANSITIONS.running.includes('failed'), '心跳超时 running→failed');
  ok(EXEC_TRANSITIONS.paused.includes('cancelled'));
  ok(EXEC_TRANSITIONS.queued.includes('failed'), '依赖失败 queued→failed');
  ok(EXEC_TRANSITIONS.queued.includes('cancelled'));
});
