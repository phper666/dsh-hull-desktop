import { spawn } from 'node:child_process';
import { dirname, isAbsolute, join } from 'node:path';
import { existsSync } from 'node:fs';

import { HullError } from '../shared/errors';
import { NOOP_LOGGER, type ChildLike, type RuntimeLogger } from '../shared/types';
import { INSTALL_ERRORS, type InstallErrorCode } from './OverlayManager';

/** npm install 总超时（设计 D5/B5：实测冷装 dsh 234s（254 包/301MB），120s 不足 → 600s 留 2.5x 余量；不入配置面） */
export const NPM_INSTALL_TIMEOUT_MS = 600_000;
/** npm fetch 挂起防呆（--fetch-timeout 参数；超时归 registry-unreachable 判定） */
export const FETCH_TIMEOUT_MS = 30_000;
/** kill 宽限（SIGTERM → SIGKILL） */
export const KILL_GRACE_MS = 5_000;
/** 输出行缓冲上限 */
const MAX_LINE_BYTES = 8 * 1024;
/** npm 网络类错误码（→ registry-unreachable） */
const NETWORK_ERROR_CODES = ['ECONNREFUSED', 'EAI_AGAIN', 'ETIMEDOUT', 'ENOTFOUND', 'ECONNRESET'];

export interface NpmRunResult {
  ok: boolean;
  /** 失败时的错误码（六码子集：registry-unreachable / npm-install-failed / cancelled） */
  code?: InstallErrorCode;
  error?: string;
}

export interface NpmSpawnOptions {
  cwd: string;
  stdio: ['ignore', 'pipe', 'pipe'];
  env: NodeJS.ProcessEnv;
}

export type NpmSpawnFn = (command: string, args: readonly string[], options: NpmSpawnOptions) => ChildLike;

export interface NpmRunnerOptions {
  /** 捆绑 node 二进制路径（npm-cli.js 由其推导：<nodeDir>/lib/node_modules/npm/bin/npm-cli.js） */
  nodePath: string;
  /** spawn 注入（默认 child_process.spawn） */
  spawnFn?: NpmSpawnFn;
  /** registry 来源（S6 B7：settings.registry 优先 + env 兜底——main 注入 settings 读取；缺省仅 env） */
  getRegistry?: () => string | null;
  logger?: RuntimeLogger;
  /** 时钟（120s 超时预算 seam） */
  now?: () => number;
  /** 休眠（kill 宽限 seam） */
  sleep?: (ms: number) => Promise<void>;
  /** 输出行回调（逐行，供进度粗估算/诊断） */
  onLine?: (line: string) => void;
}

/**
 * npm 执行器（设计 D2/B5/B10，spawnArgs 风格单点收敛）：
 * 非 detached spawn + 内联 kill（SIGTERM→5s→SIGKILL）；120s 总超时；
 * 输出行缓冲仅提取 `npm error code <CODE>` 做错误分类（分类 ≠ 进度解析，D4 不解析进度）。
 */
export class NpmRunner {
  private readonly nodePath: string;
  private readonly spawnFn: NpmSpawnFn;
  private readonly getRegistry: () => string | null;
  private readonly logger: RuntimeLogger;
  private readonly now: () => number;
  private readonly sleepImpl: (ms: number) => Promise<void>;
  private readonly onLine: ((line: string) => void) | undefined;
  private child: ChildLike | null = null;
  private cancelled = false;

  constructor(options: NpmRunnerOptions) {
    this.nodePath = resolveExecutablePath(options.nodePath);
    this.spawnFn = options.spawnFn ?? ((cmd, args, opts) => spawn(cmd, args, opts));
    this.getRegistry = options.getRegistry ?? (() => null);
    this.logger = options.logger ?? NOOP_LOGGER;
    this.now = options.now ?? Date.now;
    this.sleepImpl = options.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
    this.onLine = options.onLine;
  }

  /** 捆绑 npm-cli 路径（nodePath 推导：<nodeDir>/lib/node_modules/npm/bin/npm-cli.js） */
  get npmCliPath(): string {
    return join(dirname(this.nodePath), '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js');
  }

  /** 执行 npm install 到 staging（120s 总超时；registry 走 HULL_REGISTRY env 透传） */
  async run(stagingDir: string, targetVersion: string): Promise<NpmRunResult> {
    this.cancelled = false;
    const env: NodeJS.ProcessEnv = { ...process.env };
    // S6 B7：settings.registry 优先 + env 兜底（默认官方 = 不设 npm_config_registry）
    const registry = this.getRegistry() ?? process.env.HULL_REGISTRY;
    if (registry) env.npm_config_registry = registry;
    const args = [
      this.npmCliPath,
      'install',
      `@deepseek-ai/dsh@${targetVersion}`,
      '--prefix',
      stagingDir,
      `--fetch-timeout=${FETCH_TIMEOUT_MS}`,
    ];
    const child = this.spawnFn(this.nodePath, args, {
      cwd: stagingDir,
      stdio: ['ignore', 'pipe', 'pipe'],
      env,
    });
    this.child = child;
    return new Promise<NpmRunResult>((resolve) => {
      let settled = false;
      let npmErrorCode: string | null = null;
      const settle = (r: NpmRunResult) => {
        if (!settled) {
          settled = true;
          resolve(r);
        }
      };
      // 输出行缓冲：仅提取 `npm error code <CODE>`（分类用，不解析进度）
      const lineBuf = createLineBuffer((line) => {
        if (this.onLine) this.onLine(line);
        const m = /^npm error code (\S+)/.exec(line);
        if (m) npmErrorCode = m[1];
      });
      const onData = (c: Buffer | string) => lineBuf(typeof c === 'string' ? c : c.toString('utf8'));
      child.stdout?.on('data', onData);
      child.stderr?.on('data', onData);
      child.on('error', (err: Error) =>
        settle({ ok: false, code: INSTALL_ERRORS.npmInstallFailed, error: `npm spawn 失败: ${err.message}` })
      );
      child.on('exit', (code: number | null) => {
        if (this.cancelled) {
          // cancelled 标志：主动 kill 的非零退出不误映射为 npm-install-failed
          settle({ ok: false, code: INSTALL_ERRORS.cancelled, error: 'npm 安装已取消' });
          return;
        }
        if (code === 0) {
          settle({ ok: true });
          return;
        }
        if (npmErrorCode && NETWORK_ERROR_CODES.includes(npmErrorCode)) {
          settle({ ok: false, code: INSTALL_ERRORS.registryUnreachable, error: `npm error code ${npmErrorCode}` });
          return;
        }
        settle({ ok: false, code: INSTALL_ERRORS.npmInstallFailed, error: `npm 非零退出（code=${code ?? 'null'}）` });
      });
      // 120s 总超时（常量；now/sleep seam 可快进）
      void (async () => {
        const deadline = this.now() + NPM_INSTALL_TIMEOUT_MS;
        while (!settled && this.now() < deadline) await this.sleepImpl(100);
        if (!settled) {
          if (this.cancelled) {
            settle({ ok: false, code: INSTALL_ERRORS.cancelled, error: 'npm 安装已取消' });
          } else {
            this.logger.warn(`npm install 超时（${NPM_INSTALL_TIMEOUT_MS}ms），kill 子进程`);
            this.killChild();
            settle({
              ok: false,
              code: INSTALL_ERRORS.npmInstallFailed,
              error: `npm install 超时（${NPM_INSTALL_TIMEOUT_MS}ms）`,
            });
          }
        }
      })();
    });
  }

  /** 取消：置 cancelled 标志 + 内联 kill（SIGTERM → 5s 宽限 → SIGKILL，非 detached） */
  cancel(): void {
    this.cancelled = true;
    this.killChild();
  }

  /** 适配 OverlayManager.runNpmInstall 注入点：结构化结果 → 抛 HullError（错误码透传） */
  toRunNpmInstall(): (stagingDir: string, targetVersion: string) => Promise<void> {
    return async (stagingDir: string, targetVersion: string) => {
      const r = await this.run(stagingDir, targetVersion);
      if (!r.ok) throw new HullError(r.code ?? INSTALL_ERRORS.npmInstallFailed, r.error ?? 'npm install 失败');
    };
  }

  private killChild(): void {
    const child = this.child;
    if (!child || child.exitCode !== null) return;
    void this.killWithGrace(child);
  }

  /** 内联 kill（B10 简化，不抽 shared）：SIGTERM → 宽限未退 → SIGKILL */
  private async killWithGrace(child: ChildLike): Promise<void> {
    try {
      child.kill('SIGTERM');
    } catch {
      /* 已退出 */
    }
    const exited = await new Promise<boolean>((resolve) => {
      if (child.exitCode !== null) {
        resolve(true);
        return;
      }
      const h = () => resolve(true);
      child.once('exit', h);
      void this.sleepImpl(KILL_GRACE_MS).then(() => {
        child.removeListener('exit', h);
        resolve(false);
      });
    });
    if (!exited && child.exitCode === null) {
      try {
        child.kill('SIGKILL');
      } catch {
        /* 同上 */
      }
      // Y-2：SIGKILL 后不等待 exit——exit 事件随后在 event loop 触发，由 run() 的 exit 监听 settle()，无泄漏
    }
  }
}

/** 相对可执行名 → 绝对路径（PATH 查找；绝对路径原样返回）。npmCliPath 推导依赖绝对 node 路径 */
function resolveExecutablePath(cmd: string): string {
  if (isAbsolute(cmd)) return cmd;
  const dirs = (process.env.PATH ?? '').split(':');
  for (const dir of dirs) {
    const candidate = join(dir, cmd);
    if (existsSync(candidate)) return candidate;
  }
  return cmd; // 找不到 → 原样返回，spawn 报错更清晰
}

/** 行缓冲：跨 chunk 半行重组；超长截断；空行跳过 */
function createLineBuffer(onLine: (line: string) => void): (chunk: string) => void {
  let residue = '';
  return (chunk: string) => {
    residue += chunk;
    if (residue.length > MAX_LINE_BYTES) residue = residue.slice(-MAX_LINE_BYTES);
    let idx = residue.indexOf('\n');
    while (idx !== -1) {
      const line = residue.slice(0, idx);
      residue = residue.slice(idx + 1);
      if (residue.length > MAX_LINE_BYTES) residue = residue.slice(-MAX_LINE_BYTES);
      if (line.length > 0) onLine(line);
      idx = residue.indexOf('\n');
    }
  };
}
