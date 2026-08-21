/**
 * L3b ExecIpc 单测（B3 10 执行控制 IPC + B4 3 执行集成）
 *
 * 注入假 ipcMain（记录 handle/on 注册）+ 假 engine/approval/registry/acEditor，
 * 不做真实 electron——测 handler 逻辑 + 错误包裹 + channel 白名单一致性。
 */
import { test } from 'node:test';
import { equal, ok, deepEqual } from 'node:assert/strict';
import { EventEmitter } from 'node:events';

import { EXEC_IPC_CHANNELS, registerExecIpc, type ExecIpcDeps } from './ExecIpc';
import { KANBAN_EXEC_IPC_CHANNELS, KANBAN_B4_EXEC_IPC_CHANNELS, ALL_IPC_CHANNELS } from '../../shared/ipc-channels';
import { ExecValidationError } from '../errors';

/** 假 ipcMain：记录注册的 channel + handler，可调用 handler 验证逻辑 */
class FakeIpcMain {
  handlers = new Map<string, (...args: unknown[]) => unknown>();
  listeners = new Map<string, (...args: unknown[]) => void>();
  handle(channel: string, fn: (...args: unknown[]) => unknown): void {
    this.handlers.set(channel, fn);
  }
  on(channel: string, fn: (...args: unknown[]) => void): void {
    this.listeners.set(channel, fn);
  }
}

function makeDeps(over: Partial<ExecIpcDeps> = {}) {
  const engine = new EventEmitter() as unknown as Record<string, unknown>;
  Object.assign(engine, {
    executeTask: (boardId: string, taskId: string) => ({ taskId, kind: 'single' as const, executionStatus: 'queued', enqueued: [taskId], skipped: [] }),
    cancel: async () => {},
    pause: async () => {},
    resume: async () => {},
    manualComplete: (boardId: string, taskId: string) => ({ taskId, executionStatus: 'succeeded' }),
    confirmVerify: (boardId: string, taskId: string) => ({ taskId, executionStatus: 'succeeded' }),
    getExecutionSnapshot: (boardId?: string) => ({ running: [], queued: [], maxParallel: 3 }),
  });
  const approval = new EventEmitter() as unknown as Record<string, unknown>;
  Object.assign(approval, {
    respond: (boardId: string, taskId: string, requestId: string, decision: string) => {
      if (decision !== 'approve' && decision !== 'deny') throw new ExecValidationError('decision 非法', 'decision');
      return decision;
    },
    getPending: () => [],
  });
  const registry = { list: () => [{ provider: 'dsh', displayName: 'DeepSeek Harness', available: true, supportsSubagent: true }] };
  const acEditor = { editAcceptanceCriteria: (boardId: string, taskId: string) => ({ taskId, executionStatus: 'updated' as const, previousExecutionId: null }) };
  return {
    ipc: new FakeIpcMain(),
    engine: engine as never,
    approval: approval as never,
    registry,
    acEditor,
    ...over,
  } as unknown as ExecIpcDeps & { ipc: FakeIpcMain };
}

/** 调用 invoke handler（electron 惯例：首参为 IpcMainInvokeEvent，注入 null） */
function call<T>(fn: (...args: unknown[]) => T, ...args: unknown[]): T {
  return fn(null, ...args);
}

test('channel 白名单：B3 10 + B4 4 = 14 执行通道，全部在 ALL_IPC_CHANNELS', () => {
  equal(EXEC_IPC_CHANNELS.length, 14);
  equal(KANBAN_EXEC_IPC_CHANNELS.length, 10);
  equal(KANBAN_B4_EXEC_IPC_CHANNELS.length, 4);
  for (const c of EXEC_IPC_CHANNELS) {
    ok(ALL_IPC_CHANNELS.includes(c), `${c} 在白名单`);
  }
});

test('registerExecIpc：注册全部 12 invoke handler', () => {
  const deps = makeDeps();
  registerExecIpc(deps);
  equal(deps.ipc.handlers.size, 12, '9 B3 invoke + approvalRespond + 2 B4 invoke + getPendingApprovals');
  for (const c of EXEC_IPC_CHANNELS) {
    if (c === 'kanban:onExecutionUpdate' || c === 'kanban:onPermissionRequest' || c === 'kanban:onPermissionSettled') continue; // event 通道
    ok(deps.ipc.handlers.has(c), `${c} handler 注册`);
  }
});

test('executeTask：成功包裹 {ok:true,data}', () => {
  const deps = makeDeps();
  registerExecIpc(deps);
  const fn = deps.ipc.handlers.get('kanban:executeTask')!;
  const res = call(fn, 'b1', 't1') as { ok: boolean; data: { taskId: string } };
  equal(res.ok, true);
  equal(res.data.taskId, 't1');
});

test('executeTask：错误包裹 {ok:false,code,message}', () => {
  const errEngine = new EventEmitter() as unknown as Record<string, unknown>;
  Object.assign(errEngine, {
    executeTask: () => {
      throw new ExecValidationError('auto 缺 AC', 'acceptanceCriteria');
    },
  });
  const deps = makeDeps({ engine: errEngine as never });
  registerExecIpc(deps);
  const fn = deps.ipc.handlers.get('kanban:executeTask')!;
  const res = call(fn, 'b1', 't1') as { ok: boolean; code: string; message: string };
  equal(res.ok, false);
  equal(res.code, 'validation-error');
  equal(res.message, 'auto 缺 AC');
});

test('approvalRespond：合法 decision → {ok:true, decision}', () => {
  const deps = makeDeps();
  registerExecIpc(deps);
  const fn = deps.ipc.handlers.get('kanban:approvalRespond')!;
  const res = call(fn, 'b1', 't1', 'req_1', 'approve') as { ok: boolean; data: { decision: string } };
  equal(res.ok, true);
  equal(res.data.decision, 'approve');
});

test('approvalRespond：decision 非法 → validation-error', () => {
  const deps = makeDeps();
  registerExecIpc(deps);
  const fn = deps.ipc.handlers.get('kanban:approvalRespond')!;
  const res = call(fn, 'b1', 't1', 'req_1', 'maybe') as { ok: boolean; code: string };
  equal(res.ok, false);
  equal(res.code, 'validation-error');
});

test('approvalRespond：approval 未接线 → exec-approval-not-pending', () => {
  const deps = makeDeps({ approval: undefined });
  registerExecIpc(deps);
  const fn = deps.ipc.handlers.get('kanban:approvalRespond')!;
  const res = call(fn, 'b1', 't1', 'req_1', 'approve') as { ok: boolean; code: string };
  equal(res.ok, false);
  equal(res.code, 'exec-approval-not-pending');
});

test('getAgentProviders：registry.list 返回 ProviderInfo', () => {
  const deps = makeDeps();
  registerExecIpc(deps);
  const fn = deps.ipc.handlers.get('kanban:getAgentProviders')!;
  const res = call(fn) as { ok: boolean; data: Array<{ provider: string; available: boolean }> };
  equal(res.ok, true);
  equal(res.data.length, 1);
  equal(res.data[0].provider, 'dsh');
  equal(res.data[0].available, true);
});

test('getAgentProviders：registry 未接线 → 空数组', () => {
  const deps = makeDeps({ registry: undefined });
  registerExecIpc(deps);
  const fn = deps.ipc.handlers.get('kanban:getAgentProviders')!;
  const res = call(fn) as { ok: boolean; data: unknown[] };
  equal(res.ok, true);
  deepEqual(res.data, []);
});

test('editAcceptanceCriteria：acEditor 接线 → ok', () => {
  const deps = makeDeps();
  registerExecIpc(deps);
  const fn = deps.ipc.handlers.get('kanban:editAcceptanceCriteria')!;
  const res = call(fn, 'b1', 't1', { what: 'w', expected: 'e', verify: 'v' }) as { ok: boolean; data: { executionStatus: string } };
  equal(res.ok, true);
  equal(res.data.executionStatus, 'updated');
});

test('editAcceptanceCriteria：acEditor 未接线 → exec-not-running 兜底', () => {
  const deps = makeDeps({ acEditor: undefined });
  registerExecIpc(deps);
  const fn = deps.ipc.handlers.get('kanban:editAcceptanceCriteria')!;
  const res = call(fn, 'b1', 't1', { what: 'w', expected: 'e', verify: 'v' }) as { ok: boolean; code: string };
  equal(res.ok, false);
  equal(res.code, 'exec-not-running');
});

test('cancelExecution/pause/resume：async 成功包裹', async () => {
  const deps = makeDeps();
  registerExecIpc(deps);
  const cancel = deps.ipc.handlers.get('kanban:cancelExecution')!;
  const res = (await call(cancel, 'b1', 't1')) as { ok: boolean; data: { executionStatus: string } };
  equal(res.ok, true);
  equal(res.data.executionStatus, 'cancelled');
});

test('getExecutionSnapshot：透传 engine 快照', () => {
  const deps = makeDeps();
  registerExecIpc(deps);
  const fn = deps.ipc.handlers.get('kanban:getExecutionSnapshot')!;
  const res = call(fn, 'b1') as { ok: boolean; data: { maxParallel: number } };
  equal(res.ok, true);
  equal(res.data.maxParallel, 3);
});

test('onExecutionUpdate 订阅：重放当前快照到 sender', () => {
  const deps = makeDeps();
  registerExecIpc(deps);
  const sent: unknown[] = [];
  const sender = { send: (channel: string, payload: unknown) => sent.push({ channel, payload }) };
  deps.ipc.listeners.get('kanban:onExecutionUpdate-sub')!({ sender });
  // 空快照 → 无重放
  equal(sent.length, 0);
});

// ─────────────────── 🟡-3 事件推送（engine/approval → broadcast）───────────────────

test('🟡-3 engine execution-update → 广播 onExecutionUpdate', () => {
  const deps = makeDeps();
  const sent: unknown[] = [];
  const engineEE = deps.engine as unknown as EventEmitter;
  registerExecIpc({ ...deps, broadcast: (channel, payload) => sent.push({ channel, payload }) });
  engineEE.emit('execution-update', { boardId: 'b1', taskId: 't1', executionStatus: 'running' });
  equal(sent.length, 1);
  equal((sent[0] as { channel: string }).channel, 'kanban:onExecutionUpdate');
  deepEqual((sent[0] as { payload: unknown }).payload, { boardId: 'b1', taskId: 't1', executionStatus: 'running' });
});

test('🟡-3 approval request → 广播 onPermissionRequest', () => {
  const deps = makeDeps();
  const sent: unknown[] = [];
  const approvalEE = deps.approval as unknown as EventEmitter;
  registerExecIpc({ ...deps, broadcast: (channel, payload) => sent.push({ channel, payload }) });
  approvalEE.emit('request', { boardId: 'b1', taskId: 't1', title: '任务', requestId: 'req_1', message: '允许?', queuePosition: 1, deadlineAt: '2026-08-21T00:00:30.000Z' });
  equal(sent.length, 1);
  equal((sent[0] as { channel: string }).channel, 'kanban:onPermissionRequest');
  deepEqual((sent[0] as { payload: unknown }).payload, { boardId: 'b1', taskId: 't1', title: '任务', requestId: 'req_1', message: '允许?', queuePosition: 1, deadlineAt: '2026-08-21T00:00:30.000Z' });
});

test('🟡-3 approval 未接线：不订阅 request（无广播）', () => {
  const deps = makeDeps({ approval: undefined });
  const sent: unknown[] = [];
  registerExecIpc({ ...deps, broadcast: (channel, payload) => sent.push({ channel, payload }) });
  equal(sent.length, 0, '无 approval 订阅 → 无事件');
});

test('🟡-3 approval settled → 广播 onPermissionSettled', () => {
  const deps = makeDeps();
  const sent: unknown[] = [];
  const approvalEE = deps.approval as unknown as EventEmitter;
  registerExecIpc({ ...deps, broadcast: (channel, payload) => sent.push({ channel, payload }) });
  approvalEE.emit('settled', { boardId: 'b1', taskId: 't1', requestId: 'req_1', decision: 'approve' });
  equal(sent.length, 1);
  equal((sent[0] as { channel: string }).channel, 'kanban:onPermissionSettled');
  deepEqual((sent[0] as { payload: unknown }).payload, { boardId: 'b1', taskId: 't1', requestId: 'req_1', decision: 'approve' });
});

test('🟡-3 approval settled 未接线：无广播', () => {
  const deps = makeDeps({ approval: undefined });
  const sent: unknown[] = [];
  registerExecIpc({ ...deps, broadcast: (channel, payload) => sent.push({ channel, payload }) });
  equal(sent.length, 0, '无 approval 订阅 → 无 settled 广播');
});
