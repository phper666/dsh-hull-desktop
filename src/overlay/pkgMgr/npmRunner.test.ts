import { test } from 'node:test';
import { equal, deepEqual, ok, rejects } from 'node:assert/strict';
import { EventEmitter } from 'node:events';

import { NpmRunner } from './npmRunner';
import { toRunNpmInstall } from './index';
import type { PkgMgrSpawnOptions } from './types';

class FakeChild extends EventEmitter {
  pid = 9999;
  exitCode: number | null = null;
  stdout: NodeJS.ReadableStream | null = new EventEmitter() as unknown as NodeJS.ReadableStream;
  stderr: NodeJS.ReadableStream | null = new EventEmitter() as unknown as NodeJS.ReadableStream;
  killed: (NodeJS.Signals | number)[] = [];
  kill(signal?: NodeJS.Signals | number): boolean {
    this.killed.push(signal ?? 'SIGTERM');
    return true;
  }
}

function makeRunner(opts: { now?: () => number; sleep?: (ms: number) => Promise<void>; onLine?: (l: string) => void; registry?: string } = {}) {
  let lastChild = new FakeChild();
  let lastSpawn: { cmd: string; args: string[]; opts: PkgMgrSpawnOptions } | null = null;
  const runner = new NpmRunner({
    nodePath: '/usr/local/fake-node/bin/node',
    spawnFn: (cmd, args, o) => {
      lastSpawn = { cmd, args: [...args], opts: o };
      lastChild = new FakeChild();
      return lastChild;
    },
    now: opts.now,
    sleep: opts.sleep,
  });
  const runOpts = { registry: opts.registry ?? '', onLine: opts.onLine };
  return { runner, getChild: () => lastChild, getSpawn: () => lastSpawn, runOpts };
}

test('① npm 参数串：npm-cli 路径 / install 包名 / --prefix / --fetch-timeout / --prefer-offline / --loglevel=http', async () => {
  const { runner, getChild, getSpawn, runOpts } = makeRunner();
  const p = runner.install('/tmp/staging', '1.0.0', runOpts);
  const s = getSpawn();
  equal(s!.cmd, '/usr/local/fake-node/bin/node');
  deepEqual(s!.args, [
    '/usr/local/fake-node/lib/node_modules/npm/bin/npm-cli.js',
    'install',
    '@deepseek-ai/dsh@1.0.0',
    '--prefix',
    '/tmp/staging',
    '--fetch-timeout=30000',
    '--prefer-offline',
    '--loglevel=http',
  ]);
  equal(s!.opts.cwd, '/tmp/staging');
  getChild().emit('exit', 0, null);
  const r = await p;
  equal(r.ok, true);
});

test('② registry env 透传：opts.registry → npm_config_registry；空 → HULL_REGISTRY 兜底', async () => {
  const prev = process.env.HULL_REGISTRY;
  process.env.HULL_REGISTRY = 'https://mirror.example.com';
  try {
    const { runner, getChild, getSpawn } = makeRunner({ registry: 'https://opts.example.com' });
    const p = runner.install('/tmp/staging', 'latest', { registry: 'https://opts.example.com' });
    equal(getSpawn()!.opts.env.npm_config_registry, 'https://opts.example.com');
    getChild().emit('exit', 0, null);
    await p;
  } finally {
    if (prev === undefined) delete process.env.HULL_REGISTRY;
    else process.env.HULL_REGISTRY = prev;
  }
  // 无 registry opts + HULL_REGISTRY → env 兜底
  process.env.HULL_REGISTRY = 'https://mirror.example.com';
  try {
    const { runner: r2, getChild: c2, getSpawn: s2 } = makeRunner();
    const p2 = r2.install('/tmp/staging', 'latest', { registry: '' });
    equal(s2()!.opts.env.npm_config_registry, 'https://mirror.example.com');
    c2().emit('exit', 0, null);
    await p2;
  } finally {
    if (prev === undefined) delete process.env.HULL_REGISTRY;
    else process.env.HULL_REGISTRY = prev;
  }
  // 无 registry 无 HULL_REGISTRY → 不设 npm_config_registry（默认官方）
  const { runner: r3, getChild: c3, getSpawn: s3 } = makeRunner();
  const p3 = r3.install('/tmp/staging', 'latest', { registry: '' });
  equal(s3()!.opts.env.npm_config_registry, undefined);
  c3().emit('exit', 0, null);
  await p3;
});

test('③ 非零退出（无网络错误码）→ npm-install-failed', async () => {
  const { runner, getChild, runOpts } = makeRunner();
  const p = runner.install('/tmp/staging', '1.0.0', runOpts);
  getChild().emit('exit', 1, null);
  const r = await p;
  equal(r.ok, false);
  equal(r.code, 'npm-install-failed');
});

test('④ npm error code ECONNREFUSED → registry-unreachable', async () => {
  const { runner, getChild, runOpts } = makeRunner();
  const p = runner.install('/tmp/staging', '1.0.0', runOpts);
  (getChild().stderr as unknown as EventEmitter).emit('data', 'npm error code ECONNREFUSED\n');
  (getChild().stderr as unknown as EventEmitter).emit('data', 'npm error FetchError: connect ECONNREFUSED\n');
  getChild().emit('exit', 1, null);
  const r = await p;
  equal(r.code, 'registry-unreachable');
});

test('⑤ 超时：kill + npm-install-failed（now/sleep 快进）', async () => {
  let t = 0;
  const { runner, getChild, runOpts } = makeRunner({
    now: () => t,
    sleep: async () => {
      t += 100;
    },
  });
  const p = runner.install('/tmp/staging', '1.0.0', runOpts);
  const r = await p; // 快进 → 超时
  equal(r.ok, false);
  equal(r.code, 'npm-install-failed');
  ok(r.error?.includes('超时'));
  deepEqual(getChild().killed, ['SIGTERM', 'SIGKILL']);
});

test('⑥ cancel 标志：主动 kill 后非零退出 → cancelled 不误映射', async () => {
  const { runner, getChild, runOpts } = makeRunner({ sleep: async () => {} }); // 即时 sleep：不留挂起宽限定时器
  const p = runner.install('/tmp/staging', '1.0.0', runOpts);
  runner.cancel();
  getChild().emit('exit', 1, 'SIGTERM');
  const r = await p;
  equal(r.ok, false);
  equal(r.code, 'cancelled');
});

test('⑦ 内联 kill：SIGTERM → 宽限未退 → SIGKILL', async () => {
  let t = 0;
  const { runner, getChild, runOpts } = makeRunner({
    now: () => t,
    sleep: async () => {
      t += 100;
    },
  });
  const p = runner.install('/tmp/staging', '1.0.0', runOpts);
  runner.cancel();
  deepEqual(getChild().killed, ['SIGTERM']); // SIGTERM 同步发出
  await p; // fake child 不退 → 超时/取消路径 settle
  deepEqual(getChild().killed, ['SIGTERM', 'SIGKILL']);
});

test('⑧ 输出行回调逐行 + 错误码行提取（跨 chunk 半行重组）', async () => {
  const lines: string[] = [];
  const { runner, getChild, runOpts } = makeRunner({ onLine: (l) => lines.push(l) });
  const p = runner.install('/tmp/staging', '1.0.0', runOpts);
  (getChild().stdout as unknown as EventEmitter).emit('data', 'added 1 package\n');
  (getChild().stderr as unknown as EventEmitter).emit('data', 'npm error co');
  (getChild().stderr as unknown as EventEmitter).emit('data', 'de ECONNREFUSED\nnpm error extra line\n');
  getChild().emit('exit', 1, null);
  const r = await p;
  deepEqual(lines, ['added 1 package', 'npm error code ECONNREFUSED', 'npm error extra line']);
  equal(r.code, 'registry-unreachable');
});

test('⑨ toRunNpmInstall 适配器：registry-unreachable 透传为 HullError code', async () => {
  const { runner, getChild } = makeRunner();
  const fn = toRunNpmInstall(runner, { registry: '' });
  const p = fn('/tmp/staging', '1.0.0');
  (getChild().stderr as unknown as EventEmitter).emit('data', 'npm error code ENOTFOUND\n');
  getChild().emit('exit', 1, null);
  await rejects(p, (e: unknown) => (e as { code: string }).code === 'registry-unreachable');
});

test('S6-⑪ settings.registry 优先于 env（opts.registry 注入）', async () => {
  const prev = process.env.HULL_REGISTRY;
  process.env.HULL_REGISTRY = 'https://env.example.com';
  try {
    const { runner, getChild, getSpawn } = makeRunner();
    const p = runner.install('/tmp/staging', 'latest', { registry: 'https://settings.example.com' });
    equal(getSpawn()!.opts.env.npm_config_registry, 'https://settings.example.com', 'settings 优先于 env');
    getChild().emit('exit', 0, null);
    await p;
  } finally {
    if (prev === undefined) delete process.env.HULL_REGISTRY;
    else process.env.HULL_REGISTRY = prev;
  }
});

test('S6-⑫ env 兜底（无 registry opts）', async () => {
  const prev = process.env.HULL_REGISTRY;
  process.env.HULL_REGISTRY = 'https://env.example.com';
  try {
    const { runner, getChild, getSpawn } = makeRunner();
    const p = runner.install('/tmp/staging', 'latest', { registry: '' });
    equal(getSpawn()!.opts.env.npm_config_registry, 'https://env.example.com');
    getChild().emit('exit', 0, null);
    await p;
  } finally {
    if (prev === undefined) delete process.env.HULL_REGISTRY;
    else process.env.HULL_REGISTRY = prev;
  }
});
