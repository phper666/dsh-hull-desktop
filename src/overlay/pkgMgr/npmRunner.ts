import { spawn } from 'node:child_process';
import { dirname, isAbsolute, join } from 'node:path';
import { existsSync, writeFileSync } from 'node:fs';

import { NOOP_LOGGER, type ChildLike, type RuntimeLogger } from '../../shared/types';
import { INSTALL_ERRORS } from '../OverlayManager';
import type {
  PkgMgrResult,
  PkgMgrRunOptions,
  PkgMgrRunner,
  PkgMgrRunnerOptions,
  PkgMgrSpawnFn,
  PkgMgrSpawnOptions,
} from './types';

/** npm install 总超时（实测：dsh 依赖元数据解析极慢——淘宝源间歇 ETIMEDOUT，单包重试 87s/156s，254 包累积远超 600s。
 *  600s → 3000s（50 分钟，留 5x 余量兜住网络抖动 + 大依赖慢装；用户确认） */
export const NPM_INSTALL_TIMEOUT_MS = 3_000_000;
/** npm fetch 挂起防呆（--fetch-timeout 参数；超时归 registry-unreachable 判定） */
export const FETCH_TIMEOUT_MS = 30_000;
/** kill 宽限（SIGTERM → SIGKILL） */
export const KILL_GRACE_MS = 5_000;
/** 输出行缓冲上限 */
const MAX_LINE_BYTES = 8 * 1024;
/** 网络类错误码（三实现共用 → registry-unreachable） */
const NETWORK_ERROR_CODES = ['ECONNREFUSED', 'EAI_AGAIN', 'ETIMEDOUT', 'ENOTFOUND', 'ECONNRESET'];

/**
 * 包管理器执行器基类（npm/pnpm/yarn 共用骨架）：
 * spawn 子进程 + 逐行输出缓冲（错误分类）+ 总超时 + 取消（SIGTERM→5s→SIGKILL）。
 * 命令/错误码提取由子类实现（模板方法）。
 */
export abstract class BasePkgMgrRunner implements PkgMgrRunner {
  protected readonly nodePath: string;
  protected readonly spawnFn: PkgMgrSpawnFn;
  protected readonly logger: RuntimeLogger;
  protected readonly now: () => number;
  protected readonly sleepImpl: (ms: number) => Promise<void>;
  protected readonly writePkgJson: (stagingDir: string) => void;
  private child: ChildLike | null = null;
  private cancelled = false;

  constructor(options: PkgMgrRunnerOptions) {
    this.nodePath = resolveExecutablePath(options.nodePath);
    this.spawnFn = options.spawnFn ?? ((cmd, args, opts) => spawn(cmd, args, opts));
    this.logger = options.logger ?? NOOP_LOGGER;
    this.now = options.now ?? Date.now;
    this.sleepImpl = options.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
    this.writePkgJson = options.writePkgJson ?? ((dir) => writeFileSync(join(dir, 'package.json'), '{}\n', 'utf8'));
  }

  /** 子类：spawn 命令 + 参数（registry env 已写入 env.npm_config_registry） */
  protected abstract buildArgs(
    stagingDir: string,
    targetVersion: string,
    env: NodeJS.ProcessEnv
  ): { command: string; args: string[] };

  /** 子类：从单行输出提取错误码（npm `npm error code X` / pnpm ERR_PNPM_* / yarn `error X:`；无 → null） */
  protected abstract classify(line: string): string | null;

  /** 子类：标签（错误文案/日志用） */
  protected abstract label(): string;

  /** 执行安装到 staging（总超时；registry env 透传） */
  async install(stagingDir: string, targetVersion: string, opts: PkgMgrRunOptions): Promise<PkgMgrResult> {
    this.cancelled = false;
    const env: NodeJS.ProcessEnv = { ...process.env };
    // registry env 注入（npm_config_registry 通用变量——npm/pnpm/yarn 均识别）
    if (opts.registry) env.npm_config_registry = opts.registry;
    else if (process.env.HULL_REGISTRY) env.npm_config_registry = process.env.HULL_REGISTRY;
    const { command, args } = this.buildArgs(stagingDir, targetVersion, env);
    const child = this.spawnFn(command, args, {
      cwd: stagingDir,
      stdio: ['ignore', 'pipe', 'pipe'],
      env,
    });
    this.child = child;
    return new Promise<PkgMgrResult>((resolve) => {
      let settled = false;
      let pkgErrorCode: string | null = null;
      const settle = (r: PkgMgrResult) => {
        if (!settled) {
          settled = true;
          resolve(r);
        }
      };
      // 输出行缓冲：逐行 → onLine + 错误码提取
      const lineBuf = createLineBuffer((line) => {
        opts.onLine?.(line);
        const code = this.classify(line);
        if (code) pkgErrorCode = code;
      });
      const onData = (c: Buffer | string) => lineBuf(typeof c === 'string' ? c : c.toString('utf8'));
      child.stdout?.on('data', onData);
      child.stderr?.on('data', onData);
      child.on('error', (err: Error) =>
        settle({
          ok: false,
          code: INSTALL_ERRORS.npmInstallFailed,
          error: `${this.label()} spawn 失败: ${err.message}`,
        })
      );
      child.on('exit', (code: number | null) => {
        if (this.cancelled) {
          settle({ ok: false, code: INSTALL_ERRORS.cancelled, error: `${this.label()} 安装已取消` });
          return;
        }
        if (code === 0) {
          settle({ ok: true });
          return;
        }
        if (pkgErrorCode && this.isNetworkError(pkgErrorCode)) {
          settle({ ok: false, code: INSTALL_ERRORS.registryUnreachable, error: `${this.label()} error code ${pkgErrorCode}` });
          return;
        }
        settle({ ok: false, code: INSTALL_ERRORS.npmInstallFailed, error: `${this.label()} 非零退出（code=${code ?? 'null'}）` });
      });
      // 总超时（now/sleep seam 可快进）
      void (async () => {
        const deadline = this.now() + NPM_INSTALL_TIMEOUT_MS;
        while (!settled && this.now() < deadline) await this.sleepImpl(100);
        if (!settled) {
          if (this.cancelled) {
            settle({ ok: false, code: INSTALL_ERRORS.cancelled, error: `${this.label()} 安装已取消` });
          } else {
            this.logger.warn(`${this.label()} install 超时（${NPM_INSTALL_TIMEOUT_MS}ms），kill 子进程`);
            this.killChild();
            settle({
              ok: false,
              code: INSTALL_ERRORS.npmInstallFailed,
              error: `${this.label()} install 超时（${NPM_INSTALL_TIMEOUT_MS}ms）`,
            });
          }
        }
      })();
    });
  }

  /** 取消：置 cancelled 标志 + 内联 kill（SIGTERM → 5s 宽限 → SIGKILL） */
  cancel(): void {
    this.cancelled = true;
    this.killChild();
  }

  /** 网络错误码判定（子类可扩展——pnpm 的 ERR_PNPM_FETCH_* 也是 registry 类错误） */
  protected isNetworkError(code: string): boolean {
    return NETWORK_ERROR_CODES.includes(code);
  }

  private killChild(): void {
    const child = this.child;
    if (!child || child.exitCode !== null) return;
    void this.killWithGrace(child);
  }

  /** 内联 kill（B10 简化，不抽 shared）：SIGTERM → 宽限未退 → SIGKILL。
   *  pnpm/yarn 可能 spawn store/worker 子进程——child.kill 仅杀直接 child，子进程树由父退出后
   *  自行回收（与 npm 现状同构；完整进程树杀需 detached + 进程组，属 P2 spawn 改造范围）。 */
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
      // Y-2：SIGKILL 后不等待 exit——exit 事件随后在 event loop 触发，由 install() 的 exit 监听 settle()，无泄漏
    }
  }
}

/** npm 实现（迁移自原 src/overlay/npmRunner.ts——命令/错误解析/取消行为不变） */
export class NpmRunner extends BasePkgMgrRunner {
  protected label(): string {
    return 'npm';
  }

  /** 捆绑 npm-cli 路径（nodePath 推导：<nodeDir>/lib/node_modules/npm/bin/npm-cli.js） */
  get npmCliPath(): string {
    return join(dirname(this.nodePath), '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js');
  }

  protected buildArgs(
    stagingDir: string,
    targetVersion: string,
    _env: NodeJS.ProcessEnv
  ): { command: string; args: string[] } {
    return {
      command: this.nodePath,
      args: [
        this.npmCliPath,
        'install',
        `@deepseek-ai/dsh@${targetVersion}`,
        '--prefix',
        stagingDir,
        `--fetch-timeout=${FETCH_TIMEOUT_MS}`,
        // B 方案：--prefer-offline 优先用本地 npm 缓存
        '--prefer-offline',
        // 改进：--loglevel=http 逐包输出 → onLine → 升级输出框实时显示
        '--loglevel=http',
      ],
    };
  }

  protected classify(line: string): string | null {
    const m = /^npm error code (\S+)/.exec(line);
    return m ? m[1] : null;
  }
}

/** pnpm 实现（`pnpm add <pkg>@<ver> --prefix <staging>` + prefer-symlinked-executables） */
export class PnpmRunner extends BasePkgMgrRunner {
  protected label(): string {
    return 'pnpm';
  }

  protected buildArgs(
    stagingDir: string,
    targetVersion: string,
    _env: NodeJS.ProcessEnv
  ): { command: string; args: string[] } {
    this.writePkgJson(stagingDir); // pnpm --prefix 需指向含 package.json 的目录
    return {
      command: 'pnpm',
      args: [
        'add',
        `@deepseek-ai/dsh@${targetVersion}`,
        '--prefix',
        stagingDir,
        // CON-R-pkgmgr-002：POSIX .bin 变 symlink（Windows 忽略）
        '--config.prefer-symlinked-executables=true',
      ],
    };
  }

  protected classify(line: string): string | null {
    // pnpm 网络类错误：ERR_PNPM_FETCH_*（404/500 等）→ 返回完整 FETCH_<code> 供 isNetworkError 判定
    const m = /^ERR_PNPM_FETCH_(\S+)/.exec(line);
    if (m) return `FETCH_${m[1]}`;
    const raw = /(ECONNREFUSED|EAI_AGAIN|ETIMEDOUT|ENOTFOUND|ECONNRESET)/.exec(line);
    return raw ? raw[1] : null;
  }

  /** ERR_PNPM_FETCH_* 属 registry 类错误（包解析/下载失败 → registry-unreachable） */
  protected override isNetworkError(code: string): boolean {
    return NETWORK_ERROR_CODES.includes(code) || code.startsWith('FETCH_');
  }
}

/** yarn 实现（`yarn add <pkg>@<ver>`） */
export class YarnRunner extends BasePkgMgrRunner {
  protected label(): string {
    return 'yarn';
  }

  protected buildArgs(
    stagingDir: string,
    targetVersion: string,
    _env: NodeJS.ProcessEnv
  ): { command: string; args: string[] } {
    this.writePkgJson(stagingDir); // yarn 需 staging 根 package.json
    return {
      command: 'yarn',
      args: ['add', `@deepseek-ai/dsh@${targetVersion}`],
    };
  }

  protected classify(line: string): string | null {
    // yarn v1 错误行格式：`error <code>: message`；或原始网络错误码行
    const m = /^error (\S+):/.exec(line);
    if (m) return m[1];
    const raw = /(ECONNREFUSED|EAI_AGAIN|ETIMEDOUT|ENOTFOUND|ECONNRESET)/.exec(line);
    return raw ? raw[1] : null;
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
