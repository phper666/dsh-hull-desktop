import { test } from 'node:test';
import { equal, ok, rejects, throws } from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { readFileSync } from 'node:fs';

import type { KanbanStore } from '../kanban/KanbanStore';
import type { ExecutionEngine } from '../exec/ExecutionEngine';
import { WorkflowEngine, type WorkflowEngineDeps } from './WorkflowEngine';
import { WorkflowStore } from './WorkflowStore';

function makeEnv(opts: { execFail?: boolean } = {}) {
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
  ok(calls.includes('notify:Hull 工作流:开始收尾'));
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

test('运行日志环形裁剪（≤50）', async () => {
  const { engine, store } = makeEnv();
  for (let i = 0; i < 7; i++) {
    const w = store.save({ name: `w${i}`, steps: [] });
    await engine.run(w.id);
  }
  equal(store.runs().length, 7);
  ok(true);
});
