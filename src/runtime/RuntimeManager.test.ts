import { test, after } from 'node:test';
import { equal, deepEqual, ok, throws, rejects } from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { RuntimeManager, type CrashInfo, type RuntimeLogger, type SpawnFn } from './RuntimeManager';
import { RuntimePhase } from '../shared/types';
import type { ProbeResult } from './ReadinessProbe';

const OK_RESULT: ProbeResult = { ok: true, url: 'http://127.0.0.1:53421' };

const tempDirs: string[] = [];
after(() => {
  for (const d of tempDirs) rmSync(d, { recursive: true, force: true });
});

/** fake child：EventEmitter + ChildProcess 形状（pid/exitCode/stdout/stderr/kill 记录） */
class FakeChild extends EventEmitter {
  pid = 4242;
  exitCode: number | null = null;
  stdout: NodeJS.ReadableStream | null = new EventEmitter() as unknown as NodeJS.ReadableStream;
  stderr: NodeJS.ReadableStream | null = new EventEmitter() as unknown as NodeJS.ReadableStream;
  killed: (NodeJS.Signals | number)[] = [];
  kill(signal?: NodeJS.Signals | number): boolean {
    this.killed.push(signal ?? 'SIGTERM');
    return true;
  }
}

/** 暴露受保护成员供测试：transition / _onChildExit */
class ExposedManager extends RuntimeManager {
  callTransition(to: RuntimePhase, message: string): boolean {
    return this.transition(to, message);
  }
  emitChildExit(code: number | null, signal: NodeJS.Signals | null): void {
    this._onChildExit(code, signal);
  }
}

interface MakeManagerOptions {
  probeResult?: ProbeResult | 'pending';
  withOverlay?: boolean;
  killFn?: (pid: number, signal: NodeJS.Signals | number) => boolean;
  logger?: RuntimeLogger;
}

function makeManager(dev = false, opts: MakeManagerOptions = {}) {
  const userDataPath = mkdtempSync(join(tmpdir(), 'hull-test-'));
  tempDirs.push(userDataPath);
  if (opts.withOverlay !== false) mkdirSync(join(userDataPath, 'dsh'), { recursive: true });
  const probeResult: ProbeResult | 'pending' = opts.probeResult ?? 'pending';
  let spawnCalls = 0;
  let lastChild = new FakeChild();
  let lastSpawn: { cmd: string; args: readonly string[] } | null = null;
  const spawnFn: SpawnFn = (cmd, args) => {
    spawnCalls += 1;
    lastChild = new FakeChild();
    lastSpawn = { cmd, args };
    return lastChild;
  };
  const probeFactory = () => ({
    probe: async () => (probeResult === 'pending' ? new Promise<ProbeResult>(() => {}) : probeResult),
  });
  const mgr = new ExposedManager({
    dev,
    userDataPath,
    spawnFn,
    probeFactory,
    sleep: async () => {}, // 快进：跳过 SIGTERM→SIGKILL 宽限真实等待
    ...(opts.killFn ? { killFn: opts.killFn } : {}),
    ...(opts.logger ? { logger: opts.logger } : {}),
  });
  return { mgr, userDataPath, getSpawnCalls: () => spawnCalls, getChild: () => lastChild, getLastSpawn: () => lastSpawn };
}

const pidFile = (userDataPath: string) => join(userDataPath, 'dsh.pid');

test('① idle→starting→ready 合法迁移 + status 事件序列', async () => {
  const { mgr } = makeManager(false, { probeResult: OK_RESULT });
  const phases: string[] = [];
  mgr.on('status', (s) => phases.push(s.phase));
  equal(mgr.snapshot().phase, 'idle');
  const s = await mgr.start();
  equal(s.phase, 'ready');
  equal(s.url, 'http://127.0.0.1:53421');
  deepEqual(phases, ['starting', 'ready']);
});

test('② 非法迁移：dev 下 throw，prod 下 log 忽略', async () => {
  const dev = makeManager(true);
  throws(() => dev.mgr.callTransition(RuntimePhase.Ready, 'x'), /非法状态迁移: idle -> ready/);
  const prod = makeManager(false);
  equal(prod.mgr.callTransition(RuntimePhase.Ready, 'x'), false);
  equal(prod.mgr.snapshot().phase, 'idle');
});

test('③ starting 中重复 start 忽略（spawn 只调 1 次）', async () => {
  const { mgr, getSpawnCalls } = makeManager(); // pending probe → 停留在 starting
  const p1 = mgr.start();
  const s = await mgr.start(); // Starting 分支：立即返回快照
  equal(s.phase, 'starting');
  equal(getSpawnCalls(), 1);
  await mgr.stop(); // 清理：中止 p1
  await rejects(p1, (e: unknown) => (e as { code: string }).code === 'stopped');
});

test('④ ready 中 start 先停后起（spawn 调 2 次，经过 idle）', async () => {
  const { mgr, getSpawnCalls } = makeManager(false, { probeResult: OK_RESULT });
  const phases: string[] = [];
  mgr.on('status', (s) => phases.push(s.phase));
  await mgr.start();
  equal(mgr.snapshot().phase, 'ready');
  await mgr.start();
  equal(getSpawnCalls(), 2);
  equal(mgr.snapshot().phase, 'ready');
  deepEqual(phases, ['starting', 'ready', 'idle', 'starting', 'ready']);
});

test('⑤ failed 中 start 直接起（不经过 idle）', async () => {
  const { mgr, getSpawnCalls } = makeManager(false, { probeResult: OK_RESULT });
  const phases: string[] = [];
  mgr.on('status', (s) => phases.push(s.phase));
  await mgr.start();
  mgr.callTransition(RuntimePhase.Failed, 'dsh 启动失败');
  await mgr.start();
  equal(getSpawnCalls(), 2);
  equal(mgr.snapshot().phase, 'ready');
  ok(!phases.includes('idle'));
});
test('⑥ 任意状态 stop→idle；idle 中 stop no-op（无 status 事件）', async () => {
  const { mgr } = makeManager(false, { probeResult: OK_RESULT });
  let events = 0;
  mgr.on('status', () => {
    events += 1;
  });
  await mgr.stop(); // idle no-op
  equal(events, 0);
  equal(mgr.snapshot().phase, 'idle');
  await mgr.start(); // → ready
  await mgr.stop(); // → idle
  equal(mgr.snapshot().phase, 'idle');
  await mgr.start(); // → ready
  await mgr.stop(); // → idle
  equal(mgr.snapshot().phase, 'idle');
  await mgr.start(); // → ready
  mgr.callTransition(RuntimePhase.Failed, 'failed');
  await mgr.stop(); // failed → idle
  equal(mgr.snapshot().phase, 'idle');
});

test('⑦ starting 中 child exit → failed(child-exited) 立即（不等超时）', async () => {
  const { mgr, getChild } = makeManager(); // pending probe
  const p = mgr.start();
  getChild().emit('exit', 1, null);
  await rejects(p, (e: unknown) => (e as { code: string }).code === 'child-exited');
  equal(mgr.snapshot().phase, 'failed');
  ok(mgr.snapshot().message.includes('启动阶段'));
});

test('⑧ ready 中非主动 exit → failed + crash 事件', async () => {
  const { mgr, getChild } = makeManager(false, { probeResult: OK_RESULT });
  await mgr.start();
  equal(mgr.snapshot().phase, 'ready');
  const crashes: CrashInfo[] = [];
  mgr.on('crash', (info) => crashes.push(info));
  getChild().emit('exit', 1, 'SIGTERM');
  equal(mgr.snapshot().phase, 'failed');
  deepEqual(crashes, [{ code: 1, signal: 'SIGTERM' }]);
});

test('⑨ 主动 stop 后 exit 不触发 failed', async () => {
  const { mgr, getChild } = makeManager(false, { probeResult: OK_RESULT });
  await mgr.start();
  await mgr.stop();
  equal(mgr.snapshot().phase, 'idle');
  getChild().emit('exit', 0, null);
  equal(mgr.snapshot().phase, 'idle');
});

test('⑩ snapshot 深拷贝：改返回对象不影响内部状态', async () => {
  const { mgr } = makeManager();
  const s1 = mgr.snapshot();
  s1.message = 'hacked';
  (s1 as unknown as { phase: string }).phase = 'ready';
  const s2 = mgr.snapshot();
  equal(s2.message, '未启动');
  equal(s2.phase, 'idle');
});

test('⑪ message 超 200 字符截断；短消息不截断', async () => {
  const { mgr } = makeManager(false, { probeResult: OK_RESULT });
  await mgr.start();
  mgr.callTransition(RuntimePhase.Starting, 'x'.repeat(250));
  equal(mgr.snapshot().message.length, 200);
  mgr.callTransition(RuntimePhase.Failed, 'short');
  equal(mgr.snapshot().message, 'short');
});

test('⑫ overlay 缺失 → failed(dsh-missing)', async () => {
  const { mgr } = makeManager(false, { withOverlay: false });
  await rejects(mgr.start(), (e: unknown) => (e as { code: string }).code === 'dsh-missing');
  equal(mgr.snapshot().phase, 'failed');
});

test('⑬ node 解析顺序：HULL_NODE_PATH env 命中', async () => {
  const prev = process.env.HULL_NODE_PATH;
  process.env.HULL_NODE_PATH = '/custom/bin/node';
  try {
    const { mgr, getLastSpawn } = makeManager(false, { probeResult: OK_RESULT });
    await mgr.start();
    equal(getLastSpawn()?.cmd, '/custom/bin/node');
  } finally {
    if (prev === undefined) delete process.env.HULL_NODE_PATH;
    else process.env.HULL_NODE_PATH = prev;
  }
});

test('⑭ node 解析兜底：无 env 无捆绑 → PATH（node）', async () => {
  const prev = process.env.HULL_NODE_PATH;
  delete process.env.HULL_NODE_PATH;
  try {
    const { mgr, getLastSpawn } = makeManager(false, { probeResult: OK_RESULT });
    await mgr.start();
    equal(getLastSpawn()?.cmd, 'node');
  } finally {
    if (prev !== undefined) process.env.HULL_NODE_PATH = prev;
  }
});

test('⑮ node 解析：捆绑路径 <userData>/node/bin/node 优先于 PATH', async () => {
  const prev = process.env.HULL_NODE_PATH;
  delete process.env.HULL_NODE_PATH;
  try {
    const { mgr, userDataPath, getLastSpawn } = makeManager(false, { probeResult: OK_RESULT });
    mkdirSync(join(userDataPath, 'node', 'bin'), { recursive: true });
    writeFileSync(join(userDataPath, 'node', 'bin', 'node'), '#!/bin/sh\n');
    await mgr.start();
    equal(getLastSpawn()?.cmd, join(userDataPath, 'node', 'bin', 'node'));
  } finally {
    if (prev !== undefined) process.env.HULL_NODE_PATH = prev;
  }
});

test('⑯ 就绪成功 → ready + pid 文件 {pid, spawnAt}', async () => {
  const { mgr, userDataPath } = makeManager(false, { probeResult: OK_RESULT });
  await mgr.start();
  equal(mgr.snapshot().phase, 'ready');
  ok(existsSync(pidFile(userDataPath)));
  const parsed = JSON.parse(readFileSync(pidFile(userDataPath), 'utf8')) as { pid: number; spawnAt: string };
  equal(parsed.pid, 4242);
  ok(typeof parsed.spawnAt === 'string' && parsed.spawnAt.length > 0);
});

test('⑰ 探测超时 → failed(start-timeout)', async () => {
  const { mgr } = makeManager(false, {
    probeResult: { ok: false, url: 'http://127.0.0.1:53421', reason: 'probe-window-exhausted' },
  });
  await rejects(mgr.start(), (e: unknown) => (e as { code: string }).code === 'start-timeout');
  equal(mgr.snapshot().phase, 'failed');
});

test('⑱ spawn error → failed(spawn-failed)', async () => {
  const { mgr, getChild } = makeManager(); // pending probe
  const p = mgr.start();
  getChild().emit('error', new Error('spawn ENOENT'));
  await rejects(p, (e: unknown) => (e as { code: string }).code === 'spawn-failed');
  equal(mgr.snapshot().phase, 'failed');
});

test('⑲ stop：SIGTERM → 5s 未退 → SIGKILL（信号序列 + 删 pid）', async () => {
  const signals: (NodeJS.Signals | number)[] = [];
  const { mgr, userDataPath } = makeManager(false, {
    probeResult: OK_RESULT,
    killFn: (_pid, sig) => {
      signals.push(sig);
      return true;
    },
  });
  await mgr.start();
  ok(existsSync(pidFile(userDataPath)));
  await mgr.stop();
  deepEqual(signals, ['SIGTERM', 'SIGKILL']);
  ok(!existsSync(pidFile(userDataPath)));
});

test('⑳ exit 后 pid 文件删除（failed 迁移）', async () => {
  const { mgr, userDataPath, getChild } = makeManager(false, { probeResult: OK_RESULT });
  await mgr.start();
  ok(existsSync(pidFile(userDataPath)));
  getChild().emit('exit', 1, 'SIGKILL'); // ready 中崩溃
  equal(mgr.snapshot().phase, 'failed');
  ok(!existsSync(pidFile(userDataPath)));
});

test('🔴-1 FR-8：双流输出 tee → logger.dshLog（内容含就绪行原文）', async () => {
  const dshLogs: string[] = [];
  const logger: RuntimeLogger = {
    info() {},
    warn() {},
    error() {},
    dshLog: (_pid, chunk) => dshLogs.push(chunk),
  };
  const { mgr, getChild } = makeManager(false, { probeResult: OK_RESULT, logger });
  await mgr.start();
  const child = getChild();
  (child.stdout as unknown as EventEmitter).emit('data', 'dsh web: http://127.0.0.1:53421\n');
  (child.stderr as unknown as EventEmitter).emit('data', 'stderr 诊断行\n');
  ok(dshLogs.some((c) => c.includes('dsh web: http://127.0.0.1:53421')), 'stdout 内容应经 dshLog 落盘');
  ok(dshLogs.some((c) => c.includes('stderr 诊断行')), 'stderr 内容应经 dshLog 落盘');
});

test('🔴-2 旧 child 晚退出（restart 后）不误判', async () => {
  const { mgr, getChild } = makeManager(false, { probeResult: OK_RESULT });
  await mgr.start();
  const oldChild = getChild();
  await mgr.start(); // restart → child#2
  equal(mgr.snapshot().phase, 'ready');
  const crashes: CrashInfo[] = [];
  mgr.on('crash', (c) => crashes.push(c));
  oldChild.emit('exit', 1, 'SIGKILL'); // 旧 child 的退出事件晚到
  equal(mgr.snapshot().phase, 'ready', '旧 child 退出不应触发 failed');
  equal(crashes.length, 0, '不应触发 crash 事件');
});

test('🟡Y-2 stop 并发守卫：重复 stop 不冲突', async () => {
  const { mgr } = makeManager(false, { probeResult: OK_RESULT });
  await mgr.start();
  await Promise.all([mgr.stop(), mgr.stop(), mgr.stop()]);
  equal(mgr.snapshot().phase, 'idle');
});
