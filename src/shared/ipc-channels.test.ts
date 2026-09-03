/**
 * L1 IPC channel 白名单集中常量源单测（ipc-channels.ts）
 * 唯一性（无重复）+ B1 16/B5 2/B3 10/B4 4/S1 5 计数 + 前缀规约（kanban: | skills: | hull:showSkills）
 */
import { test } from 'node:test';
import { equal, ok } from 'node:assert/strict';

import {
  ALL_IPC_CHANNELS,
  KANBAN_B4_EXEC_IPC_CHANNELS,
  KANBAN_EXEC_IPC_CHANNELS,
  KANBAN_IPC_CHANNELS,
  SKILLS_IPC_CHANNELS,
} from './ipc-channels';

test('白名单计数：B1 16 + createColumn + B5 2 = 19，B3 10，B4 4，S1+S2 12，共面 45', () => {
  equal(KANBAN_IPC_CHANNELS.length, 19, 'B1 16 数据原语 + createColumn（BUG-1 修复）+ B5 2 导出/导入');
  equal(KANBAN_EXEC_IPC_CHANNELS.length, 10, 'B3 10 执行控制');
  equal(SKILLS_IPC_CHANNELS.length, 12, 'S1 4 skills:* + S2 7 操作 + hull:showSkills 导航');
  equal(ALL_IPC_CHANNELS.length, 45);
});

test('唯一性：全部 channel 无重复', () => {
  equal(new Set(ALL_IPC_CHANNELS).size, ALL_IPC_CHANNELS.length);
});

test('前缀规约：kanban: | skills: | hull:showSkills（S1 导航复用 hull 域）', () => {
  for (const c of ALL_IPC_CHANNELS) {
    ok(c.startsWith('kanban:') || c.startsWith('skills:') || c === 'hull:showSkills', `前缀 ${c}`);
  }
});

test('S1+S2 Skills channel 完整（feishu-s1/s2-skills-api-contract §接口清单）', () => {
  const names = SKILLS_IPC_CHANNELS.join(',');
  for (const expected of [
    'hull:showSkills',
    'skills:scan',
    'skills:getSnapshot',
    'skills:searchRemote',
    'skills:getStatus',
    'skills:remove',
    'skills:upgrade',
    'skills:setEnabled',
    'skills:getDisabledList',
    'skills:getTrashList',
    'skills:restoreFromTrash',
    'skills:getOperationLog',
  ]) {
    ok(names.includes(expected), `含 ${expected}`);
  }
});

test('B3 10 执行控制 channel 完整（契约 §接口清单）', () => {
  const names = KANBAN_EXEC_IPC_CHANNELS.join(',');
  for (const expected of [
    'kanban:executeTask',
    'kanban:cancelExecution',
    'kanban:pauseExecution',
    'kanban:resumeExecution',
    'kanban:manualComplete',
    'kanban:confirmVerify',
    'kanban:approvalRespond',
    'kanban:extendExecution',
    'kanban:getExecutionSnapshot',
    'kanban:onExecutionUpdate',
  ]) {
    ok(names.includes(expected), `含 ${expected}`);
  }
});

test('B4 执行集成 channel 完整（契约 §接口清单 + 🟡-3 onPermissionSettled）', () => {
  const names = KANBAN_B4_EXEC_IPC_CHANNELS.join(',');
  for (const expected of [
    'kanban:onPermissionRequest',
    'kanban:onPermissionSettled',
    'kanban:editAcceptanceCriteria',
    'kanban:getAgentProviders',
  ]) {
    ok(names.includes(expected), `含 ${expected}`);
  }
  equal(KANBAN_B4_EXEC_IPC_CHANNELS.length, 4);
});

test('B1/B3 交集为空（数据原语与执行控制不重叠）', () => {
  const b1: readonly string[] = KANBAN_IPC_CHANNELS;
  for (const c of KANBAN_EXEC_IPC_CHANNELS) {
    ok(!b1.includes(c), `${c} 不在 B1 集`);
  }
});
