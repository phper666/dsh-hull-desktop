/**
 * DshCliRunner — dsh CLI 子进程单一通道（设计 §1.1，P1）：
 * 参数组装（--profile hull）、输出 JSON 优先/文本行、120s 硬超时（SIGTERM→5s→SIGKILL）、
 * 失败透传 stderr 截断 2KB、in-flight 计数、HULL_E2E failAt 注入。
 * DSH_HOME 不注入：dsh 管理自己的 $DSH_HOME（CON-R002 精神，Hull 不触碰）。
 */
import { spawn } from 'node:child_process';
import { join } from 'node:path';

import { dshBinPath, resolveNodePath } from '../runtime/spawnArgs';
import type { ChildLike, RuntimeLogger } from '../shared/types';

import { PluginError } from './errors';
import type { DshCliResult } from './types';

export type { DshCliResult } from './types';

export type DshPluginCommand = 'add' | 'update' | 'remove' | 'list';

export interface DshCliOptions {
  /** overlay bin 解析（resolveNodePath 解析 node；dsh bin = <userData>/dsh/bin/dsh） */
  userDataPath: string;
  /** 默认 'hull'（CON-R-plugin-012） */
  profile: string;
  /** 硬超时（默认 120s） */
  timeoutMs?: number;
  logger: RuntimeLogger;
  /** 预留（与 registry 时钟注入对齐） */
  now?: () => Date;
  /** HULL_E2E_FAIL_AT（仅 HULL_E2E=1 生效）：plugin-<cmd>:exit = 启动即杀（崩溃窗口） */
  failAt?: string;
  /** 注入可测（默认 node:child_process.spawn） */
  spawnImpl?: (cmd: string, args: string[], opts: { env: NodeJS.ProcessEnv; stdio: ['pipe', 'pipe', 'pipe'] }) => ChildLike;
  /** 注入可测（SIGTERM→SIGKILL 宽限等待） */
  sleepImpl?: (ms: number) => Promise<void>;
}

const DEFAULT_TIMEOUT_MS = 120_000;
const KILL_GRACE_MS = 5_000;
/** SIGKILL 后子进程仍不 emit close（kill ESRCH 等）→ 二次超时强制收尾（防 inflight 永久占用） */
const KILL_WATCHDOG_MS = 2_000;
const STDERR_TAIL_MAX = 2_048;

const sleepDefault = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export class DshCliRunner {
  private inflight = 0;
  private readonly timeoutMs: number;
  private readonly sleepImpl: (ms: number) => Promise<void>;

  constructor(private readonly opts: DshCliOptions) {
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.sleepImpl = opts.sleepImpl ?? sleepDefault;
  }

  /** 进行中的插件操作数（P3 gate / getPluginStatus 用） */
  get inflightCount(): number {
    return this.inflight;
  }

  /** 单飞：in-flight 期间并发请求 → plugin-busy（契约 #3 幂等/并发） */
  async run(cmd: DshPluginCommand, args: string[] = []): Promise<DshCliResult> {
    if (this.inflight > 0) throw new PluginError('plugin-busy', '已有插件操作进行中，请稍后再试');
    this.inflight++;
    try {
      return await this.execute(cmd, args);
    } finally {
      this.inflight--;
    }
  }

  private execute(cmd: DshPluginCommand, args: string[]): Promise<DshCliResult> {
    const nodePath = resolveNodePath(this.opts.userDataPath);
    const bin = dshBinPath(join(this.opts.userDataPath, 'dsh'));
    const argv = [bin, 'plugin', '--profile', this.opts.profile, cmd, ...args];
    const logger = this.opts.logger;

    return new Promise<DshCliResult>((resolve) => {
      let child: ChildLike;
      try {
        child = this.spawnImpl(nodePath, argv, { env: { ...process.env }, stdio: ['pipe', 'pipe', 'pipe'] });
      } catch (err) {
        logger.error(`[plugins] spawn 失败 ${argv.join(' ')}: ${(err as Error).message}`);
        resolve({ ok: false, code: 'spawn-failed', message: `无法启动 dsh CLI：${(err as Error).message}`, stderrTail: '' });
        return;
      }

      let stdout = '';
      let stderr = '';
      let settled = false;
      let timedOut = false;
      let timer: NodeJS.Timeout | null = null;
      let killWatchdog: NodeJS.Timeout | null = null;

      const finish = (result: DshCliResult): void => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        if (killWatchdog) clearTimeout(killWatchdog);
        resolve(result);
      };

      // HULL_E2E=1 + failAt=plugin-<cmd>:exit → 子进程启动即杀（e2e 崩溃窗口，沿用 backup 注入模式）
      if (this.failPoint() === `plugin-${cmd}:exit`) child.kill();

      if (child.stdout) child.stdout.on('data', (chunk: unknown) => void (stdout += String(chunk)));
      if (child.stderr) child.stderr.on('data', (chunk: unknown) => void (stderr += String(chunk)));
      child.on('error', (err: Error) =>
        finish({ ok: false, code: 'spawn-failed', message: `dsh CLI 启动失败：${err.message}`, stderrTail: '' }),
      );

      timer = setTimeout(() => {
        timedOut = true;
        logger.warn(`[plugins] dsh plugin ${cmd} 超时（${this.timeoutMs}ms），SIGTERM → 宽限 ${KILL_GRACE_MS}ms → SIGKILL`);
        child.kill('SIGTERM');
        void this.sleepImpl(KILL_GRACE_MS)
          .then(() => child.kill('SIGKILL'))
          .then(() => {
            // 兜底：SIGKILL 后子进程仍不 emit close（kill ESRCH / 事件丢失）→ 二次超时强制收尾，
            // 杜绝 inflightCount 永久占用（否则后续全 plugin-busy）
            killWatchdog = setTimeout(() => {
              if (settled) return;
              logger.error(`[plugins] dsh plugin ${cmd} SIGKILL 后未收到 close，强制超时收尾`);
              finish({
                ok: false,
                code: 'timeout',
                message: `dsh plugin ${cmd} 超时（${this.timeoutMs}ms）`,
                stderrTail: tailBytes(stderr, STDERR_TAIL_MAX),
              });
            }, KILL_WATCHDOG_MS);
          });
      }, this.timeoutMs);

      child.on('close', (code: number | null, signal: NodeJS.Signals | null) => {
        if (timedOut) {
          logger.error(`[plugins] dsh plugin ${cmd} 超时终止（code=${code} signal=${String(signal)}）`);
          finish({ ok: false, code: 'timeout', message: `dsh plugin ${cmd} 超时（${this.timeoutMs}ms）`, stderrTail: tailBytes(stderr, STDERR_TAIL_MAX) });
          return;
        }
        if (code === 0) {
          finish({ ok: true, stdout, ...parseJson(stdout) });
          return;
        }
        logger.error(`[plugins] dsh plugin ${cmd} 失败 code=${code ?? 'killed'} signal=${String(signal)}`);
        finish({
          ok: false,
          code: code ?? 'killed',
          message: `dsh plugin ${cmd} 失败${code !== null ? `（退出码 ${code}）` : `（信号 ${String(signal)}）`}`,
          stderrTail: tailBytes(stderr, STDERR_TAIL_MAX),
        });
      });
    });
  }

  private spawnImpl(
    cmd: string,
    args: string[],
    opts: { env: NodeJS.ProcessEnv; stdio: ['pipe', 'pipe', 'pipe'] },
  ): ChildLike {
    const impl = this.opts.spawnImpl;
    return impl ? impl(cmd, args, opts) : spawn(cmd, args, opts);
  }

  private failPoint(): string | undefined {
    return process.env.HULL_E2E === '1' ? this.opts.failAt : undefined;
  }
}

/** 输出解析：JSON 优先（parsed）；非 JSON 原样 stdout（文本行由调用方解析，如 profile.parseBundleList） */
function parseJson(stdout: string): { parsed?: unknown } {
  const trimmed = stdout.trim();
  if (!trimmed) return {};
  try {
    return { parsed: JSON.parse(trimmed) };
  } catch {
    return {};
  }
}

/** stderr 截断 ≤2KB 尾部（安全设计 §4.6：错误信息不泄敏感内容） */
function tailBytes(s: string, maxBytes: number): string {
  if (Buffer.byteLength(s, 'utf8') <= maxBytes) return s;
  let start = 0;
  while (start < s.length && Buffer.byteLength(s.slice(start), 'utf8') > maxBytes) start++;
  return s.slice(start);
}
