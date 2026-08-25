import { test } from 'node:test';
import { equal, deepEqual, ok } from 'node:assert/strict';
import { EventEmitter } from 'node:events';

import { PnpmRunner, NATIVE_DEP_PKGS } from './npmRunner';
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

function makeRunner(opts: {
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  onLine?: (l: string) => void;
  warns?: string[];
} = {}) {
  let lastChild = new FakeChild();
  let lastSpawn: { cmd: string; args: string[]; opts: PkgMgrSpawnOptions } | null = null;
  const spawns: Array<{ cmd: string; args: string[]; opts: PkgMgrSpawnOptions }> = [];
  const writes: string[] = [];
  const runner = new PnpmRunner({
    nodePath: '/usr/local/fake-node/bin/node',
    spawnFn: (cmd, args, o) => {
      lastSpawn = { cmd, args: [...args], opts: o };
      spawns.push(lastSpawn);
      lastChild = new FakeChild();
      return lastChild;
    },
    now: opts.now,
    sleep: opts.sleep,
    writePkgJson: (dir) => writes.push(dir),
    logger: opts.warns ? { info() {}, warn: (m) => opts.warns!.push(m), error() {}, dshLog() {} } : undefined,
  });
  return {
    runner,
    getChild: () => lastChild,
    getSpawn: () => lastSpawn,
    getSpawns: () => spawns,
    writes,
    runOpts: { registry: '', onLine: opts.onLine },
  };
}

test('pnpm ① 参数串：pnpm add / --prefix / prefer-symlinked-executables / 写 package.json', async () => {
  const { runner, getChild, getSpawn, getSpawns, writes, runOpts } = makeRunner();
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
  // P3：安装成功后追加 rebuild（第二次 spawn）
  const rebuild = getSpawns()[1];
  ok(rebuild, '安装成功后应追加 rebuild spawn');
  equal(rebuild.cmd, 'pnpm');
  deepEqual(rebuild.args, ['rebuild', ...NATIVE_DEP_PKGS]);
  getChild().emit('exit', 0, null); // rebuild 成功
  const r = await p;
  equal(r.ok, true);
});

test('pnpm ①b 安装成功 + rebuild 失败 → 仍返回 ok + 告警（CON-R-pkgmgr-003）', async () => {
  const warns: string[] = [];
  const { runner, getChild, getSpawns, runOpts } = makeRunner({ warns });
  const p = runner.install('/tmp/staging', '1.0.0', runOpts);
  getChild().emit('exit', 0, null); // 主 install 成功
  const rebuild = getSpawns()[1];
  ok(rebuild, '安装成功应触发 rebuild');
  getChild().emit('exit', 1, null); // rebuild 失败
  const r = await p;
  equal(r.ok, true, 'rebuild 失败不阻断安装');
  ok(warns.some((w) => w.includes('rebuild 失败')), '应产生 rebuild 失败告警');
});

test('pnpm ①c 安装成功 + rebuild spawn 失败 → 仍返回 ok + 告警', async () => {
  const warns: string[] = [];
  const { runner, getChild, getSpawns, runOpts } = makeRunner({ warns });
  const p = runner.install('/tmp/staging', '1.0.0', runOpts);
  getChild().emit('exit', 0, null);
  ok(getSpawns()[1], '安装成功应触发 rebuild');
  getChild().emit('error', new Error('ENOENT')); // rebuild spawn 失败
  const r = await p;
  equal(r.ok, true);
  ok(warns.some((w) => w.includes('rebuild 失败')), '应产生 rebuild 失败告警');
});

test('pnpm ①d ERR_PNPM_IGNORED_BUILDS exit 1 → 视为成功（良性退出，走 rebuild）——修复误判安装失败', async () => {
  const { runner, getChild, getSpawns, runOpts } = makeRunner();
  const p = runner.install('/tmp/staging', '1.0.0', runOpts);
  // pnpm 装完报 ERR_PNPM_IGNORED_BUILDS（原生依赖 build 被跳过，但安装本身成功）→ exit 1
  (getChild().stdout as unknown as EventEmitter).emit(
    'data',
    '[ERR_PNPM_IGNORED_BUILDS] Ignored build scripts: koffi@3.1.6, node-pty@1.2.0-beta.15\n'
  );
  getChild().emit('exit', 1, null);
  // 应视为成功 → 触发 rebuild
  const rebuild = getSpawns()[1];
  ok(rebuild, 'ignored-builds exit 1 应视为成功并触发 rebuild');
  equal(rebuild.cmd, 'pnpm');
  deepEqual(rebuild.args, ['rebuild', ...NATIVE_DEP_PKGS]);
  getChild().emit('exit', 0, null); // rebuild 成功
  const r = await p;
  equal(r.ok, true, 'ERR_PNPM_IGNORED_BUILDS 不应判为安装失败');
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
  const { runner, getChild, getSpawn, getSpawns } = makeRunner();
  const p = runner.install('/tmp/staging', 'latest', { registry: 'https://mirror.example.com' });
  equal(getSpawn()!.opts.env.npm_config_registry, 'https://mirror.example.com');
  getChild().emit('exit', 0, null);
  getChild().emit('exit', 0, null); // rebuild 成功
  const r = await p;
  equal(r.ok, true);
  ok(getSpawns().length === 2, '主 install + rebuild 两次 spawn');
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
