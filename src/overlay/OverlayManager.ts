import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';

import { HullError } from '../shared/errors';
import { InstallPhase, NOOP_LOGGER, type InstallProgress, type InstallSnapshot, type RuntimeLogger } from '../shared/types';

/** INSTALL_ERRORS 六码（契约 v0.2 错误集）+ 内部码（S3 rollback 域，非契约六码） */
export const INSTALL_ERRORS = {
  registryUnreachable: 'registry-unreachable',
  npmInstallFailed: 'npm-install-failed',
  diskInsufficient: 'disk-insufficient',
  cancelled: 'cancelled',
  versionInvalid: 'version-invalid',
  runtimeUnavailable: 'runtime-unavailable',
  /** 内部码（S3 rollback 域：swapBack 前置失败，配合 canRollback 前置避免） */
  rollbackUnavailable: 'rollback-unavailable',
} as const;
export type InstallErrorCode = (typeof INSTALL_ERRORS)[keyof typeof INSTALL_ERRORS];

/** fs 门面（默认 node:fs；测试可覆盖个别操作，如注入 rename 失败） */
export interface OverlayFs {
  exists(path: string): boolean;
  /** recursive mkdir */
  mkdir(path: string): void;
  /** recursive + force rm */
  rm(path: string): void;
  rename(a: string, b: string): void;
  symlink(target: string, path: string): void;
  /** 读文本；缺失/不可读 → null */
  readText(path: string): string | null;
}

const DEFAULT_FS: OverlayFs = {
  exists: (p) => existsSync(p),
  mkdir: (p) => mkdirSync(p, { recursive: true }),
  rm: (p) => rmSync(p, { recursive: true, force: true }),
  rename: (a, b) => renameSync(a, b),
  symlink: (t, p) => symlinkSync(t, p),
  readText: (p) => {
    try {
      return readFileSync(p, 'utf8');
    } catch {
      return null;
    }
  },
};

/** npm install 到 staging 的执行器（切片 2 npmRunner 接入；测试注入） */
export type NpmInstallFn = (stagingDir: string, targetVersion: string) => Promise<void>;

export interface OverlayManagerOptions {
  /** Electron userData 目录（dsh / dsh-staging / dsh-previous 落点） */
  userDataPath: string;
  logger?: RuntimeLogger;
  /** fs 门面（测试注入；默认 node:fs） */
  fs?: OverlayFs;
  /** npm install 执行器（默认抛 npm-install-failed——未接入时不可用） */
  runNpmInstall?: NpmInstallFn;
  /** 休眠（测试 seam；swap 取消窗口拦截点） */
  sleep?: (ms: number) => Promise<void>;
}

/**
 * 安装状态迁移表（契约 v0.2 §状态转换）：
 * not-installed→installing；installing→ready/not-installed；ready→installing（S3 升级承载点预留）。
 * ensure() 恢复路径（态 1/态 3/首装）不经过本表（forcePhase）。
 */
const TRANSITIONS: Record<InstallPhase, InstallPhase[]> = {
  [InstallPhase.NotInstalled]: [InstallPhase.Installing],
  [InstallPhase.Installing]: [InstallPhase.Ready, InstallPhase.NotInstalled],
  [InstallPhase.Ready]: [InstallPhase.Installing],
};

/**
 * overlay 管理（设计 S2 0.2 / 契约 #1~#3 #5 #6 #9）：
 * 安装状态机 + install（仅 staging）+ swap（原子替换 + bin symlink）+ 取消 + ensure 三态。
 */
export class OverlayManager extends EventEmitter {
  private phase: InstallPhase = InstallPhase.NotInstalled;
  private version: string | null = null;
  private progress: InstallProgress | null = null;
  private message = '未安装';
  private cancelled = false;
  private swapping = false;
  private targetVersion: string | null = null;
  /** npm http fetch 行计数（首装进度渐进；对齐 Updater.pushOutput，50→60 每 25 行 +1%） */
  private npmFetchCount = 0;
  /** npm 输出环形缓冲（最近 N 行，首装输出框数据源；snapshot().output 透传） */
  private output: string[] = [];
  /** 输出缓冲上限（对齐 Updater.MAX_OUTPUT_LINES 语义） */
  private static readonly MAX_OUTPUT_LINES = 50;
  private readonly userDataPath: string;
  private readonly logger: RuntimeLogger;
  private readonly fs: OverlayFs;
  private readonly runNpmInstall: NpmInstallFn;
  private readonly sleepImpl: (ms: number) => Promise<void>;

  constructor(options: OverlayManagerOptions) {
    super();
    this.userDataPath = options.userDataPath;
    this.logger = options.logger ?? NOOP_LOGGER;
    this.fs = options.fs ?? DEFAULT_FS;
    this.runNpmInstall =
      options.runNpmInstall ??
      (async () => {
        throw new HullError(INSTALL_ERRORS.npmInstallFailed, 'npm 执行器未接入（切片 2 npmRunner）');
      });
    this.sleepImpl = options.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  }

  on(event: 'progress', listener: (p: InstallProgress) => void): this;
  on(event: 'success', listener: (p: { version: string }) => void): this;
  on(event: 'cancelled', listener: () => void): this;
  on(event: 'failed', listener: (p: { code: InstallErrorCode; message: string }) => void): this;
  on(event: string | symbol, listener: (...args: any[]) => void): this {
    return super.on(event, listener);
  }

  /** 安装快照（深拷贝） */
  snapshot(): InstallSnapshot {
    return {
      phase: this.phase,
      version: this.version,
      progress: this.progress ? { ...this.progress } : null,
      message: this.message,
      output: [...this.output],
    };
  }

  /** pkgmgr 输出行钩子（main 的 pkgMgr onLine → 本方法；首装进度 + 输出缓冲）。
   *  仅 installing 段收集（对齐 Updater.pushOutput：其他段不污染缓冲）。
   *  进度解析双格式：
   *  - npm：`npm http fetch` 行计数（每 25 行 +1%，封顶 60）
   *  - pnpm：`Progress: resolved N, … added X[, done]`（added/resolved 比例映射 20→60——
   *    曾只认 npm 格式 → pnpm 首装进度恒 20%） */
  onPkgMgrLine(line: string): void {
    if (this.phase !== InstallPhase.Installing) return;
    this.output.push(line);
    if (this.output.length > OverlayManager.MAX_OUTPUT_LINES) {
      this.output.splice(0, this.output.length - OverlayManager.MAX_OUTPUT_LINES);
    }
    const pnpm = /Progress: resolved (\d+),.*?added (\d+)(, done)?/.exec(line);
    if (pnpm) {
      const resolved = Number(pnpm[1]);
      const added = Number(pnpm[2]);
      const pct = pnpm[3] ? 60 : resolved > 0 ? 20 + Math.floor((40 * added) / resolved) : 20;
      this.setProgress({ phase: 'npm-install', pct: Math.min(60, pct) });
      return;
    }
    if (/^npm http fetch/.test(line)) {
      this.npmFetchCount += 1;
      this.setProgress({ phase: 'npm-install', pct: Math.min(60, 20 + Math.floor(this.npmFetchCount / 25)) });
    }
  }

  /** 轮询安装状态（契约 #6） */
  installStatus(): InstallSnapshot {
    return this.snapshot();
  }

  /** 当前生效版本（读 <userData>/dsh 包 version；无 dsh → null） */
  currentVersion(): string | null {
    if (!this.fs.exists(this.dshDir)) return null;
    return this.readVersionFrom(this.dshDir);
  }

  /** previous 存在性（S3 canRollback/W3 前置；swapBack 可用条件） */
  canRollback(): boolean {
    return this.fs.exists(this.previousDir);
  }

  /**
   * 仅安装到 staging（契约 v0.2 #2，不含 swap）：
   * installing 中重复 install 忽略；起始清 stale staging（幂等）；末尾 pre-swap 门禁。
   */
  async install(targetVersion = 'latest'): Promise<InstallSnapshot> {
    if (this.phase === InstallPhase.Installing) return this.snapshot(); // 重复 install 忽略
    this.cancelled = false;
    this.swapping = false;
    this.targetVersion = targetVersion;
    this.transition(InstallPhase.Installing, '正在安装 dsh…');
    this.setProgress({ phase: 'npm-install', pct: 20 });
    // 输出缓冲 + fetch 计数重置（防跨次安装残留；对齐 Updater.clearOutput）
    this.output = [];
    this.npmFetchCount = 0;
    // 起始清 stale staging（幂等）
    this.fs.rm(this.stagingDir);
    this.fs.mkdir(this.stagingDir);
    try {
      await this.runNpmInstall(this.stagingDir, targetVersion);
    } catch (err) {
      if (this.cancelled) return this.snapshot(); // 🟢-1：已取消 → 不发 failed（防 S3 升级事件双事件）
      if (err instanceof HullError) {
        // 错误码透传（registry-unreachable 等由 npmRunner 分类，切片 2 接入）
        this.failAndCleanup(err.code as InstallErrorCode, err.message);
        throw err;
      }
      const msg = `npm install 失败: ${(err as Error).message}`;
      this.failAndCleanup(INSTALL_ERRORS.npmInstallFailed, msg);
      throw new HullError(INSTALL_ERRORS.npmInstallFailed, msg);
    }
    if (!this.isInstalling() || this.cancelled) return this.snapshot(); // 已取消/状态被改
    const gate = this.checkStagingGate();
    if (!gate.ok) {
      this.failAndCleanup(INSTALL_ERRORS.versionInvalid, gate.reason);
      throw new HullError(INSTALL_ERRORS.versionInvalid, gate.reason);
    }
    this.setProgress({ phase: 'npm-install', pct: 90 });
    return this.snapshot();
  }

  /**
   * 原子替换（契约 v0.2 #9，对齐 S3 #6）：①~⑥ 序列见设计 §4.1。
   * 门禁：仅在非 installing 直入时检查（install 流程已验过）；版本预检在替换前。
   */
  async swap(): Promise<InstallSnapshot> {
    if (this.phase === InstallPhase.Ready || this.swapping) return this.snapshot(); // 幂等
    if (this.cancelled) return this.snapshot(); // 🟡-1：install 门禁通过后取消 → 不误报 version-invalid
    if (this.phase === InstallPhase.NotInstalled) {
      // 直入（ensure 态 2 复用 / 误用）：门禁把关
      const gate = this.checkStagingGate();
      if (!gate.ok) {
        this.failAndCleanup(INSTALL_ERRORS.versionInvalid, gate.reason);
        throw new HullError(INSTALL_ERRORS.versionInvalid, gate.reason);
      }
      this.transition(InstallPhase.Installing, '正在替换…');
    }
    this.swapping = true;
    try {
      this.setProgress({ phase: 'swap', pct: 100 });
      await this.sleepImpl(0); // 取消窗口拦截点：swap 起始后 cancel 忽略（B3）
      // 版本预检（显式 targetVersion 匹配；latest 跳过——门禁已验 bin 字段）
      const stagingVersion = this.readVersionFrom(this.stagingDir);
      if (this.targetVersion && this.targetVersion !== 'latest' && stagingVersion !== this.targetVersion) {
        const msg = `staging 版本 ${stagingVersion ?? '未知'} ≠ 目标 ${this.targetVersion}`;
        this.failAndCleanup(INSTALL_ERRORS.versionInvalid, msg);
        throw new HullError(INSTALL_ERRORS.versionInvalid, msg);
      }
      try {
        this.swapCore();
      } catch (err) {
        // ④ 回滚（回滚结果与后续 throw 分离，防内层 catch 自吞）
        this.rollbackSwap(`原子替换失败: ${(err as Error).message}`);
      }
      // ⑤ post-swap bin symlink（🟡-3：失败告警 + 重试一次 → 仍败走回滚）
      const linkErr = this.createBinSymlinkWithRetry();
      if (linkErr) this.rollbackSwap(`post-swap bin symlink 失败: ${linkErr}`);
      // ⑥ 版本记录
      this.version = this.readVersionFrom(this.dshDir);
      this.transition(InstallPhase.Ready, `dsh 就绪（v${this.version ?? 'unknown'}）`);
      this.emit('success', { version: this.version ?? 'unknown' });
      return this.snapshot();
    } finally {
      this.swapping = false; // 🟡-3：任何路径都复位，防卡死
    }
  }

  /** 取消（Q-011 / B3）：仅 installing 可取消；swap 起始后忽略；清 staging → not-installed + cancelled */
  async cancelInstall(): Promise<InstallSnapshot> {
    if (this.phase !== InstallPhase.Installing || this.swapping) return this.snapshot();
    this.cancelled = true;
    this.fs.rm(this.stagingDir);
    this.transition(InstallPhase.NotInstalled, '安装已取消');
    this.emit('cancelled');
    return this.snapshot();
  }

  /**
   * 回滚反向原语（S2 契约 #10，S3 Updater.rollback 承载）：
   * ① rename dsh → dsh-staging（保留现场）② rename dsh-previous → dsh
   * ③ 恢复 bin symlink（相对路径本可存活，保险重建）④ 版本回读为 previous 版本。
   * 前置：previous 不存在 → rollback-unavailable（内部码，配合 canRollback 前置）。
   * 失败处理：① 失败 → 原状保留可重试；② 失败 → staging 现场还原 + 错误语义。
   */
  async swapBack(): Promise<InstallSnapshot> {
    if (!this.fs.exists(this.previousDir)) {
      const err = new HullError(INSTALL_ERRORS.rollbackUnavailable, '无 dsh-previous，无法回滚');
      this.emit('failed', { code: INSTALL_ERRORS.rollbackUnavailable, message: err.message });
      throw err;
    }
    // ① dsh → staging（保留现场）；失败 → dsh 未动，错误语义可重试
    try {
      this.fs.rename(this.dshDir, this.stagingDir);
    } catch (err) {
      const e = new HullError(INSTALL_ERRORS.npmInstallFailed, `回滚 ① 失败（dsh 未动，可重试）: ${(err as Error).message}`);
      this.emit('failed', { code: INSTALL_ERRORS.npmInstallFailed, message: e.message });
      throw e;
    }
    try {
      // ② previous → dsh
      this.fs.rename(this.previousDir, this.dshDir);
    } catch (err) {
      // ② 失败 → 现场还原（staging → dsh）+ 错误语义
      try {
        this.fs.rename(this.stagingDir, this.dshDir);
      } catch {
        /* 现场还原失败 → 保留 staging 现场待排查 */
      }
      const e = new HullError(INSTALL_ERRORS.npmInstallFailed, `回滚失败（现场已还原或保留）: ${(err as Error).message}`);
      this.emit('failed', { code: INSTALL_ERRORS.npmInstallFailed, message: e.message });
      throw e;
    }
    // ③ bin symlink（恢复目录来自 previous；保险重建，best-effort 不阻断回滚）
    try {
      this.createBinSymlink();
    } catch (err) {
      this.logger.warn(`回滚后 bin symlink 重建失败: ${(err as Error).message}`);
    }
    // ④ 版本回读
    this.version = this.readVersionFrom(this.dshDir);
    this.forcePhase(InstallPhase.Ready, `dsh 已回滚（v${this.version ?? 'unknown'}）`);
    return this.snapshot();
  }

  /**
   * ensure() 三态（Q-004 / CON-R014，设计 D9）：
   * 态1 dsh 在 → 清 stale staging → ready；态2 dsh 缺 + staging 在 → 续替；态3 dsh 缺 + previous 在 → 回滚；首装 → not-installed。
   */
  async ensure(): Promise<InstallPhase> {
    const hasDsh = this.fs.exists(this.dshDir);
    const hasStaging = this.fs.exists(this.stagingDir);
    const hasPrevious = this.fs.exists(this.previousDir);
    if (hasDsh) {
      // 态1：清 stale staging（幂等）
      this.fs.rm(this.stagingDir);
      this.version = this.readVersionFrom(this.dshDir);
      this.forcePhase(InstallPhase.Ready, 'dsh 已就绪');
      return InstallPhase.Ready;
    }
    if (hasStaging) {
      // 态2：续替（崩溃残留恢复；门禁不过 → 清 staging → not-installed）
      const gate = this.checkStagingGate();
      if (!gate.ok) {
        this.failAndCleanup(INSTALL_ERRORS.versionInvalid, gate.reason);
        return InstallPhase.NotInstalled;
      }
      this.cancelled = false;
      this.transition(InstallPhase.Installing, '续替安装…');
      this.setProgress({ phase: 'swap', pct: 100 });
      try {
        this.swapCore();
      } catch (err) {
        try {
          if (this.fs.exists(this.previousDir)) this.fs.rename(this.previousDir, this.dshDir);
          this.version = this.readVersionFrom(this.dshDir);
          this.forcePhase(InstallPhase.Ready, 'dsh 就绪（替换中止，原版保留）'); // Y-1：实际为原版保留/续替中止，非回滚
          this.emit('failed', {
            code: INSTALL_ERRORS.npmInstallFailed,
            message: `续替失败: ${(err as Error).message}`,
          });
          return InstallPhase.Ready;
        } catch {
          this.failAndCleanup(INSTALL_ERRORS.cancelled, '续替失败且无回滚素材');
          return InstallPhase.NotInstalled;
        }
      }
      this.createBinSymlink();
      this.version = this.readVersionFrom(this.dshDir);
      this.forcePhase(InstallPhase.Ready, 'dsh 就绪');
      this.emit('success', { version: this.version ?? 'unknown' });
      return InstallPhase.Ready;
    }
    if (hasPrevious) {
      // 态3：回滚（🟡-4：rename 失败 → not-installed，走自动重装路径，与态2 gate 失败同处理）
      try {
        this.fs.rename(this.previousDir, this.dshDir);
      } catch (err) {
        this.failAndCleanup(INSTALL_ERRORS.npmInstallFailed, `回滚失败: ${(err as Error).message}`);
        return InstallPhase.NotInstalled;
      }
      this.version = this.readVersionFrom(this.dshDir);
      this.forcePhase(InstallPhase.Ready, 'dsh 已回滚');
      return InstallPhase.Ready;
    }
    // 首装
    this.forcePhase(InstallPhase.NotInstalled, '未安装（等待自动安装）');
    return InstallPhase.NotInstalled;
  }

  private get dshDir(): string {
    return join(this.userDataPath, 'dsh');
  }

  private get stagingDir(): string {
    return join(this.userDataPath, 'dsh-staging');
  }

  private get previousDir(): string {
    return join(this.userDataPath, 'dsh-previous');
  }

  /** 当前处于 installing（独立方法读取，避免外层窄化误判） */
  private isInstalling(): boolean {
    return this.phase === InstallPhase.Installing;
  }

  /** 安装流程迁移（表校验，非法 → throw 即内部 bug） */
  private transition(to: InstallPhase, message: string): void {
    const from = this.phase;
    if (!TRANSITIONS[from].includes(to)) {
      throw new Error(`非法状态迁移: ${from} -> ${to}`);
    }
    this.phase = to;
    this.message = message;
  }

  /** ensure() 恢复路径（态 1/态 3/首装）不经过安装流程迁移表 */
  private forcePhase(to: InstallPhase, message: string): void {
    this.phase = to;
    this.message = message;
  }

  private setProgress(p: InstallProgress): void {
    this.progress = { ...p };
    this.emit('progress', { ...p });
  }

  private failAndCleanup(code: InstallErrorCode, message: string): void {
    this.fs.rm(this.stagingDir);
    if (this.phase !== InstallPhase.NotInstalled) this.transition(InstallPhase.NotInstalled, message);
    this.emit('failed', { code, message });
  }

  /** pre-swap 门禁（设计 §4.1）：.bin/dsh 存在 + 包 package.json bin 字段合法（npm --prefix 不产 staging 根 package.json） */
  private checkStagingGate(): { ok: true } | { ok: false; reason: string } {
    if (!this.fs.exists(join(this.stagingDir, 'node_modules', '.bin', 'dsh'))) {
      return { ok: false, reason: 'staging 缺少 node_modules/.bin/dsh' };
    }
    const pkg = this.readPackageJson(this.stagingDir);
    if (!pkg || typeof pkg.bin !== 'object' || pkg.bin === null) {
      return { ok: false, reason: 'staging 包 package.json 缺失或 bin 字段非法' };
    }
    return { ok: true };
  }

  /** 原子替换序列 ①~③（设计 §4.1） */
  private swapCore(): void {
    // ① 旧备份清场
    this.fs.rm(this.previousDir);
    // ② 当前版退为备份（首装 dsh 不存在 → 跳过）
    if (this.fs.exists(this.dshDir)) this.fs.rename(this.dshDir, this.previousDir);
    // ③ staging → dsh（同卷原子）
    this.fs.rename(this.stagingDir, this.dshDir);
  }

  /** ⑤ post-swap bin symlink：<dsh>/bin/dsh → ../node_modules/.bin/dsh */
  private createBinSymlink(): void {
    const binDir = join(this.dshDir, 'bin');
    const link = join(binDir, 'dsh');
    this.fs.rm(link);
    this.fs.mkdir(binDir);
    this.fs.symlink('../node_modules/.bin/dsh', link);
  }

  /** ⑤ post-swap bin symlink（🟡-3）：失败告警 + 重试一次；返回错误信息（null = 成功） */
  private createBinSymlinkWithRetry(): string | null {
    try {
      this.createBinSymlink();
      return null;
    } catch (err) {
      this.logger.warn(`bin symlink 创建失败（重试一次）: ${(err as Error).message}`);
      try {
        this.createBinSymlink();
        return null;
      } catch (err2) {
        return (err2 as Error).message;
      }
    }
  }

  /**
   * 回滚序列（④/⑤）：优先恢复旧版（symlink 失败时新版先退回 staging 保留现场）；
   * ② 失败（dsh 未动）→ 原版直接保留；无 previous（首装）→ 清场 not-installed + cancelled 语义
   * （🟡-2：throw 码与 emit 事件一致）。
   */
  private rollbackSwap(msg: string): never {
    let restored = false;
    try {
      if (this.fs.exists(this.previousDir)) {
        if (this.fs.exists(this.dshDir)) this.fs.rename(this.dshDir, this.stagingDir);
        this.fs.rename(this.previousDir, this.dshDir);
        restored = true;
      } else if (this.fs.exists(this.dshDir)) {
        restored = true; // ② 失败：dsh 未被移动，原版仍在 → 直接保留
      }
    } catch {
      /* 回滚失败 → 首装路径 */
    }
    if (restored) {
      this.fs.rm(this.stagingDir); // 清理残留 staging（如 ⑤ 回滚后存在）
      this.version = this.readVersionFrom(this.dshDir);
      this.transition(InstallPhase.Ready, 'dsh 就绪（已回滚至上一版）');
      this.emit('failed', { code: INSTALL_ERRORS.npmInstallFailed, message: msg });
      throw new HullError(INSTALL_ERRORS.npmInstallFailed, msg);
    }
    // 首装（无 previous 可回滚）→ not-installed + cancelled 语义（设计 §4.1 ④）
    this.fs.rm(this.stagingDir);
    if (this.phase !== InstallPhase.NotInstalled) this.transition(InstallPhase.NotInstalled, '原子替换失败，无回滚素材');
    this.emit('cancelled');
    throw new HullError(INSTALL_ERRORS.cancelled, msg);
  }

  /** 读 <dir>/node_modules/@deepseek-ai/dsh/package.json */
  private readPackageJson(dir: string): { version?: unknown; bin?: unknown } | null {
    const text = this.fs.readText(join(dir, 'node_modules', '@deepseek-ai', 'dsh', 'package.json'));
    if (text === null) return null;
    try {
      return JSON.parse(text) as { version?: unknown; bin?: unknown };
    } catch {
      return null;
    }
  }

  /** 读生效目录的包版本（读不到 → null） */
  private readVersionFrom(dir: string): string | null {
    const pkg = this.readPackageJson(dir);
    return pkg && typeof pkg.version === 'string' ? pkg.version : null;
  }
}
