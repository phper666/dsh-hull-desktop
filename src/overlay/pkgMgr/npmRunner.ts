import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, isAbsolute, join } from 'node:path';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

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

/** 原生依赖清单（CON-R-pkgmgr-003：需 build scripts 的包；实测可 rebuild） */
export const NATIVE_DEP_PKGS = ['koffi', 'node-pty', 'protobufjs', '@google/genai', '@deepseek-ai/dsh-subprocess-local'];

/** A 方案：corepack 托管固定版本（官方 latest 稳定——pnpm 12 是 RC 不用） */
export const COREPACK_PNPM_VERSION = '11.23.0';

/**
 * 包管理器执行器基类（npm/pnpm 共用骨架）：
 * spawn 子进程 + 逐行输出缓冲（错误分类）+ 总超时 + 取消（SIGTERM→5s→SIGKILL）。
 * 命令/错误码提取由子类实现（模板方法）。
 */
export abstract class BasePkgMgrRunner implements PkgMgrRunner {
  protected readonly nodePath: string;
  protected readonly corepackHome?: string;
  /** install() 解析出的 registry（rebuild/peerFixup 的 spawnOnce 同透传） */
  private activeRegistry: string | null = null;
  protected readonly spawnFn: PkgMgrSpawnFn;
  protected readonly logger: RuntimeLogger;
  protected readonly now: () => number;
  protected readonly sleepImpl: (ms: number) => Promise<void>;
  protected readonly writePkgJson: (stagingDir: string) => void;
  private child: ChildLike | null = null;
  private cancelled = false;

  constructor(options: PkgMgrRunnerOptions) {
    this.nodePath = resolveExecutablePath(options.nodePath);
    this.corepackHome = options.corepackHome;
    this.spawnFn = options.spawnFn ?? ((cmd, args, opts) => spawn(cmd, args, opts));
    this.logger = options.logger ?? NOOP_LOGGER;
    this.now = options.now ?? Date.now;
    this.sleepImpl = options.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
    this.writePkgJson = options.writePkgJson ?? ((dir) => writeFileSync(join(dir, 'package.json'), '{}\n', 'utf8'));
  }

  /** 捆绑 corepack 二进制路径（A 方案：nodePath 同 bin 目录；nodePath 为绝对路径——resolveExecutablePath 已解析） */
  protected corepackBin(): string {
    return corepackBinFor(this.nodePath);
  }

  /** COREPACK_HOME env 注入（壳控缓存；未配 → 不设，corepack 用用户默认缓存） */
  protected corepackEnv(env: NodeJS.ProcessEnv): void {
    if (this.corepackHome) env.COREPACK_HOME = this.corepackHome;
  }

  /** 子类：spawn 命令 + 参数（registry env 已写入 env.npm_config_registry） */
  protected abstract buildArgs(
    stagingDir: string,
    targetVersion: string,
    env: NodeJS.ProcessEnv
  ): { command: string; args: string[] };

  /** 子类：从单行输出提取错误码（npm `npm error code X` / pnpm ERR_PNPM_*；无 → null） */
  protected abstract classify(line: string): string | null;

  /** 子类：标签（错误文案/日志用） */
  protected abstract label(): string;

  /** 子类：安装成功后追加的原生依赖 rebuild 命令（CON-R-pkgmgr-003）。
   *  返回 null = 无需 rebuild（npm 自动 build）。
   *  仅 pnpm 需显式 `pnpm rebuild <pkgs>`（pnpm 11 默认忽略 build scripts——ERR_PNPM_IGNORED_BUILDS）。 */
  protected rebuildCommand(stagingDir: string): { command: string; args: string[] } | null {
    return null;
  }

  /**
   * 良性非零退出判定：包已装好但包管理器返回 warning 型 exit 1（如 pnpm 的 ERR_PNPM_IGNORED_BUILDS——
   * 原生依赖 build scripts 被跳过但安装本身成功）。命中 → 视为成功（走 rebuild）。
   * 默认 false（npm 非零即失败）；pnpm 覆写识别 ERR_PNPM_IGNORED_BUILDS。
   */
  protected isBenignExit(code: number, lines: string[]): boolean {
    return false;
  }

  /** 追加 rebuild（安装成功后调用）：告警不阻断（失败 → warn + 返回，不影响 install 结果） */
  private async runRebuild(stagingDir: string): Promise<void> {
    const spec = this.rebuildCommand(stagingDir);
    if (!spec) return;
    try {
      const code = await this.spawnOnce(spec.command, spec.args, stagingDir);
      if (code !== 0) {
        this.logger.warn(`${this.label()} 原生依赖 rebuild 失败（exit=${code}），可手动补装: ${NATIVE_DEP_PKGS.join(' ')}`);
      }
    } catch (err) {
      this.logger.warn(`${this.label()} 原生依赖 rebuild 失败: ${(err as Error).message}，可手动补装: ${NATIVE_DEP_PKGS.join(' ')}`);
    }
  }

  /** 单次 spawn 到 exit（无超时/取消/逐行回调；rebuild/peer-fixup 短命令用） */
  protected spawnOnce(command: string, args: string[], cwd: string): Promise<number> {
    return new Promise<number>((resolve) => {
      let child: ChildLike;
      try {
        const env: NodeJS.ProcessEnv = { ...process.env };
        this.corepackEnv(env); // COREPACK_HOME 壳控（rebuild 同走 corepack）
        // registry 同透传 install 的选择（缺 → corepack 再拉 pnpm / pnpm 装包走默认源，国内网络挂）
        if (this.activeRegistry) {
          env.npm_config_registry = this.activeRegistry;
          env.COREPACK_NPM_REGISTRY = this.activeRegistry;
        }
        child = this.spawnFn(command, args, {
          cwd,
          stdio: ['ignore', 'pipe', 'pipe'],
          env,
        });
      } catch (err) {
        resolve(-1);
        return;
      }
      const onData = (c: Buffer | string) => {
        const chunk = typeof c === 'string' ? c : c.toString('utf8');
        this.logger.dshLog(0, `[pkgmgr-rebuild] ${chunk.trimEnd()}`);
      };
      child.stdout?.on('data', onData);
      child.stderr?.on('data', onData);
      child.on('error', () => resolve(-1));
      child.on('exit', (code: number | null) => resolve(code ?? -1));
    });
  }

  /** 执行安装到 staging（总超时；registry env 透传） */
  async install(stagingDir: string, targetVersion: string, opts: PkgMgrRunOptions): Promise<PkgMgrResult> {
    this.cancelled = false;
    const env: NodeJS.ProcessEnv = { ...process.env };
    // registry env 注入：npm_config_registry（npm/pnpm 装包识别）+ COREPACK_NPM_REGISTRY
    // （corepack 下载 pnpm 本体识别——实测缺它时 corepack 恒走 registry.npmjs.org，国内网络 ConnectTimeout）
    const registry = opts.registry || process.env.HULL_REGISTRY;
    if (registry) {
      env.npm_config_registry = registry;
      env.COREPACK_NPM_REGISTRY = registry;
      this.activeRegistry = registry; // rebuild/peerFixup 同透传（COREPACK_HOME 缓存空时 corepack 会再拉 pnpm）
    }
    this.corepackEnv(env); // A 方案：COREPACK_HOME 壳控（pnpm 走 corepack）
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
      const seenLines: string[] = [];
      const lineBuf = createLineBuffer((line) => {
        opts.onLine?.(line);
        seenLines.push(line);
        if (seenLines.length > 200) seenLines.shift(); // 只保留最近 200 行（容错判定用）
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
        if (code === 0 || this.isBenignExit(code ?? -1, seenLines)) {
          // P3：主 install 成功（含良性 exit，如 pnpm ignored-builds）→ 追加原生依赖 rebuild + peer fixup；失败告警不阻断
          void (async () => {
            await this.runRebuild(stagingDir);
            await this.runPeerFixup(stagingDir);
            settle({ ok: true });
          })();
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
   *  pnpm 可能 spawn store/worker 子进程——child.kill 仅杀直接 child，子进程树由父退出后
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

  // ===== peer dependencies fixup（dsh-app-boot peer 缺 → 显式 add，修复 ERR_MODULE_NOT_FOUND）=====

  /** 子类钩子：装后需补的 peer 命令（默认 npm 无需——npm 自动装 peer；pnpm 覆写） */
  protected peerFixupCommands(_stagingDir: string): Array<{ command: string; args: string[] }> {
    return [];
  }

  /** 执行 peer fixup（安装成功后调用，对称 runRebuild）：失败告警不阻断 */
  private async runPeerFixup(stagingDir: string): Promise<void> {
    const cmds = this.peerFixupCommands(stagingDir);
    for (const cmd of cmds) {
      try {
        const code = await this.spawnOnce(cmd.command, cmd.args, stagingDir);
        if (code !== 0) this.logger.warn(`${this.label()} peer fixup 失败（exit=${code}）: ${cmd.args.join(' ')}`);
      } catch (err) {
        this.logger.warn(`${this.label()} peer fixup 失败: ${(err as Error).message}`);
      }
    }
  }
}

/** npm 实现（迁移自原 src/overlay/npmRunner.ts——命令/错误解析/取消行为不变） */
export class NpmRunner extends BasePkgMgrRunner {
  protected label(): string {
    return 'npm';
  }

  /** 捆绑 npm-cli 路径（nodePath 推导；平台布局差异见 npmCliPathFor） */
  get npmCliPath(): string {
    return npmCliPathFor(this.nodePath);
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

/** pnpm 实现（A 方案：corepack 托管固定版本，脱离用户环境——`corepack pnpm@<ver> add ...`） */
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
    // peer 自动安装（CON-R-pkgmgr 补充：pnpm 默认 auto-install-peers=false → dsh-app-boot 的
    // peer deps（cordis-plugin-group 等 9 个）不装 → dsh 启动 ERR_MODULE_NOT_FOUND）：
    // 装前写 .npmrc 强制 auto-install-peers（fresh install 生效；既有 lockfile 不重算由装后 peer fixup 兜底）
    try {
      writeFileSync(join(stagingDir, '.npmrc'), 'auto-install-peers=true\n', 'utf8');
    } catch {
      /* .npmrc 写失败不阻断（peer fixup 兜底） */
    }
    return {
      // ⚠️ 用捆绑 node 显式跑 corepack（不直接 spawn corepack）——corepack.js shebang 是 `#!/usr/bin/env node`，
      // 打包环境（Electron app 不继承 shell PATH）无 node → 直接 spawn corepack 会 127（command not found）
      command: this.nodePath,
      args: [
        this.corepackBin(),
        `pnpm@${COREPACK_PNPM_VERSION}`,
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

  /**
   * pnpm 良性退出：exit 1 + 输出含 ERR_PNPM_IGNORED_BUILDS（原生依赖 build scripts 被跳过但安装成功）
   * → 视为成功（包已装好，rebuild 会补原生依赖编译）。前提：无网络错误（pkgErrorCode 非网络类已在上游判定）。
   */
  protected override isBenignExit(code: number, lines: string[]): boolean {
    return code === 1 && lines.some((l) => l.includes('ERR_PNPM_IGNORED_BUILDS'));
  }

  /** P3：pnpm 11 默认忽略 build scripts（ERR_PNPM_IGNORED_BUILDS）→ 装后显式 rebuild 原生依赖（CON-R-pkgmgr-003）。
   *  A 方案：同走 corepack（cwd=stagingDir 已由 runRebuild 注入）；node 显式跑（corepack shebang env node，打包无 PATH node） */
  protected override rebuildCommand(stagingDir: string): { command: string; args: string[] } | null {
    return { command: this.nodePath, args: [this.corepackBin(), `pnpm@${COREPACK_PNPM_VERSION}`, 'rebuild', ...NATIVE_DEP_PKGS] };
  }

  // ===== peer dependencies fixup（dsh-app-boot peer 缺 → 显式 add，修复 ERR_MODULE_NOT_FOUND）=====

  /**
   * 读 @deepseek-ai/dsh-app-boot 的 peerDependencies（createRequire 沿 stagingDir 解析）。
   * - 包不存在/读失败 → {}（无 peer 需补）
   * - 返回 { name: versionRange }（如 { '@deepseek-ai/cordis-plugin-group': '^1.0.1' }）
   * 子类/测试可覆写（seam 注入）。
   */
  protected resolveBootPeerDeps(stagingDir: string): Record<string, string> {
    try {
      const req = createRequire(join(stagingDir, 'package.json'));
      const pkgJsonPath = req.resolve('@deepseek-ai/dsh-app-boot/package.json');
      const pkg = JSON.parse(readFileSync(pkgJsonPath, 'utf8')) as { peerDependencies?: Record<string, string> };
      return pkg.peerDependencies ?? {};
    } catch {
      return {}; // dsh-app-boot 未装/读失败 → 无 peer 需补
    }
  }

  /** 顶层 node_modules/@deepseek-ai/<name> 存在性（peer 是否已链接）。子类/测试可覆写。 */
  protected isPeerPresent(stagingDir: string, name: string): boolean {
    return existsSync(join(stagingDir, 'node_modules', name));
  }

  /**
   * 装后 peer fixup：dsh-app-boot 的 peer 在顶层 node_modules 缺失的 → 返回 pnpm add 命令（逐缺补装）。
   * - 无 peerDeps / 全存在 → []
   * - 缺的 → [{ command: corepack, args: [pnpm@<ver>, add, <name>@<range>] }]
   */
  protected override peerFixupCommands(stagingDir: string): Array<{ command: string; args: string[] }> {
    const peers = this.resolveBootPeerDeps(stagingDir);
    const missing: Array<{ command: string; args: string[] }> = [];
    for (const [name, range] of Object.entries(peers)) {
      if (this.isPeerPresent(stagingDir, name)) continue;
      missing.push({
        // node 显式跑 corepack（同 buildArgs：corepack shebang env node，打包无 PATH node）
        command: this.nodePath,
        args: [this.corepackBin(), `pnpm@${COREPACK_PNPM_VERSION}`, 'add', `${name}@${range}`],
      });
    }
    return missing;
  }
}

/** 平台布局：corepack JS 入口（node 显式跑，见 PnpmRunner.buildArgs 注释）。
 *  - POSIX：bin/corepack 是 symlink → dist/corepack.js（node 可直接执行）——现状不变
 *  - win32：node.exe 同级无 JS 入口（无扩展名 corepack 是 sh 脚本，node 跑不了）。
 *    ⚠️ corepack 0.34+ 的 package.json bin = ./dist/corepack.js，bin/ 目录为空——
 *    真实 JS 在 node_modules/corepack/dist/corepack.js（system node 与捆绑 win zip 同构，实测 2026-08-31） */
export function corepackBinFor(nodePath: string, platform: NodeJS.Platform = process.platform): string {
  const dir = dirname(nodePath);
  if (platform === 'win32') return join(dir, 'node_modules', 'corepack', 'dist', 'corepack.js');
  return join(dir, 'corepack');
}

/** 平台布局：npm-cli.js。
 *  - POSIX：bin/node → 上一级 lib/node_modules/npm/bin/npm-cli.js——现状不变
 *  - win32：node.exe 同级直挂 node_modules/npm/bin/npm-cli.js（无 lib 层） */
export function npmCliPathFor(nodePath: string, platform: NodeJS.Platform = process.platform): string {
  const dir = dirname(nodePath);
  if (platform === 'win32') return join(dir, 'node_modules', 'npm', 'bin', 'npm-cli.js');
  return join(dir, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js');
}

export interface ResolveExecutableOptions {
  platform?: NodeJS.Platform;
  /** 默认 process.env.PATH（测试注入用） */
  pathEnv?: string;
  /** 默认 existsSync（测试注入用） */
  exists?: (p: string) => boolean;
}

/** 相对可执行名 → 绝对路径（PATH 查找；绝对路径原样返回）。npmCliPath 推导依赖绝对 node 路径。
 *  ⚠️ Windows 坑（曾致 dsh-staging\corepack MODULE_NOT_FOUND）：
 *  ① PATH 分隔符是 `;` 非 `:`（用 path.delimiter，跨平台正确）；
 *  ② 目录下是 node.exe——无后缀匹配不到，需补 .exe 候选 */
export function resolveExecutablePath(cmd: string, opts: ResolveExecutableOptions = {}): string {
  if (isAbsolute(cmd)) return cmd;
  const platform = opts.platform ?? process.platform;
  const exists = opts.exists ?? existsSync;
  const dirs = (opts.pathEnv ?? process.env.PATH ?? '').split(platform === 'win32' ? ';' : ':');
  const exts = platform === 'win32' ? ['', '.exe'] : [''];
  for (const dir of dirs) {
    for (const ext of exts) {
      const candidate = join(dir, cmd + ext);
      if (exists(candidate)) return candidate;
    }
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
