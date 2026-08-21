/**
 * L2 ApprovalManager 单测（B4 design §4.2 / 契约 §2/Q-018，P1-B4-1）
 *
 * - FIFO：多请求 queuePosition 1/2/3，响应任一不阻塞其他，重排连续
 * - approve/deny：回 ACP { approved, reason? }（message 空省略 reason）+ timeline 留痕
 * - 30s 超时：主进程计时 auto-deny + timeline"审批超时自动拒绝"（mock 时钟，P1-B4-1 A5/A17）
 * - 重启 pending：立即 auto-deny + timeline（对齐 B3 Q-017）
 * - 幂等：已响应/已超时再响应 → exec-approval-not-pending；decision 非法 → validation-error
 * - 非阻塞：队列满不影响其他请求响应（响应任一不阻塞其他）
 */
import { test } from 'node:test';
import { deepEqual, equal, throws } from 'node:assert/strict';

import { ApprovalManager, APPROVAL_TIMEOUT_MS, type PermissionRequestContext } from './ApprovalManager';
import { ExecApprovalNotPendingError, ExecValidationError } from '../errors';

interface RespondCall {
  ctx: PermissionRequestContext;
  decision: string;
  reason?: string;
}

function makeHarness(overrides: { now?: () => number } = {}) {
  const responds: RespondCall[] = [];
  const timeline: Array<{ boardId: string; taskId: string; content: string }> = [];
  let clock = 1_000_000;
  const timers = new Map<number, { fn: () => void; at: number }>();
  let nextId = 1;

  const manager = new ApprovalManager({
    now: overrides.now ?? (() => clock),
    respondApproval: (ctx, decision, reason) => responds.push({ ctx: { ...ctx }, decision, reason }),
    timelineStore: {
      appendSystemEvent: (boardId, taskId, content) => timeline.push({ boardId, taskId, content }),
    },
    setTimeout: (fn, ms) => {
      const id = nextId++;
      timers.set(id, { fn, at: clock + ms });
      return id;
    },
    clearTimeout: (h) => {
      timers.delete(h as number);
    },
  });

  return {
    manager,
    responds,
    timeline,
    /** 推进时钟并触发到点计时器（模拟主进程计时到 deadlineAt） */
    advance(ms: number) {
      clock += ms;
      for (const [id, t] of [...timers]) {
        if (t.at <= clock) {
          timers.delete(id);
          t.fn();
        }
      }
    },
    get timers() {
      return timers;
    },
    clock: () => clock,
  };
}

function req(n: number): PermissionRequestContext {
  return { boardId: 'b_1', taskId: `t_${n}`, title: `任务${n}`, requestId: `req_${n}`, message: `消息${n}` };
}

test('FIFO：多请求 queuePosition 1/2/3，响应任一不阻塞其他', () => {
  const h = makeHarness();
  const events: Array<{ requestId: string; queuePosition: number }> = [];
  h.manager.handlePermissionRequest(req(1), (e) => events.push({ requestId: e.requestId, queuePosition: e.queuePosition }));
  h.manager.handlePermissionRequest(req(2), (e) => events.push({ requestId: e.requestId, queuePosition: e.queuePosition }));
  h.manager.handlePermissionRequest(req(3), (e) => events.push({ requestId: e.requestId, queuePosition: e.queuePosition }));

  deepEqual(events, [
    { requestId: 'req_1', queuePosition: 1 },
    { requestId: 'req_2', queuePosition: 2 },
    { requestId: 'req_3', queuePosition: 3 },
  ]);
  // 响应中间 req_2 不阻塞 req_1/req_3，且重排后 queuePosition 连续
  h.manager.respond('b_1', 't_2', 'req_2', 'approve');
  const remaining = h.manager.getPending().map((p) => ({ requestId: p.requestId, queuePosition: p.queuePosition }));
  deepEqual(remaining, [
    { requestId: 'req_1', queuePosition: 1 },
    { requestId: 'req_3', queuePosition: 2 },
  ]);
});

test('deadlineAt = now + 30s（主进程计算，P1-B4-1）', () => {
  const h = makeHarness();
  let ev!: ReturnType<ApprovalManager['handlePermissionRequest']>;
  h.manager.handlePermissionRequest(req(1), (e) => (ev = e));
  equal(ev.deadlineAt, new Date(h.clock() + APPROVAL_TIMEOUT_MS).toISOString());
  equal(ev.queuePosition, 1);
});

test('handlePermission：ACPProvider permission 事件入队（boardId 空串兜底 + request 事件广播）', () => {
  const h = makeHarness();
  const requests: Array<{ boardId: string; taskId: string; requestId: string; queuePosition: number }> = [];
  h.manager.on('request', (ev: unknown) => requests.push(ev as never));
  const ev = h.manager.handlePermission({ taskId: 't_1', title: '任务', requestId: 'req_1', message: '允许?' });
  equal(ev.boardId, '', 'ACPProvider 事件无 boardId → 空串兜底');
  equal(ev.taskId, 't_1');
  equal(ev.requestId, 'req_1');
  equal(ev.queuePosition, 1);
  equal(requests.length, 1, '入队触发 request 事件（ExecIpc 订阅 → onPermissionRequest 推送）');
  equal(h.manager.getPending().length, 1);
  // 完整审批链路闭合：handlePermission 入队 → respond 回 ACP
  h.manager.respond('', 't_1', 'req_1', 'approve', '同意');
  equal(h.responds.length, 1);
  equal(h.responds[0].ctx.requestId, 'req_1');
  equal(h.responds[0].decision, 'approve');
});

test('approve：回 ACP approved:true + timeline 留痕', () => {
  const h = makeHarness();
  h.manager.handlePermissionRequest(req(1), () => {});
  const status = h.manager.respond('b_1', 't_1', 'req_1', 'approve', '同意');
  equal(status, 'approve');
  deepEqual(h.responds, [{ ctx: req(1), decision: 'approve', reason: '同意' }]);
  deepEqual(h.timeline, [{ boardId: 'b_1', taskId: 't_1', content: '审批 approve: 同意' }]);
  equal(h.manager.getPending().length, 0);
});

test('approve 无 message：回 ACP 省略 reason（P2-B4-1）', () => {
  const h = makeHarness();
  h.manager.handlePermissionRequest(req(1), () => {});
  h.manager.respond('b_1', 't_1', 'req_1', 'approve');
  equal(h.responds.length, 1);
  equal(h.responds[0].reason, undefined);
});

test('deny：回 ACP approved:false + timeline 留痕', () => {
  const h = makeHarness();
  h.manager.handlePermissionRequest(req(1), () => {});
  const status = h.manager.respond('b_1', 't_1', 'req_1', 'deny', '不允许');
  equal(status, 'deny');
  deepEqual(h.responds, [{ ctx: req(1), decision: 'deny', reason: '不允许' }]);
  deepEqual(h.timeline, [{ boardId: 'b_1', taskId: 't_1', content: '审批 deny: 不允许' }]);
});

test('30s 超时：主进程 auto-deny + timeline"审批超时自动拒绝"（A5/A17，B2 崩溃不吃窗口）', () => {
  const h = makeHarness();
  h.manager.handlePermissionRequest(req(1), () => {});
  h.advance(APPROVAL_TIMEOUT_MS - 1);
  equal(h.manager.getPending().length, 1, '未到 deadlineAt 仍 pending');
  h.advance(1); // 到 deadlineAt
  equal(h.manager.getPending().length, 0, '到点 auto-deny');
  deepEqual(h.responds, [{ ctx: req(1), decision: 'deny', reason: undefined }]);
  deepEqual(h.timeline, [{ boardId: 'b_1', taskId: 't_1', content: '审批超时自动拒绝' }]);
});

test('30s 超时后再次响应 → exec-approval-not-pending', () => {
  const h = makeHarness();
  h.manager.handlePermissionRequest(req(1), () => {});
  h.advance(APPROVAL_TIMEOUT_MS);
  throws(() => h.manager.respond('b_1', 't_1', 'req_1', 'approve'), ExecApprovalNotPendingError);
  equal(h.responds.length, 1, '超时后不再回 ACP 响应');
});

test('已响应后再次响应 → exec-approval-not-pending', () => {
  const h = makeHarness();
  h.manager.handlePermissionRequest(req(1), () => {});
  h.manager.respond('b_1', 't_1', 'req_1', 'approve');
  throws(() => h.manager.respond('b_1', 't_1', 'req_1', 'deny'), ExecApprovalNotPendingError);
  equal(h.responds.length, 1, '不重复响应 ACP');
});

test('不存在的 requestId → exec-approval-not-pending', () => {
  const h = makeHarness();
  throws(() => h.manager.respond('b_1', 't_1', 'req_none', 'approve'), ExecApprovalNotPendingError);
});

test('decision 非法 → validation-error', () => {
  const h = makeHarness();
  h.manager.handlePermissionRequest(req(1), () => {});
  throws(
    () => h.manager.respond('b_1', 't_1', 'req_1', 'maybe' as 'approve'),
    (err: unknown) => err instanceof ExecValidationError && err.field === 'decision',
  );
  equal(h.manager.getPending().length, 1, '非法决策不消费请求');
});

test('壳重启：pending 立即 auto-deny + timeline（对齐 B3 Q-017）', () => {
  const h = makeHarness();
  h.manager.handlePermissionRequest(req(1), () => {});
  h.manager.handlePermissionRequest(req(2), () => {});
  const n = h.manager.denyAllPendingOnRestart();
  equal(n, 2);
  equal(h.manager.getPending().length, 0);
  deepEqual(h.responds.map((r) => ({ requestId: r.ctx.requestId, decision: r.decision })), [
    { requestId: 'req_1', decision: 'deny' },
    { requestId: 'req_2', decision: 'deny' },
  ]);
  deepEqual(
    h.timeline.map((t) => t.content),
    ['壳重启，审批自动拒绝', '壳重启，审批自动拒绝'],
  );
  // 重启拒绝后不可再响应
  throws(() => h.manager.respond('b_1', 't_1', 'req_1', 'approve'), ExecApprovalNotPendingError);
});

test('非阻塞：队列 3 个 pending，逐一响应互不影响', () => {
  const h = makeHarness();
  h.manager.handlePermissionRequest(req(1), () => {});
  h.manager.handlePermissionRequest(req(2), () => {});
  h.manager.handlePermissionRequest(req(3), () => {});
  h.manager.respond('b_1', 't_1', 'req_1', 'deny');
  h.manager.respond('b_1', 't_3', 'req_3', 'approve');
  h.manager.respond('b_1', 't_2', 'req_2', 'approve');
  equal(h.responds.length, 3);
  equal(h.manager.getPending().length, 0);
});

test('🟡-3 事件：request 入队触发 request 事件（ExecIpc 订阅推送 onPermissionRequest）', () => {
  const h = makeHarness();
  const requests: unknown[] = [];
  h.manager.on('request', (ev: unknown) => requests.push(ev));
  const ev = h.manager.handlePermissionRequest(req(1), () => {});
  equal(requests.length, 1);
  deepEqual(requests[0], ev, 'request 事件载荷 = PermissionRequestEvent');
});

test('🟡-3 事件：respond/超时/重启拒绝触发 settled 事件（B2 关弹窗）', () => {
  const h = makeHarness();
  const settled: Array<{ requestId: string; decision: string; boardId: string; taskId: string }> = [];
  h.manager.on('settled', (ev: { requestId: string; decision: string; boardId: string; taskId: string }) => settled.push(ev));
  h.manager.handlePermissionRequest(req(1), () => {});
  h.manager.handlePermissionRequest(req(2), () => {});
  h.manager.respond('b_1', 't_1', 'req_1', 'approve');
  equal(settled.length, 1);
  deepEqual(settled[0], { boardId: 'b_1', taskId: 't_1', requestId: 'req_1', decision: 'approve' });
  h.advance(APPROVAL_TIMEOUT_MS); // req_2 超时 auto-deny
  equal(settled.length, 2);
  deepEqual(settled[1], { boardId: 'b_1', taskId: 't_2', requestId: 'req_2', decision: 'deny' });
  h.manager.denyAllPendingOnRestart();
  // 无 pending → 重启无 settled（已清空）
  equal(settled.length, 2);
});
