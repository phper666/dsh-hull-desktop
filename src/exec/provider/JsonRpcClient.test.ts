/**
 * L2b JsonRpcClient 帧编解码单测（B4 design §4.1 / D5 帧桩）
 *
 * 帧契约对齐契约 §ACP JSON-RPC 帧契约：
 * - 行分隔（\n）+ JSON，无 Content-Length 头
 * - 请求 id 匹配响应 / 通知事件分发 / 坏 JSON 帧丢弃 / 单行 8KB 截断
 * - dispose reject 全部 pending（通道断开语义，P2-B4-2）
 */
import { test } from 'node:test';
import { equal, ok, rejects } from 'node:assert/strict';
import { EventEmitter } from 'node:events';

import { JsonRpcClient } from './JsonRpcClient';

/** 内存 stdio 桩（Writable 写缓冲 / Readable 手工 push） */
class FakeStdio extends EventEmitter {
  lines: string[] = [];
  write = (s: string): boolean => {
    this.lines.push(s);
    return true;
  };
  emitData(s: string): void {
    this.emit('data', Buffer.from(s, 'utf8'));
  }
}

function makeClient(): { client: JsonRpcClient; stdin: FakeStdio; stdout: FakeStdio } {
  const stdin = new FakeStdio();
  const stdout = new FakeStdio();
  const client = new JsonRpcClient({ stdin: stdin as unknown as NodeJS.WritableStream, stdout: stdout as unknown as NodeJS.ReadableStream });
  return { client, stdin, stdout };
}

test('请求帧：发送 JSON-RPC 2.0 请求（行分隔 + id 自增）', async () => {
  const { client, stdin: inS, stdout } = makeClient();
  const p = client.sendRequest<{ sessionId: string }>('newSession', { cwd: '/x' });
  const sent = JSON.parse(inS.lines[0]);
  equal(sent.jsonrpc, '2.0');
  equal(sent.method, 'newSession');
  equal(sent.params.cwd, '/x');
  ok(typeof sent.id === 'number');
  // 响应帧匹配
  stdout.emitData(JSON.stringify({ jsonrpc: '2.0', id: sent.id, result: { sessionId: 's_1' } }) + '\n');
  equal((await p).sessionId, 's_1');
});

test('请求响应：id 不匹配不 resolve；迟到响应忽略', async () => {
  const { client, stdin: inS, stdout } = makeClient();
  const p = client.sendRequest('newSession');
  stdout.emitData(JSON.stringify({ jsonrpc: '2.0', id: 999, result: 'wrong' }) + '\n');
  stdout.emitData(JSON.stringify({ jsonrpc: '2.0', id: 999, result: 'still wrong' }) + '\n');
  const sent = JSON.parse(inS.lines[0]);
  stdout.emitData(JSON.stringify({ jsonrpc: '2.0', id: sent.id, result: 'ok' }) + '\n');
  equal(await p, 'ok');
});

test('错误响应帧：reject 携带服务端 error.message', async () => {
  const { client, stdin: inS, stdout } = makeClient();
  const p = client.sendRequest('newSession');
  const sent = JSON.parse(inS.lines[0]);
  stdout.emitData(JSON.stringify({ jsonrpc: '2.0', id: sent.id, error: { code: -32000, message: 'no session' } }) + '\n');
  await rejects(p, /no session/);
});

test('通知分发：agent_message_chunk 订阅触发；未订阅不抛', async () => {
  const { client, stdin: inS, stdout } = makeClient();
  const chunks: string[] = [];
  client.onNotification('agent_message_chunk', (params) => {
    chunks.push((params as { content: string }).content);
  });
  stdout.emitData(JSON.stringify({ jsonrpc: '2.0', method: 'agent_message_chunk', params: { sessionId: 's_1', content: 'a' } }) + '\n');
  stdout.emitData(JSON.stringify({ jsonrpc: '2.0', method: 'agent_message_chunk', params: { content: 'b' } }) + '\n');
  stdout.emitData(JSON.stringify({ jsonrpc: '2.0', method: 'unsubscribed', params: {} }) + '\n'); // 未订阅 → 忽略
  equal(chunks.join(','), 'a,b');
});

test('通知退订：onNotification 返回退订函数', async () => {
  const { client, stdin: inS, stdout } = makeClient();
  let count = 0;
  const off = client.onNotification('agent_message_chunk', () => count++);
  stdout.emitData(JSON.stringify({ jsonrpc: '2.0', method: 'agent_message_chunk', params: {} }) + '\n');
  equal(count, 1);
  off();
  stdout.emitData(JSON.stringify({ jsonrpc: '2.0', method: 'agent_message_chunk', params: {} }) + '\n');
  equal(count, 1, '退订后不再分发');
});

test('坏 JSON 帧：丢弃不抛，后续帧正常处理', async () => {
  const { client, stdin: inS, stdout } = makeClient();
  const chunks: string[] = [];
  client.onNotification('agent_message_chunk', (p) => chunks.push((p as { content: string }).content));
  stdout.emitData('not-json\n');
  stdout.emitData(JSON.stringify({ jsonrpc: '2.0', method: 'agent_message_chunk', params: { content: 'ok' } }) + '\n');
  equal(chunks.join(','), 'ok');
});

test('半帧缓冲：跨 chunk 的行完整拼接后解析', async () => {
  const { client, stdin: inS, stdout } = makeClient();
  const chunks: string[] = [];
  client.onNotification('agent_message_chunk', (p) => chunks.push((p as { content: string }).content));
  const line = JSON.stringify({ jsonrpc: '2.0', method: 'agent_message_chunk', params: { content: 'hi' } });
  // 切成两段发（无 \n 分隔）
  stdout.emitData(line.slice(0, 10));
  stdout.emitData(line.slice(10) + '\n');
  equal(chunks.join(','), 'hi');
});

test('单行 8KB 截断：超长行丢弃（对齐 B1 防抖口径）', async () => {
  const { client, stdin: inS, stdout } = makeClient();
  const chunks: string[] = [];
  client.onNotification('agent_message_chunk', (p) => chunks.push((p as { content: string }).content));
  const huge = 'x'.repeat(9000);
  stdout.emitData(huge + '\n');
  stdout.emitData(JSON.stringify({ jsonrpc: '2.0', method: 'agent_message_chunk', params: { content: 'ok' } }) + '\n');
  equal(chunks.join(','), 'ok', '超长行丢弃，后续帧正常');
});

test('发送通知帧：无 id（jsonrpc 2.0 通知）', async () => {
  const { client, stdin: inS, stdout } = makeClient();
  client.sendNotification('session/cancel', { sessionId: 's_1' });
  const sent = JSON.parse(inS.lines[0]);
  equal(sent.method, 'session/cancel');
  equal(sent.id, undefined);
  equal(sent.params.sessionId, 's_1');
});

test('dispose：reject 全部 pending（通道断开语义 P2-B4-2）', async () => {
  const { client, stdin: inS, stdout } = makeClient();
  const p1 = client.sendRequest('newSession');
  const p2 = client.sendRequest('prompt');
  client.dispose(new Error('dsh ACP 子进程意外退出'));
  await rejects(p1, /意外退出/);
  await rejects(p2, /意外退出/);
  // dispose 后 sendRequest 直接 reject
  await rejects(client.sendRequest('newSession'), /已释放/);
  ok(true);
});

test('请求超时：timeoutMs 后 reject', async () => {
  const { client, stdout } = makeClient();
  await rejects(client.sendRequest('newSession', undefined, 20), /超时/);
});

// ─────────────────── Q-024 按方法超时（session/prompt 无超时——回合时长由 agent 决定） ───────────────────

test('Q-024 timeoutMs=0 → 无超时（真实 agent 回合远超 30s，超时即杀回合）', async () => {
  const { mock } = await import('node:test');
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const { client, stdout } = makeClient();
    let settled = false;
    const p = client.sendRequest('session/prompt', { sessionId: 's' }, 0).then(() => { settled = true; }, () => { settled = true; });
    // 推进 10 分钟（远超旧默认 30s）→ 无超时 reject，promise 仍 pending
    mock.timers.tick(10 * 60 * 1000);
    equal(settled, false, 'prompt 请求不被超时杀死');
    // 响应到达 → 正常结算
    stdout.emitData(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { stopReason: 'end_turn' } }) + '\n');
    mock.timers.tick(1);
    await p;
    equal(settled, true);
  } finally {
    mock.timers.reset();
  }
});

