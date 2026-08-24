import { test } from 'node:test';
import { equal, deepEqual, ok } from 'node:assert/strict';
import { EventEmitter } from 'node:events';

import { PnpmRunner } from './npmRunner';
import type { PkgMgrSpawnOptions } from './types';

class FakeChild extends EventEmitter {
  pid = 8888;
  exitCode: number | null = null;
  stdout: NodeJS.ReadableStream | null = new EventEmitter() as unknown as NodeJS.ReadableStream;
  stderr: NodeJS.ReadableStream | null = new EventEmitter() as unknown as NodeJS.ReadableStream;
  killed: (NodeJS.Signals | number)[] = [];
  kill(signal?: NodeJS.Signals | number): boolean {
    this.killed.push(signal ?? 'SIGTERM');
    return true;
  }
}

function makeRunner(opts: { now?: () => number; sleep?: (ms: number) => Promise<void>; onLine?: (l: string) => void } = {}) {
  let lastChild = new FakeChild();
  let lastSpawn: { cmd: string; args: string[]; opts: PkgMgrSpawnOptions } | null = null;
  const writes: string[] = [];
  const runner = new PnpmRunner({
    nodePath: '/usr/local/fake-node/bin/node',
    spawnFn: (cmd, args, o) => {
      lastSpawn = { cmd, args: [...args], opts: o };
      lastChild = new FakeChild();
      return lastChild;
    },
    now: opts.now,
    sleep: opts.sleep,
    writePkgJson: (dir) => writes.push(dir),
  });
  return {
    runner,
    getChild: () => lastChild,
    getSpawn: () => lastSpawn,
    writes,
    runOpts: { registry: '', onLine: opts.onLine },
  };
}

test('pnpm ① 参数串：pnpm add / --prefix / prefer-symlinked-executables / 写 package.json', async () => {
  const { runner, getChild, getSpawn, writes, runOpts } = makeRunner();
  const p = runner.install('/tmp/staging', '1.0.0', runOpts);
  const s = getSpawn();
  equal(s!.cmd, 'pnpm');
  deepEqual(s!.args, [
    'add',
    '@deepseek-ai/dsh@1.0.0',
    '--prefix',
    '/tmp/staging',
    '--config.prefer-symlinked-executables=true',
  ]);
  equal(s!.opts.cwd, '/tmp/staging');
  deepEqual(writes, ['/tmp/staging']); // staging 根 package.json 先写
  getChild().emit('exit', 0, null);
  const r = await p;
  equal(r.ok, true);
});

test('pnpm ② ERR_PNPM_FETCH_404 → registry-unreachable（错误格式适配）', async () => {
  const { runner, getChild, runOpts } = makeRunner();
  const p = runner.install('/tmp/staging', '1.0.0', runOpts);
  (getChild().stderr as unknown as EventEmitter).emit('data', 'ERR_PNPM_FETCH_404 GET https://registry.example.com/@deepseek-ai%2fdsh: Not Found\n');
  getChild().emit('exit', 1, null);
  const r = await p;
  equal(r.ok, false);
  equal(r.code, 'registry-unreachable');
});

test('pnpm ③ 原始网络错误码行 → registry-unreachable', async () => {
  const { runner, getChild, runOpts } = makeRunner();
  const p = runner.install('/tmp/staging', '1.0.0', runOpts);
  (getChild().stderr as unknown as EventEmitter).emit('data', 'fetch failed: connect ECONNREFUSED 127.0.0.1:4873\n');
  getChild().emit('exit', 1, null);
  const r = await p;
  equal(r.code, 'registry-unreachable');
});

test('pnpm ④ 非零退出（无网络错误码）→ npm-install-failed', async () => {
  const { runner, getChild, runOpts } = makeRunner();
  const p = runner.install('/tmp/staging', '1.0.0', runOpts);
  getChild().emit('exit', 1, null);
  const r = await p;
  equal(r.ok, false);
  equal(r.code, 'npm-install-failed');
});

test('pnpm ⑤ registry env 透传 → npm_config_registry（pnpm 识别同一变量）', async () => {
  const { runner, getChild, getSpawn } = makeRunner();
  const p = runner.install('/tmp/staging', 'latest', { registry: 'https://mirror.example.com' });
  equal(getSpawn()!.opts.env.npm_config_registry, 'https://mirror.example.com');
  getChild().emit('exit', 0, null);
  await p;
});

test('pnpm ⑥ onLine 逐行回调 + 取消（cancelled 不误映射）', async () => {
  const lines: string[] = [];
  const { runner, getChild } = makeRunner({ onLine: (l) => lines.push(l) });
  const p = runner.install('/tmp/staging', '1.0.0', { registry: '', onLine: (l) => lines.push(l) });
  (getChild().stdout as unknown as EventEmitter).emit('data', 'Progress: resolved 10\n');
  runner.cancel();
  getChild().emit('exit', 1, 'SIGTERM');
  const r = await p;
  equal(r.ok, false);
  equal(r.code, 'cancelled');
  deepEqual(lines, ['Progress: resolved 10']);
});

test('pnpm ⑦ 超时：kill + npm-install-failed（now/sleep 快进）', async () => {
  let t = 0;
  const { runner, getChild, runOpts } = makeRunner({
    now: () => t,
    sleep: async () => {
      t += 100;
    },
  });
  const p = runner.install('/tmp/staging', '1.0.0', runOpts);
  const r = await p;
  equal(r.ok, false);
  equal(r.code, 'npm-install-failed');
  ok(r.error?.includes('超时'));
  deepEqual(getChild().killed, ['SIGTERM', 'SIGKILL']);
});

test('pnpm ⑧ spawn 失败 → npm-install-failed', async () => {
  const { runner, getChild, runOpts } = makeRunner();
  const p = runner.install('/tmp/staging', '1.0.0', runOpts);
  getChild().emit('error', new Error('ENOENT'));
  const r = await p;
  equal(r.ok, false);
  equal(r.code, 'npm-install-failed');
  ok(r.error?.includes('spawn 失败'));
});
