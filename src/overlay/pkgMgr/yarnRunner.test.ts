import { test } from 'node:test';
import { equal, deepEqual, ok } from 'node:assert/strict';
import { EventEmitter } from 'node:events';

import { YarnRunner, COREPACK_YARN_VERSION } from './npmRunner';
import type { PkgMgrSpawnOptions } from './types';

class FakeChild extends EventEmitter {
  pid = 7777;
  exitCode: number | null = null;
  stdout: NodeJS.ReadableStream | null = new EventEmitter() as unknown as NodeJS.ReadableStream;
  stderr: NodeJS.ReadableStream | null = new EventEmitter() as unknown as NodeJS.ReadableStream;
  killed: (NodeJS.Signals | number)[] = [];
  kill(signal?: NodeJS.Signals | number): boolean {
    this.killed.push(signal ?? 'SIGTERM');
    return true;
  }
}

function makeRunner(opts: { now?: () => number; sleep?: (ms: number) => Promise<void>; onLine?: (l: string) => void; corepackHome?: string } = {}) {
  let lastChild = new FakeChild();
  let lastSpawn: { cmd: string; args: string[]; opts: PkgMgrSpawnOptions } | null = null;
  const writes: string[] = [];
  const writesFiles: Array<{ dir: string; name: string; content: string }> = [];
  const runner = new YarnRunner({
    nodePath: '/usr/local/fake-node/bin/node',
    spawnFn: (cmd, args, o) => {
      lastSpawn = { cmd, args: [...args], opts: o };
      lastChild = new FakeChild();
      return lastChild;
    },
    now: opts.now,
    sleep: opts.sleep,
    writePkgJson: (dir) => writes.push(dir),
    writeFile: (dir, name, content) => writesFiles.push({ dir, name, content }),
    corepackHome: opts.corepackHome,
  });
  return {
    runner,
    getChild: () => lastChild,
    getSpawn: () => lastSpawn,
    writes,
    writesFiles,
    runOpts: { registry: '', onLine: opts.onLine },
  };
}

const COREPACK_BIN = '/usr/local/fake-node/bin/corepack';

test('yarn ① 参数串：corepack yarn@<固定版本> add / cwd=staging / 写 package.json + .yarnrc.yml(nodeLinker=node-modules)', async () => {
  const { runner, getChild, getSpawn, writes, writesFiles, runOpts } = makeRunner();
  const p = runner.install('/tmp/staging', '1.0.0', runOpts);
  const s = getSpawn();
  equal(s!.cmd, COREPACK_BIN); // corepack 从 nodePath 推导（捆绑 node 同 bin 目录）
  deepEqual(s!.args, [`yarn@${COREPACK_YARN_VERSION}`, 'add', '@deepseek-ai/dsh@1.0.0']);
  equal(s!.opts.cwd, '/tmp/staging');
  deepEqual(writes, ['/tmp/staging']); // staging 根 package.json 先写
  // yarn 4 需 nodeLinker=node-modules（否则 PnP 布局，壳 spawn 不兼容）
  deepEqual(writesFiles, [{ dir: '/tmp/staging', name: '.yarnrc.yml', content: 'nodeLinker: node-modules\n' }]);
  getChild().emit('exit', 0, null);
  const r = await p;
  equal(r.ok, true);
});

test('yarn ①b COREPACK_HOME env 注入 → 壳控缓存目录', async () => {
  const { runner, getChild, getSpawn } = makeRunner({ corepackHome: '/tmp/userdata/corepack' });
  const p = runner.install('/tmp/staging', '1.0.0', { registry: '' });
  equal(getSpawn()!.opts.env.COREPACK_HOME, '/tmp/userdata/corepack');
  getChild().emit('exit', 0, null);
  const r = await p;
  equal(r.ok, true);
});

test('yarn ② `error ENOTFOUND:` 行 → registry-unreachable（错误格式适配）', async () => {
  const { runner, getChild, runOpts } = makeRunner();
  const p = runner.install('/tmp/staging', '1.0.0', runOpts);
  (getChild().stderr as unknown as EventEmitter).emit('data', "error An unexpected error occurred: \"https://registry.npmjs.org: ENOTFOUND\".\n");
  getChild().emit('exit', 1, null);
  const r = await p;
  equal(r.ok, false);
  equal(r.code, 'registry-unreachable');
});

test('yarn ③ 原始网络错误码行 → registry-unreachable', async () => {
  const { runner, getChild, runOpts } = makeRunner();
  const p = runner.install('/tmp/staging', '1.0.0', runOpts);
  (getChild().stderr as unknown as EventEmitter).emit('data', 'info There appears to be trouble with your network connection. Retrying...\n');
  (getChild().stderr as unknown as EventEmitter).emit('data', 'error fetch failed: ECONNRESET\n');
  getChild().emit('exit', 1, null);
  const r = await p;
  equal(r.code, 'registry-unreachable');
});

test('yarn ④ 非零退出（无网络错误码）→ npm-install-failed', async () => {
  const { runner, getChild, runOpts } = makeRunner();
  const p = runner.install('/tmp/staging', '1.0.0', runOpts);
  getChild().emit('exit', 1, null);
  const r = await p;
  equal(r.ok, false);
  equal(r.code, 'npm-install-failed');
});

test('yarn ⑤ registry env 透传 → npm_config_registry（yarn 识别同一变量）', async () => {
  const { runner, getChild, getSpawn } = makeRunner();
  const p = runner.install('/tmp/staging', 'latest', { registry: 'https://mirror.example.com' });
  equal(getSpawn()!.opts.env.npm_config_registry, 'https://mirror.example.com');
  getChild().emit('exit', 0, null);
  await p;
});

test('yarn ⑥ onLine 逐行回调 + 取消（cancelled 不误映射）', async () => {
  const lines: string[] = [];
  const { runner, getChild } = makeRunner({ onLine: (l) => lines.push(l) });
  const p = runner.install('/tmp/staging', '1.0.0', { registry: '', onLine: (l) => lines.push(l) });
  (getChild().stdout as unknown as EventEmitter).emit('data', 'success Saved lockfile.\n');
  runner.cancel();
  getChild().emit('exit', 1, 'SIGTERM');
  const r = await p;
  equal(r.ok, false);
  equal(r.code, 'cancelled');
  deepEqual(lines, ['success Saved lockfile.']);
});

test('yarn ⑦ 超时：kill + npm-install-failed（now/sleep 快进）', async () => {
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
