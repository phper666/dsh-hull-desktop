import { test } from 'node:test';
import { deepEqual, equal, ok, rejects } from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { join } from 'node:path';

import { NOOP_LOGGER } from '../shared/types';
import type { ChildLike } from '../shared/types';

import { DshCliRunner, type DshCliOptions } from './cli';
import { PluginError } from './errors';

const BIN = join('/tmp', 'ud', 'dsh', 'bin', 'dsh');

/** 可控 fake dsh 子进程：数据注入/close 全同步（EventEmitter，无流时序问题） */
class FakeChild extends EventEmitter {
  killed: string[] = [];
  exitCode: number | null = null;
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  kill(sig?: NodeJS.Signals | number): boolean {
    this.killed.push(String(sig ?? 'SIGTERM'));
    return true;
  }
}

function makeRunner(over: Partial<DshCliOptions> = {}) {
  const children: FakeChild[] = [];
  const spawnCalls: Array<{ cmd: string; args: string[]; opts: { env: NodeJS.ProcessEnv; stdio: ['pipe', 'pipe', 'pipe'] } }> = [];
  const runner = new DshCliRunner({
    userDataPath: '/tmp/ud',
    profile: 'hull',
    logger: NOOP_LOGGER,
    sleepImpl: async () => {},
    spawnImpl: (cmd, args, opts) => {
      const c = new FakeChild();
      children.push(c);
      spawnCalls.push({ cmd, args, opts });
      return c as unknown as ChildLike;
    },
    ...over,
  });
  return { runner, children, spawnCalls };
}

test('参数组装：spawn(node, [bin, plugin, --profile, hull, cmd, ...args])，stdin/out/err 全 pipe', async () => {
  const { runner, children, spawnCalls } = makeRunner();
  const p = runner.run('add', ['https://github.com/o/hello']);
  const c = children[0]!;
  deepEqual(spawnCalls[0]!.args, [BIN, 'plugin', '--profile', 'hull', 'add', 'https://github.com/o/hello']);
  deepEqual(spawnCalls[0]!.opts.stdio, ['pipe', 'pipe', 'pipe']);
  ok(typeof spawnCalls[0]!.opts.env === 'object');
  c.emit('close', 0, null);
  const res = await p;
  ok(res.ok);
});

test('update/remove/list 命令透传', async () => {
  const { runner, children, spawnCalls } = makeRunner();
  const p1 = runner.run('update', ['a']);
  children[0]!.emit('close', 0, null);
  await p1;
  deepEqual(spawnCalls[0]!.args, [BIN, 'plugin', '--profile', 'hull', 'update', 'a']);

  const p2 = runner.run('remove', ['a']);
  children[1]!.emit('close', 0, null);
  await p2;
  deepEqual(spawnCalls[1]!.args, [BIN, 'plugin', '--profile', 'hull', 'remove', 'a']);

  const p3 = runner.run('list');
  children[2]!.emit('close', 0, null);
  await p3;
  deepEqual(spawnCalls[2]!.args, [BIN, 'plugin', '--profile', 'hull', 'list']);
});

test('JSON 输出：优先解析为 parsed，stdout 原样保留', async () => {
  const { runner, children } = makeRunner();
  const p = runner.run('list');
  const c = children[0]!;
  c.stdout.emit('data', '{"plugins":[{"id":"a","name":"A","version":"1.0.0"}]}');
  c.emit('close', 0, null);
  const res = await p;
  if (!res.ok) {
    ok(false, `expected ok, got code=${String(res.code)}`);
    return;
  }
  const parsed = res.parsed as { plugins: Array<{ name: string }> };
  equal(parsed.plugins[0]!.name, 'A');
  equal(res.stdout, '{"plugins":[{"id":"a","name":"A","version":"1.0.0"}]}');
});

test('文本输出：parsed 缺省，stdout 原样保留（调用方行解析）', async () => {
  const { runner, children } = makeRunner();
  const p = runner.run('list');
  const c = children[0]!;
  c.stdout.emit('data', 'foo@1.0.0\nbar\n');
  c.emit('close', 0, null);
  const res = await p;
  if (!res.ok) {
    ok(false, `expected ok, got code=${String(res.code)}`);
    return;
  }
  equal(res.parsed, undefined);
  equal(res.stdout, 'foo@1.0.0\nbar\n');
});

test('非零退出：ok:false + code 透传 + stderrTail + message 含退出码', async () => {
  const { runner, children } = makeRunner();
  const p = runner.run('remove', ['x']);
  const c = children[0]!;
  c.stderr.emit('data', 'boom: profile not found');
  c.emit('close', 3, null);
  const res = await p;
  equal(res.ok, false);
  if (!res.ok) {
    equal(res.code, 3);
    equal(res.stderrTail, 'boom: profile not found');
    ok(res.message.includes('3'));
  }
});

test('stderr 截断 ≤2KB：保留尾部', async () => {
  const { runner, children } = makeRunner();
  const p = runner.run('add', ['u']);
  const c = children[0]!;
  c.stderr.emit('data', 'x'.repeat(5000));
  c.emit('close', 1, null);
  const res = await p;
  ok(!res.ok);
  if (!res.ok) equal(res.stderrTail, 'x'.repeat(2048));
});

test('超时：SIGTERM → 宽限（sleepImpl no-op）→ SIGKILL → code=timeout', async () => {
  const { runner, children } = makeRunner({ timeoutMs: 30 });
  const p = runner.run('add', ['u']);
  const c = children[0]!;
  await new Promise((r) => setTimeout(r, 50)); // 主超时触发 + 宽限微任务
  deepEqual(c.killed, ['SIGTERM', 'SIGKILL']);
  c.emit('close', null, 'SIGKILL');
  const res = await p;
  equal(res.ok, false);
  if (!res.ok) equal(res.code, 'timeout');
});

test('超时兜底：SIGKILL 后子进程不 emit close（kill ESRCH）→ 二次超时强制 resolve + inflight 复位', async () => {
  const { runner, children } = makeRunner({ timeoutMs: 30 });
  const p = runner.run('add', ['u']);
  const c = children[0]!;
  await new Promise((r) => setTimeout(r, 50)); // 主超时触发 + SIGTERM/SIGKILL
  deepEqual(c.killed, ['SIGTERM', 'SIGKILL']);
  // 故意不 emit close：子进程假死（kill ESRCH 场景）
  const res = await p; // 二次超时（2s 兜底）强制 resolve
  equal(res.ok, false);
  if (!res.ok) equal(res.code, 'timeout');
  equal(runner.inflightCount, 0, 'inflight 复位，杜绝后续全 plugin-busy');
});

test('in-flight：并发 run 拒绝 plugin-busy，完成后复位', async () => {
  const { runner, children } = makeRunner();
  const p1 = runner.run('list');
  await rejects(runner.run('list'), (err: unknown) => err instanceof PluginError && err.code === 'plugin-busy');
  equal(runner.inflightCount, 1);
  children[0]!.emit('close', 0, null);
  const r1 = await p1;
  ok(r1.ok);
  equal(runner.inflightCount, 0);
});

test('spawn 失败：ok:false code=spawn-failed', async () => {
  const { runner } = makeRunner({
    spawnImpl: () => {
      throw new Error('ENOENT');
    },
  });
  const res = await runner.run('list');
  equal(res.ok, false);
  if (!res.ok) equal(res.code, 'spawn-failed');
});

test('HULL_E2E=1 + failAt=plugin-<cmd>:exit → 启动即杀（e2e 崩溃窗口）', async () => {
  const old = process.env.HULL_E2E;
  process.env.HULL_E2E = '1';
  try {
    const { runner, children } = makeRunner({ failAt: 'plugin-add:exit' });
    const p = runner.run('add', ['u']);
    const c = children[0]!;
    deepEqual(c.killed, ['SIGTERM']);
    c.emit('close', null, 'SIGTERM');
    const res = await p;
    equal(res.ok, false);
    if (!res.ok) equal(res.code, 'killed');
  } finally {
    if (old === undefined) delete process.env.HULL_E2E;
    else process.env.HULL_E2E = old;
  }
});

test('HULL_E2E 未置位时 failAt 不生效', async () => {
  const old = process.env.HULL_E2E;
  delete process.env.HULL_E2E;
  try {
    const { runner, children } = makeRunner({ failAt: 'plugin-add:exit' });
    const p = runner.run('add', ['u']);
    const c = children[0]!;
    deepEqual(c.killed, []);
    c.emit('close', 0, null);
    const res = await p;
    ok(res.ok);
  } finally {
    if (old !== undefined) process.env.HULL_E2E = old;
  }
});
