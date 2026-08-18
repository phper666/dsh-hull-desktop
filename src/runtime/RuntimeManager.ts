import { EventEmitter } from 'node:events';
import { spawn, type StdioOptions } from 'node:child_process';
import { existsSync, promises as fsPromises, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { Readable } from 'node:stream';

import {
  RuntimePhase,
  RuntimeLogger,
  NOOP_LOGGER,
  type ChildLike,
  type RuntimeSnapshot,
} from '../shared/types';
import { HullError, StartTimeoutError, SpawnFailedError, DshMissingError, ChildExitedError } from '../shared/errors';
import { ReadinessProbe, type ProbeResult } from './ReadinessProbe';
import { buildSpawnArgv, dshBinPath } from './spawnArgs';

export type { RuntimeLogger, ChildLike } from '../shared/types';

/** message 最大长度（契约字段约束：≤200 字符） */
export const MAX_MESSAGE_LENGTH = 200;
/** SIGTERM → SIGKILL 宽限（设计 §4.3：5s） */
export const KILL_GRACE_MS = 5_000;
/** SIGKILL 后等待退出上限（防 zombie） */
export const POST_KILL_WAIT_MS = 1_000;

/** 崩溃事件载荷（ready 中非主动退出；dialog 由 Lane B 处理） */
export interface CrashInfo {
  code: number | null;
  signal: NodeJS.Signals | null;
}

/** 子进程最小接口（child_process.ChildProcess 结构兼容，测试可注入 fake） */
export interface SpawnOptionsLike {
  detached?: boolean;
  cwd?: string;
  stdio?: StdioOptions;
}

/** spawn 注入类型（默认 child_process.spawn；测试注入 stub） */
export type SpawnFn = (command: string, args: readonly string[], options: SpawnOptionsLike) => ChildLike;

/** 就绪判定探针最小接口（默认 ReadinessProbe；测试注入 fake） */
export interface ProbeLike {
  probe(stdout: NodeJS.ReadableStream, stderr: NodeJS.ReadableStream): Promise<ProbeResult>;
}

type ReadyOutcome = { ok: true; url: string } | { ok: false; error: HullError };

export interface RuntimeManagerOptions {
  /** 非法迁移：dev 下 throw / prod 下 log 忽略；默认 false（prod） */
  dev?: boolean;
  /** spawn 实现注入（默认 child_process.spawn） */
  spawnFn?: SpawnFn;
  /** 就绪探针工厂（默认 ReadinessProbe + t2 计时埋点） */
  probeFactory?: () => ProbeLike;
  /** Electron userData 目录（overlay <userData>/dsh、pid 文件 <userData>/dsh.pid 落点） */
  userDataPath: string;
  /** 日志注入（默认 no-op） */
  logger?: RuntimeLogger;
  /** 时钟（测试 seam） */
  now?: () => number;
  /** 休眠（测试 seam；进程清理宽限快进） */
  sleep?: (ms: number) => Promise<void>;
  /** 进程组 kill 实现（默认 process.kill；测试注入记录信号序列） */
  killFn?: (pid: number, signal: NodeJS.Signals | number) => boolean;
}

/**
 * 状态迁移表（契约 v0.2 §状态转换）：
 * idle→starting；starting→ready/failed；ready→starting(restart)/failed；failed→starting；
 * 任意状态→idle = stop 迁移行（偏离 2 已合入契约 v0.2）。
 */
const TRANSITIONS: Record<RuntimePhase, RuntimePhase[]> = {
  [RuntimePhase.Idle]: [RuntimePhase.Starting],
  [RuntimePhase.Starting]: [RuntimePhase.Ready, RuntimePhase.Failed, RuntimePhase.Idle],
  [RuntimePhase.Ready]: [RuntimePhase.Starting, RuntimePhase.Failed, RuntimePhase.Idle],
  [RuntimePhase.Failed]: [RuntimePhase.Starting, RuntimePhase.Idle],
};

/**
 * dsh 运行时状态机 + 进程编排（设计 D7 / §4.1/4.2/4.3 / 契约 #1~#4）。
 * 编排：overlay 校验 → node 解析 → spawn(detached 进程组) → pid 落盘 → 双流就绪判定 → ready；
 * 停止：SIGTERM 进程组 → 5s 宽限 → SIGKILL 进程组。
 */
export class RuntimeManager extends EventEmitter {
  private phase: RuntimePhase = RuntimePhase.Idle;
  private message = '未启动';
  private launchDirectory: string | null = null;
  private url: string | null = null;
  /** 主动停止标志：区分非预期退出（崩溃判定） */
  private stopping = false;
  /** 启动中等待就绪的 settle（exit/error/stop/probe 竞争，先到先得） */
  private settleStart: ((o: ReadyOutcome) => void) | undefined;
  private readonly dev: boolean;
  private readonly spawnFn: SpawnFn;
  private readonly probeFactory: () => ProbeLike;
  private readonly userDataPath: string;
  private readonly logger: RuntimeLogger;
  private readonly now: () => number;
  private readonly sleepImpl: (ms: number) => Promise<void>;
  private readonly killFn: (pid: number, signal: NodeJS.Signals | number) => boolean;
  protected child: ChildLike | null = null;

  constructor(options: RuntimeManagerOptions) {
    super();
    this.dev = options.dev ?? false;
    this.spawnFn = options.spawnFn ?? ((cmd, args, opts) => spawn(cmd, args, opts));
    this.probeFactory =
      options.probeFactory ??
      (() => new ReadinessProbe({ onReadyLine: (_url, ms) => this.logger.info(`[timing] t2 ready-line ${ms}ms`) }));
    this.userDataPath = options.userDataPath;
    this.logger = options.logger ?? NOOP_LOGGER;
    this.now = options.now ?? Date.now;
    this.sleepImpl = options.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
    this.killFn = options.killFn ?? ((pid, signal) => process.kill(pid, signal));
  }

  /** 状态变更通知（契约 #4）：每次成功迁移 emit snapshot */
  on(event: 'status', listener: (snapshot: RuntimeSnapshot) => void): this;
  /** dsh 崩溃事件（ready 中非主动退出） */
  on(event: 'crash', listener: (info: CrashInfo) => void): this;
  on(event: string | symbol, listener: (...args: any[]) => void): this {
    return super.on(event, listener);
  }

  /** 运行快照（深拷贝：每次返回新对象，防外部改内部状态） */
  snapshot(): RuntimeSnapshot {
    return {
      phase: this.phase,
      message: this.message,
      launchDirectory: this.launchDirectory,
      url: this.url,
    };
  }

  /**
   * 启动（契约 #1 幂等三语义）：
   * - starting 中重复 start → 忽略（不重复 spawn）
   * - ready 中 start → 先停后起（等价 restart）
   * - failed / idle → 直接起
   * 异常（契约 #1）：dsh-missing / spawn-failed / start-timeout / child-exited
   */
  async start(): Promise<RuntimeSnapshot> {
    const t0 = this.now();
    this.logger.info('[timing] t0 start entry');
    switch (this.phase) {
      case RuntimePhase.Starting:
        return this.snapshot();
      case RuntimePhase.Ready:
        await this.stop();
        break;
      default:
        break;
    }
    const overlayDir = join(this.userDataPath, 'dsh');
    if (!existsSync(overlayDir)) {
      const err = new DshMissingError(`overlay 目录不存在: ${overlayDir}（S2 首装）`);
      this.transition(RuntimePhase.Starting, '正在启动 dsh…');
      this.transition(RuntimePhase.Failed, err.message);
      throw err;
    }
    // 残留子进程防护（failed → 直接起时旧 child 可能仍在）
    if (this.child && this.child.exitCode === null) await this.killProcessGroup(this.child);
    const nodePath = this.resolveNodePath();
    this.transition(RuntimePhase.Starting, '正在启动 dsh…');
    const argv = buildSpawnArgv(nodePath, dshBinPath(overlayDir));
    let child: ChildLike;
    try {
      child = this.spawnFn(argv[0], argv.slice(1), {
        detached: true,
        cwd: overlayDir,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (err) {
      this.transition(RuntimePhase.Failed, `dsh 启动失败: ${(err as Error).message}`);
      throw new SpawnFailedError(`dsh 子进程启动失败: ${(err as Error).message}`);
    }
    this.child = child;
    this.launchDirectory = overlayDir;
    this.url = null;
    this.logger.info(`[timing] t1 spawn ${this.now() - t0}ms`);
    child.on('exit', (code: number | null, signal: NodeJS.Signals | null) => {
      if (this.child !== child) return; // 🔴-2：旧 child 晚退出（restart 后）不误判
      this._onChildExit(code, signal);
    });
    child.on('error', (err: Error) => {
      if (this.child !== child) return; // 🔴-2：旧 child 的 error 晚到不误判
      if (this.stopping || this.phase !== RuntimePhase.Starting) return;
      const e = new SpawnFailedError(`dsh 子进程启动失败: ${err.message}`);
      this.transition(RuntimePhase.Failed, e.message);
      if (this.settleStart) this.settleStart({ ok: false, error: e });
    });
    // FR-8：双流输出 tee 落盘（Node Readable 多 data 监听器与 probe 共存，无冲突）
    const pid = child.pid ?? 0;
    const tee = (stream: NodeJS.ReadableStream | null) => {
      stream?.on('data', (c: Buffer | string) =>
        this.logger.dshLog(pid, typeof c === 'string' ? c : c.toString('utf8'))
      );
    };
    tee(child.stdout);
    tee(child.stderr);
    // 就绪判定：settleStart 必须挂在任何 await 之前——exit/error/stop 可能在任何 fs await
    // 窗口内触发，挂晚了会错过 settle 导致 start() 永不返回（3b 挂起根因）
    const probe = this.probeFactory();
    const outcomePromise = new Promise<ReadyOutcome>((resolve) => {
      this.settleStart = (o) => resolve(o);
      const stdout = child.stdout ?? Readable.from([]);
      const stderr = child.stderr ?? Readable.from([]);
      void probe.probe(stdout, stderr).then(
        (pr) => {
          if (!this.settleStart) return;
          if (pr.ok && pr.url) this.settleStart({ ok: true, url: pr.url });
          else if (this.isPhaseStarting()) this.settleStart({ ok: false, error: this.mapProbeFailure(pr) });
        },
        (err: unknown) => {
          if (!this.settleStart || !this.isPhaseStarting()) return;
          this.settleStart({ ok: false, error: new StartTimeoutError(`dsh 就绪判定异常: ${(err as Error).message}`) });
        }
      );
    });
    await this.writePidFile(child.pid);
    const outcome = await outcomePromise;
    this.settleStart = undefined;
    if (outcome.ok) {
      this.logger.info(`[timing] t3 ready ${this.now() - t0}ms`);
      this.url = outcome.url;
      this.transition(RuntimePhase.Ready, 'dsh 就绪');
      return this.snapshot();
    }
    if (!this.stopping && this.isPhaseStarting()) {
      this.transition(RuntimePhase.Failed, outcome.error.message);
      // 超时类失败：子进程可能仍存活 → 清理进程组
      if (this.child && this.child.exitCode === null) void this.killProcessGroup(this.child);
    }
    throw outcome.error;
  }

  /** 当前仍处于 starting（未被 stop/exit 抢先迁移）——独立方法读取，避免外层 switch 窄化误判 */
  private isPhaseStarting(): boolean {
    return this.phase === RuntimePhase.Starting;
  }

  /** 停止（契约 #2）：任意状态 → idle；幂等（idle 中 no-op；kill 期间并发 stop 直接返回） */
  async stop(): Promise<void> {
    if (this.phase === RuntimePhase.Idle || this.stopping) return; // 🟡Y-2：并发守卫
    this.stopping = true;
    // 启动中：立即中止等待（不等就绪）
    if (this.settleStart) this.settleStart({ ok: false, error: new HullError('stopped', 'dsh 启动被中止') });
    const child = this.child;
    if (child && child.exitCode === null) await this.killProcessGroup(child);
    this.child = null;
    this.deletePidFile();
    this.transition(RuntimePhase.Idle, '已停止');
    this.stopping = false;
  }

  /**
   * 迁移统一入口：校验迁移表 → 更新 phase + message（200 截断）→ failed 迁移删 pid → emit status。
   * @returns 迁移是否成功（非法迁移 dev throw / prod false）
   */
  protected transition(to: RuntimePhase, message: string): boolean {
    const from = this.phase;
    const allowed = TRANSITIONS[from];
    if (!allowed.includes(to)) {
      const err = new Error(`非法状态迁移: ${from} -> ${to}`);
      if (this.dev) throw err;
      this.logger.warn(`[state] ${err.message}（忽略）`);
      return false;
    }
    this.phase = to;
    this.message = message.length > MAX_MESSAGE_LENGTH ? message.slice(0, MAX_MESSAGE_LENGTH) : message;
    if (to === RuntimePhase.Failed) this.deletePidFile();
    this.emit('status', this.snapshot());
    return true;
  }

  /**
   * 子进程退出处理（契约 §状态转换）：
   * - starting 中退出 → 立即 failed(child-exited)，不等超时
   * - ready 中非主动退出 → failed + crash 事件（dialog 由 Lane B 处理）
   * - 主动 stop 后退出 → 不判崩溃
   */
  protected _onChildExit(code: number | null, signal: NodeJS.Signals | null): void {
    if (this.stopping) return;
    if (this.phase === RuntimePhase.Starting) {
      const err = new ChildExitedError(
        `dsh 子进程在启动阶段退出 (code=${code ?? 'null'}, signal=${signal ?? 'null'})`
      );
      this.transition(RuntimePhase.Failed, err.message);
      if (this.settleStart) this.settleStart({ ok: false, error: err });
    } else if (this.phase === RuntimePhase.Ready) {
      this.transition(RuntimePhase.Failed, `dsh 崩溃 (code=${code ?? 'null'}, signal=${signal ?? 'null'})`);
      this.emit('crash', { code, signal });
    }
  }

  /** Node 解析器来源（契约 #1 注记 / 设计 §5 偏离 3）：env → 捆绑路径探测 → PATH 兜底 */
  private resolveNodePath(): string {
    const envPath = process.env.HULL_NODE_PATH;
    if (envPath) return envPath;
    const bundled = join(this.userDataPath, 'node', 'bin', 'node');
    if (existsSync(bundled)) return bundled;
    return 'node';
  }

  /** 探测失败结构化映射（契约 #1 异常）：窗口耗尽/就绪行超时 → start-timeout；流提前结束 → child-exited */
  private mapProbeFailure(pr: ProbeResult): HullError {
    switch (pr.reason) {
      case 'ready-line-timeout':
      case 'probe-window-exhausted':
        return new StartTimeoutError(`dsh 就绪判定超时（${pr.reason}）`);
      case 'streams-ended':
        return new ChildExitedError('dsh 输出流提前结束');
      default:
        return new StartTimeoutError('dsh 就绪判定失败');
    }
  }

  /** pid 落盘（原子写：temp + rename；失败仅告警不阻断启动） */
  private async writePidFile(pid: number | undefined): Promise<void> {
    if (pid === undefined) return;
    const file = join(this.userDataPath, 'dsh.pid');
    const payload = JSON.stringify({ pid, spawnAt: new Date().toISOString() });
    try {
      const tmp = `${file}.tmp`;
      await fsPromises.writeFile(tmp, payload, 'utf8');
      await fsPromises.rename(tmp, file);
    } catch (err) {
      this.logger.warn(`dsh.pid 写入失败: ${(err as Error).message}`);
    }
  }

  /** 删 pid 文件（exit/stop/failed 迁移；同步删防竞态，不存在/损坏 → 无害） */
  private deletePidFile(): void {
    try {
      unlinkSync(join(this.userDataPath, 'dsh.pid'));
    } catch {
      /* 不存在/损坏 → 无害 */
    }
  }

  /** 进程组清理（设计 D3）：SIGTERM 整组 → 宽限未退 → SIGKILL 整组 */
  private async killProcessGroup(child: ChildLike): Promise<void> {
    if (child.exitCode !== null || child.pid === undefined) return;
    const pid = child.pid;
    try {
      this.killFn(-pid, 'SIGTERM');
    } catch {
      /* 进程组不存在 → 已退出 */
    }
    const exited = await this.waitForExit(child, KILL_GRACE_MS);
    if (!exited) {
      try {
        this.killFn(-pid, 'SIGKILL');
      } catch {
        /* 同上 */
      }
      await this.waitForExit(child, POST_KILL_WAIT_MS);
    }
  }

  private waitForExit(child: ChildLike, timeoutMs: number): Promise<boolean> {
    return new Promise((resolve) => {
      if (child.exitCode !== null) {
        resolve(true);
        return;
      }
      const h = () => resolve(true);
      child.once('exit', h);
      void this.sleepImpl(timeoutMs).then(() => {
        child.removeListener('exit', h);
        resolve(false);
      });
    });
  }
}
