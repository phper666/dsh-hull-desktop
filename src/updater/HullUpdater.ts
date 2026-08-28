import { EventEmitter } from 'node:events';
import { CancellationToken } from 'builder-util-runtime';

import { HullError } from '../shared/errors';
import { HullUpdatePhase, NOOP_LOGGER, type HullUpdateStatus, type RuntimeLogger } from '../shared/types';
import { RuntimeManager } from '../runtime/RuntimeManager';
import { SettingsProvider } from '../settings/SettingsProvider';
import { UpgradeQueue } from './UpgradeQueue';
import type { ElectronUpdaterAdapter } from './electronUpdaterAdapter';

/** HULL_UPDATE_ERRORS（契约 S5 §错误集 五码） */
export const HULL_UPDATE_ERRORS = {
  checkFailed: 'check-failed',
  downloadFailed: 'download-failed',
  installFailed: 'install-failed',
  gatekeeperBlocked: 'gatekeeper-blocked',
  queueBusy: 'queue-busy',
} as const;
export type HullUpdateErrorCode = (typeof HULL_UPDATE_ERRORS)[keyof typeof HULL_UPDATE_ERRORS];

/**
 * 6 态迁移表（契约 §状态转换 + 补充边注记）：
 * idle→checking；checking→confirm/idle；confirm→downloading/idle；downloading→restarting/idle；
 * restarting→done；done→idle（重启前终态——重启后新实例从 idle 起）。
 * restart-prompt 枚举保留（S6 UI 渲染态），状态机不迁移到它（Q-012 无稍后重启）。
 */
const TRANSITIONS: Record<HullUpdatePhase, HullUpdatePhase[]> = {
  [HullUpdatePhase.Idle]: [HullUpdatePhase.Checking],
  [HullUpdatePhase.Checking]: [HullUpdatePhase.Confirm, HullUpdatePhase.Idle],
  [HullUpdatePhase.Confirm]: [HullUpdatePhase.Downloading, HullUpdatePhase.Idle],
  [HullUpdatePhase.Downloading]: [HullUpdatePhase.Restarting, HullUpdatePhase.Idle],
  [HullUpdatePhase.Restarting]: [HullUpdatePhase.Done, HullUpdatePhase.Idle], // idle = B3 stop 失败中止路径
  [HullUpdatePhase.Done]: [HullUpdatePhase.Idle],
  [HullUpdatePhase.RestartPrompt]: [], // 枚举保留，无迁移
};

export interface HullUpdaterOptions {
  adapter: ElectronUpdaterAdapter;
  queue: UpgradeQueue;
  runtimeManager: RuntimeManager;
  /** autoCheckHull 读取（main 自动检查门控） */
  settingsProvider: SettingsProvider;
  /** 当前 Hull 版本（main 传 app.getVersion，B8） */
  getVersion: () => string;
  logger?: RuntimeLogger;
  /** 非法迁移：dev throw / prod log 忽略；默认 false */
  dev?: boolean;
}

export interface HullCheckResult {
  hasUpdate: boolean;
  targetVersion: string | null;
  changeNotes: string | null;
  error: string | null;
}

/**
 * Hull 壳自更新（S5 设计 D3/D4/D5/D6/D6b/D10，契约 #1~#5）：
 * 6 态状态机 + check（全占槽，B2）+ download（CancellationToken 可取消）+ cancel（仅 downloading）
 * + installAndRestart（stop 失败中止，B3；quitAndInstallMode 衔接 S1 双 flag）+ 预防性提示事件。
 */
export class HullUpdater extends EventEmitter {
  private phase: HullUpdatePhase = HullUpdatePhase.Idle;
  private currentVersion: string | null = null;
  private targetVersion: string | null = null;
  private changeNotes: string | null = null;
  private error: string | null = null;
  private pct = 0;
  /** 下载详情（transferred/total/bytesPerSecond；S6 下载中展示，非下载态 0） */
  private transferred = 0;
  private total = 0;
  private bytesPerSecond = 0;
  private message = '未开始';
  private queueHeld = false;
  private cancelled = false;
  private quitAndInstallMode = false;
  private cancellationToken: CancellationToken | null = null;
  private readonly adapter: ElectronUpdaterAdapter;
  private readonly queue: UpgradeQueue;
  private readonly runtime: RuntimeManager;
  private readonly settings: SettingsProvider;
  private readonly getVersion: () => string;
  private readonly logger: RuntimeLogger;
  private readonly dev: boolean;

  constructor(options: HullUpdaterOptions) {
    super();
    this.adapter = options.adapter;
    this.queue = options.queue;
    this.runtime = options.runtimeManager;
    this.settings = options.settingsProvider;
    this.getVersion = options.getVersion;
    this.logger = options.logger ?? NOOP_LOGGER;
    this.dev = options.dev ?? false;
    this.currentVersion = this.getVersion();
    // 下载进度透传（tooltip/S6 进度条数据源）
    this.adapter.on('download-progress', (p) => {
      this.pct = Math.round(p.percent);
      this.transferred = p.transferred ?? 0;
      this.total = p.total ?? 0;
      this.bytesPerSecond = p.bytesPerSecond ?? 0;
      this.emit('status', this.snapshot());
    });
    // 🟡-2：adapter error 事件订阅（防静默错误 + unhandled；映射 check/download 失败语义）
    this.adapter.on('error', (err) => {
      this.logger.warn(`electron-updater 错误: ${err.message}`);
      if (this.phase === HullUpdatePhase.Downloading) {
        this.error = HULL_UPDATE_ERRORS.downloadFailed;
        this.releaseQueue();
        this.transition(HullUpdatePhase.Idle, `下载失败: ${err.message}`);
      } else if (this.phase === HullUpdatePhase.Checking) {
        this.error = HULL_UPDATE_ERRORS.checkFailed;
        this.releaseQueue();
        this.transition(HullUpdatePhase.Idle, `检查失败: ${err.message}`);
      }
    });
  }

  /** 状态/进度通知（契约 #4） */
  on(event: 'status', listener: (s: HullUpdateStatus) => void): this;
  /** 预防性提示事件（B1：confirm/download 完成 → main 弹 dialog） */
  on(event: 'preventive-prompt', listener: (p: { stage: 'confirm' | 'download-complete' }) => void): this;
  on(event: string | symbol, listener: (...args: any[]) => void): this {
    return super.on(event, listener);
  }

  /** 快照（深拷贝） */
  snapshot(): HullUpdateStatus {
    return {
      phase: this.phase,
      currentVersion: this.currentVersion,
      targetVersion: this.targetVersion,
      changeNotes: this.changeNotes,
      error: this.error,
      pct: this.pct,
      transferred: this.transferred,
      total: this.total,
      bytesPerSecond: this.bytesPerSecond,
      message: this.message,
    };
  }

  /** quitAndInstallMode（B8 getter：main before-quit 放行凭据） */
  isQuitAndInstallMode(): boolean {
    return this.quitAndInstallMode;
  }

  /** autoCheckHull 读取（main 启动自动检查门控） */
  isAutoCheckEnabled(): boolean {
    return this.settings.getSettings().autoCheckHull;
  }

  /** 检查更新（契约 #1）：全占槽（B2，单次 acquire 连续持有至终态） */
  async check(): Promise<HullCheckResult> {
    if (this.phase !== HullUpdatePhase.Idle) {
      return { hasUpdate: false, targetVersion: null, changeNotes: null, error: null }; // 冲突：非 idle 忽略
    }
    if (!this.queue.acquire('hull')) {
      this.error = HULL_UPDATE_ERRORS.queueBusy;
      return { hasUpdate: false, targetVersion: null, changeNotes: null, error: HULL_UPDATE_ERRORS.queueBusy };
    }
    this.queueHeld = true;
    this.transition(HullUpdatePhase.Checking, '正在检查更新…');
    try {
      const info = await this.adapter.checkForUpdates();
      if (info) {
        this.targetVersion = info.version;
        this.changeNotes = info.releaseNotes ?? null;
        this.transition(HullUpdatePhase.Confirm, `发现新版本 ${info.version}`);
        // 🟡-1：confirm 阶段不弹预防提示（并入确认框 detail 或省略——仅 download-complete 弹一次）
        return { hasUpdate: true, targetVersion: info.version, changeNotes: this.changeNotes, error: null };
      }
      this.releaseQueue();
      this.error = null;
      this.transition(HullUpdatePhase.Idle, '已是最新版本');
      return { hasUpdate: false, targetVersion: null, changeNotes: null, error: null };
    } catch (err) {
      this.releaseQueue();
      this.error = HULL_UPDATE_ERRORS.checkFailed;
      this.transition(HullUpdatePhase.Idle, `检查失败: ${(err as Error).message}`);
      return { hasUpdate: false, targetVersion: null, changeNotes: null, error: HULL_UPDATE_ERRORS.checkFailed };
    }
  }

  /** 下载更新（契约 #2）：confirm → downloading（CancellationToken 可取消）→ restarting（Q-012 自动） */
  async download(): Promise<HullUpdateStatus> {
    if (this.phase !== HullUpdatePhase.Confirm) return this.snapshot(); // 冲突
    this.cancelled = false;
    this.pct = 0;
    this.transferred = 0;
    this.total = 0;
    this.bytesPerSecond = 0;
    this.transition(HullUpdatePhase.Downloading, '正在下载更新…');
    this.cancellationToken = new CancellationToken(); // 真实 CancellationToken（electron-updater 需要 createPromise/cancelled，最小接口报错）
    try {
      await this.adapter.downloadUpdate(this.cancellationToken);
      if (!this.isDownloading()) return this.snapshot(); // 已取消/error 事件已处理
      this.transition(HullUpdatePhase.Restarting, '下载完成，准备重启安装…'); // Q-012 无稍后重启
      this.emit('preventive-prompt', { stage: 'download-complete' }); // B1 预防性提示（仅此一次）
      return this.snapshot();
    } catch (err) {
      if (!this.isDownloading()) return this.snapshot(); // 🟡-2：error 事件已处理（防双处理）
      if (this.cancelled) {
        this.releaseQueue();
        this.error = null;
        this.transition(HullUpdatePhase.Idle, '下载已取消');
        return this.snapshot();
      }
      this.releaseQueue();
      this.error = HULL_UPDATE_ERRORS.downloadFailed;
      this.transition(HullUpdatePhase.Idle, `下载失败: ${(err as Error).message}`);
      throw new HullError(HULL_UPDATE_ERRORS.downloadFailed, `下载失败: ${(err as Error).message}`);
    }
  }

  /** 稍后再说（🔴-1）：confirm 态 → idle + 释放互斥槽（幂等；防 phase 卡 Confirm + 队列永久占用） */
  dismiss(): HullUpdateStatus {
    if (this.phase !== HullUpdatePhase.Confirm) return this.snapshot();
    this.releaseQueue();
    this.error = null;
    this.transition(HullUpdatePhase.Idle, '已稍后再说（当日不再提示）');
    return this.snapshot();
  }

  /** 取消下载（契约 #5）：仅 downloading 阶段可取消；installAndRestart 阶段不可取消 */
  cancel(): HullUpdateStatus {
    if (this.phase !== HullUpdatePhase.Downloading) return this.snapshot();
    this.cancelled = true; // 置本地标志（download catch 判断 this.cancelled）
    this.cancellationToken?.cancel(); // 通知真实 token（electron-updater 感知取消，emit cancel）
    return this.snapshot();
  }

  /**
   * 重启安装（契约 #3）：acquire 占槽（download 已持有则续用）→ stop（B3：失败中止）→
   * quitAndInstallMode 置位 → quitAndInstall（内部 app.quit → before-quit 放行）。
   */
  async installAndRestart(): Promise<HullUpdateStatus> {
    if (this.phase !== HullUpdatePhase.Restarting) return this.snapshot(); // 冲突
    if (!this.queueHeld) {
      if (!this.queue.acquire('hull')) {
        this.error = HULL_UPDATE_ERRORS.queueBusy;
        throw new HullError(HULL_UPDATE_ERRORS.queueBusy, '另一通道升级中');
      }
      this.queueHeld = true;
    }
    try {
      try {
        await this.runtime.stop(); // 停 dsh 防孤儿（契约：重启前必须先停）
      } catch (err) {
        // B3：stop 失败 → idle + install-failed，不调 quitAndInstall
        this.releaseQueue();
        this.error = HULL_UPDATE_ERRORS.installFailed;
        this.transition(HullUpdatePhase.Idle, `停止 dsh 失败，中止重启安装: ${(err as Error).message}`);
        throw new HullError(HULL_UPDATE_ERRORS.installFailed, `停止 dsh 失败: ${(err as Error).message}`);
      }
      this.quitAndInstallMode = true; // S1 双 flag 衔接（before-quit 放行凭据）
      this.transition(HullUpdatePhase.Done, '正在重启安装…');
      try {
        this.adapter.quitAndInstall();
      } catch (err) {
        // 🟡-3：quitAndInstall 失败 → 复位 quitAndInstallMode（防后续正常退出跳过 stop → 孤儿 dsh）
        this.quitAndInstallMode = false;
        this.releaseQueue();
        this.error = HULL_UPDATE_ERRORS.installFailed;
        this.transition(HullUpdatePhase.Idle, `重启安装失败: ${(err as Error).message}`);
        throw new HullError(HULL_UPDATE_ERRORS.installFailed, `重启安装失败: ${(err as Error).message}`);
      }
      return this.snapshot();
    } finally {
      this.releaseQueue();
    }
  }

  private releaseQueue(): void {
    if (this.queueHeld) {
      this.queue.release('hull'); // 释放 → queue changed 事件 → 托盘 busy 刷新（E2E-06）
      this.queueHeld = false;
    }
  }

  /** 当前处于 downloading（独立方法读取，避免外层窄化误判） */
  private isDownloading(): boolean {
    return this.phase === HullUpdatePhase.Downloading;
  }

  /** 迁移统一入口（表校验；非法 dev throw / prod log 忽略） */
  protected transition(to: HullUpdatePhase, message: string): boolean {
    const from = this.phase;
    if (!TRANSITIONS[from].includes(to)) {
      const err = new Error(`非法状态迁移: ${from} -> ${to}`);
      if (this.dev) throw err;
      this.logger.warn(`[hull-updater] ${err.message}（忽略）`);
      return false;
    }
    this.phase = to;
    this.message = message;
    this.emit('status', this.snapshot());
    return true;
  }
}
