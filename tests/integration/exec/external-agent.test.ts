/**
 * 外部 ACP Agent 集成测试（U-002 第二平台插槽）
 *
 * 不启动 Electron：注入 launch = [process.execPath, tests/fixtures/fake-acp-agent.js]
 * 实例化 ACPProvider，验证真实子进程往返（NDJSON JSON-RPC over stdio）：
 * 1. listModels → 只回外部 agent configOptions 的模型分组（不合并 dsh settings.yaml）
 * 2. execute → 流式 text_chunk（FAKE_AGENT_REPLY）+ onResult 成功 + sessionId 非空
 * 3. prompt 含 ASK_PERMISSION → permission_request → respondPermission(true) → 继续完成
 * 4. cancel → session/cancel → agent 回 stopReason cancelled（不误判成功）
 * 5. 未配置 launch（dsh 默认路径）→ spawn argv 不变（回归锚点）
 */
import { test, after } from 'node:test';
import { deepEqual, equal, ok } from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

import { ACPProvider } from '../../../src/exec/provider/ACPProvider';
import type { ExecutionEvent, ExecutionResult, ExecutionTask } from '../../../src/exec/provider/ExecutionProvider';
import { dshBinPath } from '../../../src/runtime/spawnArgs';

/** fake ACP agent 路径（dist-tests/tests/integration/exec → 项目根/tests/fixtures） */
const FAKE_ACP = join(__dirname, '..', '..', '..', '..', 'tests', 'fixtures', 'fake-acp-agent.js');
const LAUNCH = { command: process.execPath, args: [FAKE_ACP] };

const tempDirs: string[] = [];
const providers: ACPProvider[] = [];
after(async () => {
  await Promise.all(providers.map((p) => p.killAllChildren()));
  for (const d of tempDirs) rmSync(d, { recursive: true, force: true });
});

function makeTempDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'hull-ext-agent-'));
  tempDirs.push(d);
  return d;
}

interface Harness {
  statuses: string[];
  events: ExecutionEvent[];
  result?: ExecutionResult;
  resultCount: number;
  resultPromise: Promise<ExecutionResult>;
  handlers: {
    onStatus: (s: string) => void;
    onEvent: (e: ExecutionEvent) => void;
    onResult: (r: ExecutionResult) => void;
  };
}

function makeHarness(): Harness {
  let resolveResult!: (r: ExecutionResult) => void;
  const resultPromise = new Promise<ExecutionResult>((r) => (resolveResult = r));
  const h: Harness = {
    statuses: [],
    events: [],
    resultCount: 0,
    resultPromise,
    handlers: {
      onStatus: (s) => h.statuses.push(s),
      onEvent: (e) => h.events.push(e),
      onResult: (r) => {
        h.result = r;
        h.resultCount++;
        resolveResult(r);
      },
    },
  };
  return h;
}

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} 超时（${ms}ms）`)), ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function makeTask(title: string, cwd: string, description?: string): ExecutionTask {
  return { taskId: 't_ext', title, ...(description ? { description } : {}), cwd };
}

test('① listModels：外部 agent 自身 configOptions 分组（不合并 dsh settings.yaml）', async () => {
  const settingsDir = makeTempDir();
  const settingsPath = join(settingsDir, 'settings.yaml');
  writeFileSync(
    settingsPath,
    'llm-pi-ai:\n  providers:\n    should-not-merge:\n      models:\n        - id: dsh-custom\n',
    'utf8',
  );
  const spawnOpts: Array<{ env?: NodeJS.ProcessEnv; cwd?: string }> = [];
  const provider = new ACPProvider({
    launch: LAUNCH,
    settingsPath, // 有值也必须跳过（外部 agent 与 dsh settings.yaml 无关）
    spawnFn: ((cmd: string, args: string[], opts: never) => {
      spawnOpts.push(opts as { env?: NodeJS.ProcessEnv; cwd?: string });
      return spawn(cmd, args, opts);
    }) as never,
  });
  providers.push(provider);

  const groups = await withTimeout(provider.listModels(), 10_000, 'listModels');
  const modelA = JSON.stringify(['fake-route', 'fake-model-a']);
  const modelB = JSON.stringify(['fake-route', 'fake-model-b']);
  deepEqual(groups, [
    {
      group: 'fake-route',
      name: 'Fake Route',
      options: [
        { value: modelA, name: 'fake-model-a' },
        { value: modelB, name: 'fake-model-b' },
      ],
    },
  ]);
  equal(spawnOpts[0]?.cwd, homedir(), '探测 spawn cwd = home');
  ok(!String(spawnOpts[0]?.env?.DSH_HOME ?? '').includes('hull-probe-'), '不注入 DSH_HOME 临时 home');
});

test('② execute：流式 text_chunk（FAKE_AGENT_REPLY）+ 成功 + sessionId 非空', async () => {
  const provider = new ACPProvider({ launch: LAUNCH });
  providers.push(provider);
  const h = makeHarness();
  provider.execute(makeTask('外部 agent 正常执行', makeTempDir()), h.handlers);

  const result = await withTimeout(h.resultPromise, 10_000, 'execute');
  equal(result.exitCode, 0, 'exitCode=0');
  ok(result.sessionId, 'sessionId 非空（结算回写会话引用）');
  deepEqual(h.statuses, ['running', 'succeeded']);
  const chunks = h.events.filter((e) => e.kind === 'text_chunk');
  ok(chunks.length >= 2, `至少 2 条 text_chunk（实际 ${chunks.length}）`);
  const text = chunks.map((e) => (e.kind === 'text_chunk' ? e.text : '')).join('');
  ok(text.includes('FAKE_AGENT_REPLY'), '流式文本含断言锚点');
  ok(result.summary.includes('FAKE_AGENT_REPLY'), 'summary 聚合流式文本');
  equal(h.events.some((e) => e.kind === 'permission_request'), false, '普通 prompt 不触发审批');
});

test('③ permission：ASK_PERMISSION → permission_request → 批准 → 继续完成', async () => {
  const provider = new ACPProvider({ launch: LAUNCH });
  providers.push(provider);
  const h = makeHarness();
  const handle = provider.execute(
    makeTask('审批往返', makeTempDir(), '测试 ASK_PERMISSION 与授权弹窗'),
    h.handlers,
  ) as unknown as { respondPermission?: (id: string, approved: boolean, reason?: string) => void };
  const permissions: Array<{ requestId: string; message: string }> = [];
  provider.on('permission', (ctx: { requestId: string; message: string }) => {
    permissions.push(ctx);
    handle.respondPermission?.(ctx.requestId, true, '测试批准');
  });

  const result = await withTimeout(h.resultPromise, 10_000, 'permission execute');
  equal(result.exitCode, 0);
  equal(permissions.length, 1, 'permission 事件一次');
  equal(permissions[0].message, 'fake agent 想执行工具，是否允许？', '契约 message.content 提取为文案');
  const permEvent = h.events.find((e) => e.kind === 'permission_request');
  ok(permEvent, 'onEvent permission_request');
  ok(result.summary.includes('权限已批准'), '批准后继续执行并结算');
});

test('④ cancel：session/cancel → agent 回 stopReason cancelled（不误判成功）', async () => {
  const stderrChunks: string[] = [];
  const provider = new ACPProvider({
    launch: LAUNCH,
    spawnFn: ((cmd: string, args: string[], opts: never) => {
      const child = spawn(cmd, args, opts) as ChildProcess;
      child.stderr?.on('data', (chunk: Buffer) => stderrChunks.push(chunk.toString('utf8')));
      return child;
    }) as never,
  });
  providers.push(provider);
  const h = makeHarness();
  // ASK_PERMISSION 让 agent 阻塞等待授权（不响应）→ 保证 cancel 发生在 turn 进行中
  const handle = provider.execute(
    makeTask('取消执行', makeTempDir(), 'ASK_PERMISSION 阻塞等待，随后取消'),
    h.handlers,
  );

  const deadline = Date.now() + 5000;
  while (!h.events.some((e) => e.kind === 'permission_request') && Date.now() < deadline) await sleep(20);
  ok(h.events.some((e) => e.kind === 'permission_request'), 'agent 已阻塞在授权等待');

  await handle.cancel();
  const cancelDeadline = Date.now() + 3000;
  while (!stderrChunks.join('').includes('prompt result cancelled') && Date.now() < cancelDeadline) await sleep(20);
  ok(stderrChunks.join('').includes('session/cancel'), 'provider 发出 session/cancel');
  ok(stderrChunks.join('').includes('prompt result cancelled'), 'agent 回 stopReason cancelled');
  equal(h.statuses.includes('succeeded'), false, '取消不误判成功');
});

test('⑤ 默认路径（未配置 launch）：spawn 仍为 dsh ACP argv（回归锚点）', async () => {
  const overlayDir = makeTempDir();
  const spawnLog: Array<{ cmd: string; args: string[]; cwd?: string }> = [];
  const provider = new ACPProvider({
    overlayDir,
    spawnFn: ((_cmd: string, _args: string[], opts: never) => {
      spawnLog.push({ cmd: _cmd, args: _args, cwd: (opts as { cwd?: string }).cwd });
      throw new Error('stub-stop'); // 不真正 spawn dsh；仅验证 argv
    }) as never,
  });
  providers.push(provider);
  const h = makeHarness();
  provider.execute(makeTask('dsh 默认路径', makeTempDir()), h.handlers);
  const result = await withTimeout(h.resultPromise, 3000, 'dsh regression');
  equal(spawnLog.length, 1);
  equal(spawnLog[0].cmd, 'node');
  deepEqual(spawnLog[0].args, ['--expose-internals', dshBinPath(overlayDir), '--profile', 'acp']);
  equal(spawnLog[0].cwd, overlayDir);
  ok(result.summary.includes('dsh ACP 子进程启动失败'), 'dsh 文案不变');
});
