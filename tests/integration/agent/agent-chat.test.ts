/**
 * Agent 对话集成测试（M1：长驻会话 + 流式 + 审批）
 *
 * 不启动 Electron：注入 launch = [process.execPath, tests/fixtures/fake-acp-agent.js]，
 * 验证真实子进程往返（NDJSON JSON-RPC over stdio）：
 * 1. start → initialize + session/new + connected；send → message_chunk + turn_end(end_turn)
 * 2. 同一会话第二次 send → 复用同一 sessionId（fake 侧 TURN_2 锚点 + 仅一次 session/new 日志）
 * 3. 回合进行中再 send → chat-busy
 * 4. cancel → session/cancel → turn_end(stopReason cancelled)
 * 5. ASK_PERMISSION → permission_request → approve(true) → 继续并 turn_end
 * 6. close → 子进程退出（无残留）+ 可重开
 * 7. 命令不可执行（ENOENT）→ start 失败，错误可读
 */
import { test, after } from 'node:test';
import { equal, ok } from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { join } from 'node:path';

import { AgentChatService, type AgentChatEvent } from '../../../src/exec/agent/AgentChatService';
import type { RuntimeLogger } from '../../../src/shared/types';

/** fake ACP agent 路径（dist-tests/tests/integration/agent → 项目根/tests/fixtures） */
const FAKE_ACP = join(__dirname, '..', '..', '..', '..', 'tests', 'fixtures', 'fake-acp-agent.js');
const LAUNCH = { command: process.execPath, args: [FAKE_ACP] };

const services: AgentChatService[] = [];
after(async () => {
  await Promise.all(services.map((s) => s.close()));
});

interface Harness {
  service: AgentChatService;
  events: AgentChatEvent[];
  logs: string[];
}

function makeService(launch = LAUNCH): Harness {
  const events: AgentChatEvent[] = [];
  const logs: string[] = [];
  const logger: RuntimeLogger = {
    info: (m) => logs.push(m),
    warn: (m) => logs.push(m),
    error: (m) => logs.push(m),
    dshLog: () => {},
  };
  const service = new AgentChatService({ launch, logger });
  service.on('event', (ev: AgentChatEvent) => events.push(ev));
  services.push(service);
  return { service, events, logs };
}

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} 超时（${ms}ms）`)), ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitFor(events: AgentChatEvent[], pred: (ev: AgentChatEvent) => boolean, ms: number, label: string): Promise<AgentChatEvent> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const hit = events.find(pred);
    if (hit) return hit;
    await sleep(20);
  }
  throw new Error(`${label} 超时（${ms}ms）`);
}

function chunkText(events: AgentChatEvent[]): string {
  return events.map((e) => (e.kind === 'message_chunk' ? e.text : '')).join('');
}

test('① start：connected + sessionId + agent 信息；send → message_chunk + turn_end(end_turn)', async () => {
  const h = makeService();
  const started = await withTimeout(h.service.start(), 10_000, 'start');
  ok(started.sessionId, 'sessionId 非空');
  equal(started.agent.name, 'fake-acp-agent', 'initialize 回 agentInfo.name');
  equal(started.agent.version, '0.1.0', 'initialize 回 agentInfo.version');
  ok(h.events.some((e) => e.kind === 'status' && e.state === 'connected'), 'status connected');
  const st = h.service.status();
  equal(st.connected, true);
  equal(st.sessionId, started.sessionId);
  equal(st.agentName, 'fake-acp-agent');

  await withTimeout(h.service.send('你好'), 10_000, 'send');
  const chunks = h.events.filter((e) => e.kind === 'message_chunk');
  ok(chunks.length >= 2, `至少 2 条 message_chunk（实际 ${chunks.length}）`);
  ok(chunkText(h.events).includes('FAKE_AGENT_REPLY'), '流式文本含断言锚点');
  const turnEnd = h.events.find((e) => e.kind === 'turn_end');
  ok(turnEnd && turnEnd.kind === 'turn_end', 'turn_end 事件');
  equal(turnEnd.stopReason, 'end_turn');
  equal(h.service.status().busy, false, '回合结束 busy=false');
});

test('② 同一会话第二次 send：复用 sessionId（TURN_2 + 仅一次 session/new）', async () => {
  const h = makeService();
  const started = await withTimeout(h.service.start(), 10_000, 'start');
  await withTimeout(h.service.send('第一轮'), 10_000, 'send#1');
  await withTimeout(h.service.send('第二轮'), 10_000, 'send#2');

  ok(chunkText(h.events).includes('TURN_2'), '第二轮回复带 TURN_2 锚点（同一会话多轮）');
  equal(h.service.status().sessionId, started.sessionId, 'sessionId 不变');
  const newSessionLogs = h.logs.filter((l) => l.includes('session/new'));
  equal(newSessionLogs.length, 1, '只发生一次 session/new');
  const turnEnds = h.events.filter((e) => e.kind === 'turn_end');
  equal(turnEnds.length, 2, '两次 turn_end');
});

test('③ send 期间再 send：chat-busy 拒绝', async () => {
  const h = makeService();
  await withTimeout(h.service.start(), 10_000, 'start');
  const first = h.service.send('ASK_PERMISSION 阻塞等待审批，制造进行中回合');
  await waitFor(h.events, (e) => e.kind === 'permission_request', 5_000, 'permission_request');
  equal(h.service.status().busy, true, '回合进行中 busy=true');

  await h.service.send('插队消息').then(
    () => {
      throw new Error('busy 时 send 不应成功');
    },
    (err: Error & { code?: string }) => {
      equal(err.code, 'chat-busy', '错误码 chat-busy');
    },
  );

  h.service.approve(requestIdOf(h.events), true, '清理回合');
  await withTimeout(first, 10_000, 'first send');
});

test('④ cancel：session/cancel → turn_end(stopReason cancelled)', async () => {
  const h = makeService();
  await withTimeout(h.service.start(), 10_000, 'start');
  const pending = h.service.send('ASK_PERMISSION 阻塞，随后取消');
  await waitFor(h.events, (e) => e.kind === 'permission_request', 5_000, 'permission_request');
  h.service.cancel();
  await withTimeout(pending, 10_000, 'cancelled send');
  const turnEnd = h.events.find((e) => e.kind === 'turn_end');
  ok(turnEnd && turnEnd.kind === 'turn_end', 'turn_end 事件');
  equal(turnEnd.stopReason, 'cancelled', 'stopReason cancelled');
  equal(h.service.status().busy, false);
});

test('⑤ permission：ASK_PERMISSION → permission_request → approve(true) → 继续并 turn_end', async () => {
  const h = makeService();
  await withTimeout(h.service.start(), 10_000, 'start');
  const pending = h.service.send('ASK_PERMISSION 请审批');
  const perm = await waitFor(h.events, (e) => e.kind === 'permission_request', 5_000, 'permission_request');
  ok(perm.kind === 'permission_request' && perm.requestId, 'requestId 非空');
  equal(perm.kind === 'permission_request' ? perm.message : '', 'fake agent 想执行工具，是否允许？', '契约 message.content 提取为文案');

  h.service.approve(perm.kind === 'permission_request' ? perm.requestId : '', true, '测试批准');
  await withTimeout(pending, 10_000, 'approved send');
  ok(chunkText(h.events).includes('权限已批准'), '批准后继续执行');
  const turnEnd = h.events.find((e) => e.kind === 'turn_end');
  ok(turnEnd && turnEnd.kind === 'turn_end' && turnEnd.stopReason === 'end_turn', 'turn_end end_turn');
});

/** 子进程已退出（被信号终止时 exitCode 为 null，signalCode 非 null） */
function hasExited(child: ReturnType<typeof spawn>): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

test('⑥ close：子进程退出（无残留）+ close 后可重开', async () => {
  const children: ReturnType<typeof spawn>[] = [];
  const service = new AgentChatService({
    launch: LAUNCH,
    spawnFn: ((cmd: string, args: string[], opts: never) => {
      const child = spawn(cmd, args, opts) as ReturnType<typeof spawn>;
      children.push(child);
      return child;
    }) as never,
  });
  services.push(service);
  await withTimeout(service.start(), 10_000, 'start');
  await service.close();
  equal(children.length, 1, 'spawn 一次');
  ok(hasExited(children[0]), 'close 后子进程已退出');
  equal(service.status().connected, false, 'connected=false');
  equal(service.status().sessionId, undefined, 'sessionId 清空');
  await service.close(); // 幂等
  // 重开：close 后 start 可再来一次（新进程/新会话）
  const again = await withTimeout(service.start(), 10_000, 're-start');
  ok(again.sessionId, '重开会话 sessionId 非空');
  equal(children.length, 2, '重开 spawn 新进程');
  await service.close();
  ok(hasExited(children[1]), '第二个子进程也已退出');
});

test('⑦ 命令不可执行（ENOENT）→ start 失败，错误可读', async () => {
  const h = makeService({ command: join(__dirname, 'definitely-missing-agent-binary'), args: [] });
  await withTimeout(h.service.start(), 10_000, 'start').then(
    () => {
      throw new Error('ENOENT 命令不应 start 成功');
    },
    (err: Error & { code?: string }) => {
      ok(/ENOENT|启动失败/.test(err.message), `错误信息可读：${err.message}`);
    },
  );
  const st = h.service.status();
  equal(st.connected, false);
  ok(st.lastError && /ENOENT|启动失败/.test(st.lastError), 'lastError 已记录');
  ok(h.events.some((e) => e.kind === 'error'), '推送 error 事件');
  ok(h.events.some((e) => e.kind === 'status' && e.state === 'error'), '推送 status error');
});

/** 取第一条 permission_request 的 requestId（测试辅助） */
function requestIdOf(events: AgentChatEvent[]): string {
  const perm = events.find((e) => e.kind === 'permission_request');
  return perm && perm.kind === 'permission_request' ? perm.requestId : '';
}
