import { test } from 'node:test';
import { deepEqual, equal, ok, rejects, throws } from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { readFileSync } from 'node:fs';

import type { KanbanStore } from '../kanban/KanbanStore';
import type { ExecutionEngine } from '../exec/ExecutionEngine';
import { WorkflowEngine, type WorkflowEngineDeps } from './WorkflowEngine';
import { WorkflowStore } from './WorkflowStore';

function makeEnv(opts: { execFail?: boolean; invokeAction?: (connectionId: string, params: Record<string, string>) => Promise<{ ok: boolean; message: string }>; tokenUsage?: (period: 'day' | 'month' | 'all') => Promise<{ totalTokens: number }> } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'hull-workflows-'));
  const store = new WorkflowStore(dir);
  const calls: string[] = [];
  const deps: WorkflowEngineDeps = {
    store,
    kanban: {
      createTask: ((boardId: string, input: { title: string }) => {
        calls.push(`create:${boardId}:${input.title}`);
        return { ok: true, data: { id: 'task-1' } };
      }) as unknown as KanbanStore['createTask'],
    } as unknown as KanbanStore,
    exec: {
      executeTask: ((boardId: string, taskId: string) => {
        calls.push(`exec:${boardId}:${taskId}`);
        if (opts.execFail) return { ok: false, message: '派发失败' };
        return { ok: true };
      }) as unknown as ExecutionEngine['executeTask'],
    } as unknown as ExecutionEngine,
    notify: (title: string, body: string) => calls.push(`notify:${title}:${body}`),
    invokeAction: opts.invokeAction,
    tokenUsage: opts.tokenUsage,
    now: (() => {
      let n = 0;
      return () => (n += 100);
    })(),
    uuid: (() => {
      let n = 0;
      return () => `run-${++n}`;
    })(),
  };
  return { engine: new WorkflowEngine(deps), store, calls, dir };
}

test('顺序执行：dsh-card(不执行)/http 校验失败即中止/notification/delay 全链', async () => {
  const { engine, store, calls } = makeEnv();
  const w = store.save({
    name: '全链',
    steps: [
      { id: 's1', type: 'dsh-card', config: { boardId: 'b1', title: '巡检' } },
      { id: 's2', type: 'http', config: { url: 'ftp://bad' } }, // 非法 URL → fail-fast
      { id: 's3', type: 'notification', config: { message: '不应到达' } },
    ],
  });
  const run = await engine.run(w.id);
  equal(run.status, 'failed');
  equal(run.log.length, 2, 's2 失败即中止，s3 不执行');
  equal(run.log[0].ok, true);
  equal(calls.filter((c) => c.startsWith('create:')).length, 1);
  ok(run.log[1].message.includes('http'));
});

test('dsh-card execute=true：创建 + 派发执行（dsh+面板联动）', async () => {
  const { engine, store, calls } = makeEnv();
  const w = store.save({
    name: 'dsh 联动',
    steps: [{ id: 's1', type: 'dsh-card', config: { boardId: 'board-9', title: '发布任务', execute: 'true', priority: 'P1' } }],
  });
  const run = await engine.run(w.id);
  equal(run.status, 'success');
  ok(calls.includes('create:board-9:发布任务'));
  ok(calls.includes('exec:board-9:task-1'));
  equal(run.log[0].message, '已创建卡片「发布任务」并派发执行');
});

test('notification/delay/http 成功链 + 运行日志持久化', async () => {
  const { engine, store, calls, dir } = makeEnv();
  // stub 全局 fetch（http 步骤不依赖真实网络）
  const prevFetch = globalThis.fetch;
  (globalThis as { fetch: unknown }).fetch = (async () => ({ ok: true, status: 200 })) as unknown as typeof fetch;
  try {
    await runSuccessChain(engine, store, dir, calls);
  } finally {
    globalThis.fetch = prevFetch;
  }
});

async function runSuccessChain(engine: WorkflowEngine, store: WorkflowStore, dir: string, calls: string[]) {
  const w = store.save({
    name: '提醒链',
    steps: [
      { id: 's1', type: 'notification', config: { message: '开始收尾' } },
      { id: 's2', type: 'delay', config: { seconds: '1' } },
      { id: 's3', type: 'http', config: { url: 'https://example.com/hook', method: 'POST', body: '{}' } },
    ],
  });
  const run = await engine.run(w.id);
  equal(run.status, 'success');
  equal(run.log.length, 3);
  ok(calls.includes('notify:工作流 · 提醒链:开始收尾'));
  const runs = store.runs(w.id);
  equal(runs.length, 1);
  equal(runs[0].status, 'success');
  ok(readFileSync(join(dir, 'workflows', 'runs.json'), 'utf8').includes('提醒链'));
}

test('停用的工作流拒绝执行 + 不存在抛错（async → rejects）', async () => {
  const { engine, store } = makeEnv();
  const w = store.save({ name: '停用的', enabled: false, steps: [] });
  await rejects(() => engine.run(w.id), /已停用/);
  await rejects(() => engine.run('nope'), /不存在/);
});

test('运行记录标记触发来源：默认 manual', async () => {
  const { engine, store } = makeEnv();
  const w = store.save({ name: '来源标记', steps: [] });
  const r = await engine.run(w.id);
  equal(r.trigger, 'manual');
});

test('运行日志环形裁剪（≤50）', async () => {
  const { engine, store } = makeEnv();
  for (let i = 0; i < 7; i++) {
    const w = store.save({ name: `w${i}`, steps: [] });
    await engine.run(w.id);
  }
  equal(store.runs().length, 7);
  ok(true);
});

// ── v2：同工作流并发互斥 ──

test('互斥：上一次运行未结束 → 第二次拒绝；结束后可再次运行', async () => {
  const { engine, store } = makeEnv();
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const prevFetch = globalThis.fetch;
  (globalThis as { fetch: unknown }).fetch = (async () => {
    await gate;
    return { ok: true, status: 200 };
  }) as unknown as typeof fetch;
  try {
    const w = store.save({ name: '互斥', steps: [{ id: 's1', type: 'http', config: { url: 'https://example.com/x' } }] });
    const first = engine.run(w.id);
    await rejects(() => engine.run(w.id), /尚未结束/);
    release();
    const run = await first;
    equal(run.status, 'success');
    const second = await engine.run(w.id);
    equal(second.status, 'success');
  } finally {
    globalThis.fetch = prevFetch;
  }
});

// ── v2：connection-action 步骤 ──

test('connection-action：成功透传结果 / 失败 fail-fast / 缺连接配置报错', async () => {
  const calls: Array<[string, Record<string, string>]> = [];
  const { engine, store } = makeEnv({
    invokeAction: async (connectionId, params) => {
      calls.push([connectionId, params]);
      return connectionId === 'conn-ok'
        ? { ok: true, message: '短信已发送至 138****1111' }
        : { ok: false, message: '凭据无效' };
    },
  });
  const w1 = store.save({ name: '发短信', steps: [{ id: 's1', type: 'connection-action', config: { connectionId: 'conn-ok', params: '{"phoneNumbers":"13800001111"}' } }] });
  const r1 = await engine.run(w1.id);
  equal(r1.status, 'success');
  equal(r1.log[0].message, '短信已发送至 138****1111');
  deepEqual(calls[0], ['conn-ok', { phoneNumbers: '13800001111' }]);

  const w2 = store.save({ name: '失败链', steps: [{ id: 's1', type: 'connection-action', config: { connectionId: 'conn-bad', params: '{}' } }, { id: 's2', type: 'notification', config: { message: '不应到达' } }] });
  const r2 = await engine.run(w2.id);
  equal(r2.status, 'failed');
  equal(r2.log.length, 1);
  ok(r2.log[0].message.includes('凭据无效'));

  const w3 = store.save({ name: '缺配置', steps: [{ id: 's1', type: 'connection-action', config: { params: '{}' } }] });
  const r3 = await engine.run(w3.id);
  equal(r3.status, 'failed');
  ok(r3.log[0].message.includes('connectionId'));

  const w4 = store.save({ name: 'params 非 JSON', steps: [{ id: 's1', type: 'connection-action', config: { connectionId: 'conn-ok', params: 'not-json' } }] });
  const r4 = await engine.run(w4.id);
  equal(r4.status, 'failed');
  ok(r4.log[0].message.includes('JSON'));
});

test('connection-action：未装配 invokeAction → 明确报错', async () => {
  const { engine, store } = makeEnv();
  const w = store.save({ name: '未装配', steps: [{ id: 's1', type: 'connection-action', config: { connectionId: 'c1', params: '{}' } }] });
  const r = await engine.run(w.id);
  equal(r.status, 'failed');
  ok(r.log[0].message.includes('未装配'));
});

// ── v2：token-budget 步骤 ──

test('token-budget：未超限通过 / 超限 fail+notify / 阈值非法报错 / 未装配报错', async () => {
  const { engine, store, calls } = makeEnv({ tokenUsage: async (period) => ({ totalTokens: period === 'day' ? 900 : 5000 }) });

  const w1 = store.save({ name: '预算内', steps: [{ id: 's1', type: 'token-budget', config: { period: 'day', thresholdTokens: '1000' } }] });
  const r1 = await engine.run(w1.id);
  equal(r1.status, 'success');
  ok(r1.log[0].message.includes('900'));
  ok(r1.log[0].message.includes('今日'));

  const w2 = store.save({ name: '超限告警', steps: [{ id: 's1', type: 'token-budget', config: { period: 'day', thresholdTokens: '500', notifyOnExceed: 'true' } }] });
  const r2 = await engine.run(w2.id);
  equal(r2.status, 'failed');
  ok(r2.log[0].message.includes('900'));
  ok(r2.log[0].message.includes('500'));
  // §8.1：超限 = 步骤失败 = run 失败 = 失败自动通知统一承载（notifyOnExceed 被取代，置不置都发）
  ok(calls.some((c) => c.startsWith('notify:工作流 · 超限告警【失败】:')), '超限经失败自动通知，标题带工作流名+【失败】');

  const w3 = store.save({ name: '超限告警B', steps: [{ id: 's1', type: 'token-budget', config: { period: 'day', thresholdTokens: '500' } }] });
  await engine.run(w3.id);
  ok(calls.some((c) => c.startsWith('notify:工作流 · 超限告警B【失败】:')), '未置 notifyOnExceed 也发（语义已被失败自动通知取代）');

  const w4 = store.save({ name: '阈值非法', steps: [{ id: 's1', type: 'token-budget', config: { period: 'day', thresholdTokens: 'abc' } }] });
  const r4 = await engine.run(w4.id);
  equal(r4.status, 'failed');
  ok(r4.log[0].message.includes('thresholdTokens'));

  const { engine: bareEngine, store: bareStore } = makeEnv();
  const w5 = bareStore.save({ name: '未装配', steps: [{ id: 's1', type: 'token-budget', config: { period: 'day', thresholdTokens: '1' } }] });
  const r5 = await bareEngine.run(w5.id);
  equal(r5.status, 'failed');
  ok(r5.log[0].message.includes('未装配'));
});

// ── §8.1：失败自动通知 ──

test('失败自动通知：run 失败 → title 带工作流名【失败】+ 首条错误；成功 run 无【失败】通知', async () => {
  const { engine, store, calls } = makeEnv();
  const ok1 = store.save({ name: '全成功', steps: [{ id: 's1', type: 'notification', config: { message: '完成' } }] });
  await engine.run(ok1.id);
  equal(calls.filter((c) => c.includes('【失败】')).length, 0, '成功 run 不发失败通知');

  const w1 = store.save({
    name: '夜巡',
    steps: [
      { id: 's1', type: 'notification', config: { message: '开始' } },
      { id: 's2', type: 'http', config: { url: 'ftp://bad' } },
    ],
  });
  await engine.run(w1.id);
  const failNotifies = calls.filter((c) => c.startsWith('notify:工作流 · 夜巡【失败】:'));
  equal(failNotifies.length, 1, '失败发一次自动通知');
  ok(failNotifies[0].includes('http'), 'body 含首条失败 message');
  // 步骤通知仍带工作流名（§8.1 标注语义）
  ok(calls.includes('notify:工作流 · 夜巡:开始'));
});

test('失败自动通知：长 message 截断 120 字', async () => {
  const { engine: e2, store: s2, calls: calls2 } = makeEnv({
    invokeAction: async () => ({ ok: false, message: 'x'.repeat(200) }),
  });
  const w2 = s2.save({ name: '长错误B', steps: [{ id: 's1', type: 'connection-action', config: { connectionId: 'c', params: '{}' } }] });
  await e2.run(w2.id);
  const n = calls2.filter((c) => c.startsWith('notify:工作流 · 长错误B【失败】:'))[0];
  const body = n.split(':').slice(2).join(':');
  ok(body.length <= 121, `body 截断至 ≤120 字，实际 ${body.length}`);
});
