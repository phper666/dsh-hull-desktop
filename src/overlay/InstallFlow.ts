import { EventEmitter } from 'node:events';
import { statfsSync } from 'node:fs';
import { join } from 'node:path';

import { HullError } from '../shared/errors';
import { InstallPhase, NOOP_LOGGER, type InstallProgress, type RuntimeLogger } from '../shared/types';
import { INSTALL_ERRORS, OverlayManager, type InstallErrorCode, type OverlayFs } from './OverlayManager';

/** 磁盘预检阈值（设计 D7：1GB 固定常量，估算来源见设计，W2 待精化） */
export const MIN_DISK_FREE_BYTES = 1024 * 1024 * 1024;
/** node 解压完整性校验版本文件 */
export const NODE_VERSION_FILE = 'node-version.txt';

export type InstallFlowResult = { ok: true; version: string } | { ok: false; code: InstallErrorCode; message: string };

export interface InstallFlowOptions {
  /** Electron userData 目录（node/ 落点） */
  userDataPath: string;
  /** OverlayManager 实例（构造注入，不重复状态机逻辑；runNpmInstall 已委托 npmRunner） */
  overlay: OverlayManager;
  /** dev 模式：node 解压失败 → 告警跳过走 PATH 兜底（prod → runtime-unavailable） */
  isDev?: boolean;
  logger?: RuntimeLogger;
  /** fs 门面（完整性校验；默认 node:fs） */
  fs?: OverlayFs;
  /** node 内嵌资源解压（S2 打包交付后接入；测试注入） */
  extractNode?: (nodeDir: string) => Promise<void>;
  /** 磁盘可用字节（seam；默认 statfsSync 实测） */
  diskFreeBytes?: () => number;
}

/**
 * 安装编排（设计 §3 / §4.6，契约 #4）：
 * node 解压落位 → 磁盘预检 → OverlayManager.install(staging) → swap() → success。
 * 进度：download 10% 自产；npm-install 50/90、swap 100 由 overlay 事件转发（粗粒度，不解析 npm 输出）。
 */
export class InstallFlow extends EventEmitter {
  private readonly userDataPath: string;
  private readonly overlay: OverlayManager;
  private readonly isDev: boolean;
  private readonly logger: RuntimeLogger;
  private readonly fs: OverlayFs;
  private readonly extractNode: ((nodeDir: string) => Promise<void>) | undefined;
  private readonly diskFreeBytes: () => number;

  constructor(options: InstallFlowOptions) {
    super();
    this.userDataPath = options.userDataPath;
    this.overlay = options.overlay;
    this.isDev = options.isDev ?? false;
    this.logger = options.logger ?? NOOP_LOGGER;
    this.fs = options.fs ?? defaultFs;
    this.extractNode = options.extractNode;
    this.diskFreeBytes =
      options.diskFreeBytes ?? (() => statfsSync(this.userDataPath).bavail * statfsSync(this.userDataPath).bsize);
    // 进度转发（overlay 的 npm-install/swap 事件 → 本对象）
    this.overlay.on('progress', (p: InstallProgress) => this.emit('progress', { ...p }));
  }

  on(event: 'progress', listener: (p: InstallProgress) => void): this;
  on(event: string | symbol, listener: (...args: any[]) => void): this {
    return super.on(event, listener);
  }

  /** 安装编排（targetVersion 默认 latest，S4 决定） */
  async run(targetVersion = 'latest'): Promise<InstallFlowResult> {
    const nodeDir = join(this.userDataPath, 'node');
    // ① node 解压落位（内嵌资源存在时；dev 无内嵌 → PATH 兜底）
    if (!this.fs.exists(join(nodeDir, 'bin', 'node'))) {
      if (this.extractNode) {
        try {
          await this.extractNode(nodeDir);
          // 完整性校验：版本文件存在
          if (!this.fs.exists(join(nodeDir, NODE_VERSION_FILE))) {
            throw new Error(`node 版本文件 ${NODE_VERSION_FILE} 缺失`);
          }
        } catch (err) {
          const msg = `node 解压/校验失败: ${(err as Error).message}`;
          if (this.isDev) {
            this.logger.warn(`${msg}（dev 跳过，PATH 兜底）`);
          } else {
            return { ok: false, code: INSTALL_ERRORS.runtimeUnavailable, message: msg };
          }
        }
      }
    }
    // ② 磁盘预检（D7）
    const free = this.diskFreeBytes();
    if (free < MIN_DISK_FREE_BYTES) {
      return {
        ok: false,
        code: INSTALL_ERRORS.diskInsufficient,
        message: `磁盘可用空间不足（${Math.floor(free / 1024 / 1024)}MB < 1GB 阈值）`,
      };
    }
    // ③ download 阶段完成 → 10%（此后进度由 overlay 转发）
    this.emit('progress', { phase: 'download', pct: 10 });
    // ④ install(staging) → swap → success
    try {
      await this.overlay.install(targetVersion);
      const snap = await this.overlay.swap();
      if (snap.phase !== InstallPhase.Ready) {
        // 🟡-1：install 门禁通过后被取消 → swap 返回非 ready 快照 → cancelled 语义（非 version-invalid）
        return { ok: false, code: INSTALL_ERRORS.cancelled, message: '安装已取消' };
      }
      return { ok: true, version: snap.version ?? '' };
    } catch (err) {
      if (err instanceof HullError) {
        return { ok: false, code: err.code as InstallErrorCode, message: err.message };
      }
      return { ok: false, code: INSTALL_ERRORS.npmInstallFailed, message: (err as Error).message };
    }
  }
}

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, symlinkSync } from 'node:fs';

const defaultFs: OverlayFs = {
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
