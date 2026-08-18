import { test, after } from 'node:test';
import { equal, ok, rejects } from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { RuntimeManager } from '../../src/runtime/RuntimeManager';
import { ReadinessProbe } from '../../src/runtime/ReadinessProbe';
import { READY_LINE_RE } from '../../src/runtime/spawnArgs';
import { RuntimePhase } from '../../src/shared/types';

/** fake-dsh 绝对路径（dist-tests/tests/integration → 项目根/tests/fixtures） */
const FAKE_DSH = join(__dirname, '..', '..', '..', 'tests', 'fixtures', 'fake-dsh.js');

const tempDirs: string[] = [];
const children: ChildProcess[] = [];
after(() => {
  for (const c of children) {
    try {
      c.kill('SIGKILL');
    } catch {
      /* 已退出 */
    }
  }
  for (const d of tempDirs) rmSync(d, { recursive: true, force: true });
});

function makeTempDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'hull-int-'));
  tempDirs.push(d);
  return d;
}

/** spawn fake-dsh（同形 argv：web --host 127.0.0.1 --port 0，与真实 dsh CLI 一致） */
function spawnFakeDsh(mode: string, extraEnv: Record<string, string> = {}): ChildProcess {
  const child = spawn(
    process.execPath,
    [FAKE_DSH, 'web', '--host', '127.0.0.1', '--port', '0'],
    { env: { ...process.env, FAKE_DSH_MODE: mode, ...extraEnv } }
  );
  children.push(child);
  return child;
}

/** 读 stdout 直到就绪行命中（或 5s 超时） */
function readReadyLine(child: ChildProcess, timeoutMs = 5000): Promise<string> {
  return new Promise((resolve, reject) => {
    let buf = '';
    const timer = setTimeout(() => reject(new Error('就绪行超时')), timeoutMs);
    child.stdout?.on('data', (chunk: Buffer) => {
      buf += chunk.toString('utf8');
      const lines = buf.split('\n');
      for (const line of lines) {
        if (READY_LINE_RE.test(line)) {
          clearTimeout(timer);
          resolve(line);
          return;
        }
      }
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`fake-dsh 提前退出（code=${code}）`));
    });
  });
}

test('① fake-dsh ready 模式 → 就绪行命中 + URL 提取 + HTTP 200', async () => {
  const child = spawnFakeDsh('ready');
  const line = await readReadyLine(child);
  const m = READY_LINE_RE.exec(line);
  ok(m, '就绪行匹配');
  const url = m![1];
  ok(url.startsWith('http://127.0.0.1:'), 'URL 提取');
  const res = await fetch(url);
  equal(res.status, 200, 'fake server 可探测');
});

test('② slow 模式 → 就绪行延迟出现（慢启动模拟）', async () => {
  const child = spawnFakeDsh('slow', { FAKE_DSH_DELAY_MS: '500' });
  const t0 = Date.now();
  const line = await readReadyLine(child);
  const elapsed = Date.now() - t0;
  ok(READY_LINE_RE.test(line), '就绪行命中');
  ok(elapsed >= 400, `就绪行延迟出现（elapsed=${elapsed}ms）`);
});

test('③ bad-addr 模式 → 就绪行指向坏地址（探测失败路径）', async () => {
  const child = spawnFakeDsh('bad-addr');
  const line = await readReadyLine(child);
  const m = READY_LINE_RE.exec(line);
  ok(m, '就绪行命中');
  equal(m![1], 'http://127.0.0.1:1', '坏地址就绪行');
});

test('④ crash 模式 → 非零退出（崩溃模拟）', async () => {
  const child = spawnFakeDsh('crash');
  const code = await new Promise<number | null>((resolve) => child.on('exit', (c) => resolve(c)));
  ok(code !== 0, `非零退出（code=${code}）`);
});

test('⑤ spawnFn DI 主路：fake-dsh ready → RuntimeManager ready', async () => {
  const userDataPath = makeTempDir();
  mkdirSync(join(userDataPath, 'dsh'), { recursive: true }); // overlay 存在
  const mgr = new RuntimeManager({
    userDataPath,
    spawnFn: (cmd, args, opts) =>
      spawn(process.execPath, [FAKE_DSH, ...args], { ...opts, env: { ...process.env, FAKE_DSH_MODE: 'ready' } }),
    sleep: async () => {}, // 即时 sleep：防 kill 宽限 5s 定时器挂起拖住进程退出
  });
  const snap = await mgr.start();
  equal(snap.phase, RuntimePhase.Ready);
  ok(snap.url?.startsWith('http://127.0.0.1:'), '就绪 URL');
  await mgr.stop();
});

test('⑥ symlink 补验路：临时 overlay + bin/dsh symlink → 真实 spawn 就绪', async () => {
  const userDataPath = makeTempDir();
  const overlayDir = join(userDataPath, 'dsh');
  mkdirSync(join(overlayDir, 'bin'), { recursive: true });
  symlinkSync(FAKE_DSH, join(overlayDir, 'bin', 'dsh')); // bin/dsh → fake-dsh（S1 dshBinPath 落点）
  const mgr = new RuntimeManager({
    userDataPath,
    sleep: async () => {}, // 即时 sleep：防 kill 宽限 5s 定时器挂起
  }); // 默认 spawnFn（真实 spawn，验证 spawnArgs argv 顺序）
  const snap = await mgr.start();
  equal(snap.phase, RuntimePhase.Ready);
  ok(snap.url?.startsWith('http://127.0.0.1:'), '真实 spawn 就绪链路');
  await mgr.stop();
});

test('⑦ HULL_PROBE_TARGET 坏地址注入（Q-010）→ start-timeout → failed', async () => {
  const prev = process.env.HULL_PROBE_TARGET;
  process.env.HULL_PROBE_TARGET = 'http://127.0.0.1:1'; // 探测目标坏地址（注入仅作用探测）
  try {
    const userDataPath = makeTempDir();
    mkdirSync(join(userDataPath, 'dsh'), { recursive: true });
    let t = 0;
    const mgr = new RuntimeManager({
      userDataPath,
      spawnFn: (cmd, args, opts) =>
        spawn(process.execPath, [FAKE_DSH, ...args], { ...opts, env: { ...process.env, FAKE_DSH_MODE: 'ready' } }),
      probeFactory: () =>
        new ReadinessProbe({
          now: () => t,
          sleep: async () => {
            t += 1000;
          },
        }),
      sleep: async () => {}, // 即时 sleep：防 kill 宽限 5s 定时器挂起
    });
    await rejects(mgr.start(), (e: unknown) => (e as { code: string }).code === 'start-timeout');
    equal(mgr.snapshot().phase, RuntimePhase.Failed, '探测失败 → failed');
    await mgr.stop();
  } finally {
    if (prev === undefined) delete process.env.HULL_PROBE_TARGET;
    else process.env.HULL_PROBE_TARGET = prev;
  }
});

test('⑧ 就绪行格式与 READY_LINE_RE 匹配断言', async () => {
  const child = spawnFakeDsh('ready');
  const line = await readReadyLine(child);
  const m = READY_LINE_RE.exec(line);
  ok(m, '格式匹配');
  ok(/^dsh web: http:\/\/127\.0\.0\.1:[0-9]+$/.test(line.trim()), '就绪行完整格式');
  equal(m![1], line.trim().slice('dsh web: '.length), '捕获组 = URL');
});
