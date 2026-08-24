import { test } from 'node:test';
import { equal, ok } from 'node:assert/strict';
import { EventEmitter } from 'node:events';

import { createPkgMgrRunner, toRunNpmInstall } from './index';
import { NpmRunner, PnpmRunner, YarnRunner } from './npmRunner';

class FakeChild extends EventEmitter {
  exitCode: number | null = null;
  stdout: NodeJS.ReadableStream | null = new EventEmitter() as unknown as NodeJS.ReadableStream;
  stderr: NodeJS.ReadableStream | null = new EventEmitter() as unknown as NodeJS.ReadableStream;
  kill(): boolean {
    return true;
  }
}

test('工厂：按 name 返回对应实现（npm/pnpm/yarn；未知回退 npm）', () => {
  const base = { nodePath: '/usr/local/fake-node/bin/node' };
  ok(createPkgMgrRunner('npm', base) instanceof NpmRunner);
  ok(createPkgMgrRunner('pnpm', base) instanceof PnpmRunner);
  ok(createPkgMgrRunner('yarn', base) instanceof YarnRunner);
  // 非法值回退 npm（默认兼容；P3 接 settings.packageManager 非法值回退）
  ok(createPkgMgrRunner('bun' as 'npm', base) instanceof NpmRunner);
});

test('工厂：注入 spawnFn 生效（测试 seam）', async () => {
  const child = new FakeChild();
  const base = {
    nodePath: '/usr/local/fake-node/bin/node',
    spawnFn: () => child,
  };
  const runner = createPkgMgrRunner('npm', base);
  const p = runner.install('/tmp/staging', '1.0.0', { registry: '' });
  child.emit('exit', 0, null);
  const r = await p;
  ok(r.ok);
});

test('toRunNpmInstall：成功 → resolve；失败 → HullError 透传错误码', async () => {
  const child = new FakeChild();
  const runner = createPkgMgrRunner('npm', {
    nodePath: '/usr/local/fake-node/bin/node',
    spawnFn: () => child,
  });
  const fn = toRunNpmInstall(runner, { registry: '' });
  // 成功路径
  const p1 = fn('/tmp/staging', '1.0.0');
  child.emit('exit', 0, null);
  await p1; // 不抛
  // 失败路径（registry-unreachable）
  const child2 = new FakeChild();
  const runner2 = createPkgMgrRunner('npm', {
    nodePath: '/usr/local/fake-node/bin/node',
    spawnFn: () => child2,
  });
  const fn2 = toRunNpmInstall(runner2, { registry: '' });
  const p2 = fn2('/tmp/staging', '1.0.0');
  (child2.stderr as unknown as EventEmitter).emit('data', 'npm error code ENOTFOUND\n');
  child2.emit('exit', 1, null);
  let code: string | null = null;
  try {
    await p2;
  } catch (e) {
    code = (e as { code: string }).code;
  }
  equal(code, 'registry-unreachable');
});

test('toRunNpmInstall：非零退出（无网络码）→ npm-install-failed', async () => {
  const child = new FakeChild();
  const runner = createPkgMgrRunner('npm', {
    nodePath: '/usr/local/fake-node/bin/node',
    spawnFn: () => child,
  });
  const fn = toRunNpmInstall(runner, { registry: '' });
  const p = fn('/tmp/staging', '1.0.0');
  child.emit('exit', 1, null);
  let code: string | null = null;
  try {
    await p;
  } catch (e) {
    code = (e as { code: string }).code;
  }
  equal(code, 'npm-install-failed');
});
