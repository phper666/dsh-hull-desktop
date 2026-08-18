import { EventEmitter } from 'node:events';

import { HullError } from '../shared/errors';
import {
  InstallPhase,
  NOOP_LOGGER,
  UpgradePhase,
  type RuntimeLogger,
  type UpgradeStatus,
} from '../shared/types';
import { OverlayManager } from '../overlay/OverlayManager';
import { RuntimeManager } from '../runtime/RuntimeManager';
import { SettingsProvider } from '../settings/SettingsProvider';
import { UpgradeQueue } from './UpgradeQueue';
import { SwapManager, UPGRADE_ERRORS, type UpgradeErrorCode } from './SwapManager';
import type { CheckResult, RegistryCheckFn } from './registry';
import { fetchLatestVersion } from './registry';
import type { ChannelService } from '../channel/ChannelService';

/**
 * 7 态迁移表（契约 §升级状态机 + 补充边注记）：
 * idle→checking；checking→confirm/idle；confirm→installing/idle；installing→swapping/idle；
 * swapping→verifying/idle；verifying→idle/rollback；rollback→idle；
 * 补充边：idle→rollback（手动回滚承载，W3——契约表 idle 仅列 checking，S3 设计 D7 决策补充）。
 */
const TRANSITIONS: Record<UpgradePhase, UpgradePhase[]> = {
  [UpgradePhase.Idle]: [UpgradePhase.Checking, UpgradePhase.Rollback],
  [UpgradePhase.Checking]: [UpgradePhase.Confirm, UpgradePhase.Idle],
  [UpgradePhase.Confirm]: [UpgradePhase.Installing, UpgradePhase.Idle],
  [UpgradePhase.Installing]: [UpgradePhase.Swapping, UpgradePhase.Idle],
  [UpgradePhase.Swapping]: [UpgradePhase.Verifying, UpgradePhase.Idle],
  [UpgradePhase.Verifying]: [UpgradePhase.Idle, UpgradePhase.Rollback],
  [UpgradePhase.Rollback]: [UpgradePhase.Idle],
};

export interface UpdaterOptions {
  overlayManager: OverlayManager;
  swapManager: SwapManager;
  runtimeManager: RuntimeManager;
  registry: RegistryCheckFn;
  queue: UpgradeQueue;
  /** S4 版本通道（可选注入：不注入时行为与 S3 完全一致——缺省目标回退 registry latest） */
  channelService?: ChannelService;
  /** S6 autoCheckDsh 读取（可选注入：不注入时默认 true——S3 行为不变） */
  settingsProvider?: SettingsProvider;
  logger?: RuntimeLogger;
  /** 非法迁移：dev throw / prod log 忽略；默认 false */
  dev?: boolean;
}

/**
 * 升级编排（S3 设计 D3/D5/D6/D7/B1/B2/B3/B6/B8/B11，契约 #1~#4 #7 #8）：
 * 7 态状态机 + check（自身 scope acquire/release，gamma 裁决）+ upgrade（独立 acquire + 自动回滚）
 * + cancel（仅 installing）+ rollback（自动/手动共用三步）+ inFlightUpgrade（退出编排 await）。
 */
export class Updater extends EventEmitter {
  private phase: UpgradePhase = UpgradePhase.Idle;
  private currentVersion: string | null = null;
  private targetVersion: string | null = null;
  private error: string | null = null;
  private pct = 0;
  private message = '未开始';
  private inFlight: Promise<UpgradeStatus> | null = null;
  private readonly overlay: OverlayManager;
  private readonly swapManager: SwapManager;
  private readonly runtime: RuntimeManager;
  private readonly registry: RegistryCheckFn;
  private readonly queue: UpgradeQueue;
  private readonly channelService: ChannelService | undefined;
  private readonly settingsProvider: SettingsProvider | undefined;
  private readonly logger: RuntimeLogger;
  private readonly dev: boolean;

  constructor(options: UpdaterOptions) {
    super();
    this.overlay = options.overlayManager;
    this.swapManager = options.swapManager;
    this.runtime = options.runtimeManager;
    this.registry = options.registry;
    this.queue = options.queue;
    this.channelService = options.channelService;
    this.settingsProvider = options.settingsProvider;
    this.logger = options.logger ?? NOOP_LOGGER;
    this.dev = options.dev ?? false;
  }

  /** 状态/进度通知（契约 #7） */
  on(event: 'status', listener: (s: UpgradeStatus) => void): this;
  on(event: string | symbol, listener: (...args: any[]) => void): this {
    return super.on(event, listener);
  }

  /** 升级快照（深拷贝） */
  snapshot(): UpgradeStatus {
    return {
      phase: this.phase,
      currentVersion: this.currentVersion,
      targetVersion: this.targetVersion,
      error: this.error,
      pct: this.pct,
      message: this.message,
    };
  }

  /** 升级完成句柄（B8：swapping+ 段暴露，退出编排 await；无升级 → null） */
  inFlightUpgrade(): Promise<UpgradeStatus> | null {
    return this.inFlight;
  }

  /** 手动回滚可用条件（契约 #8 / W3：previous 存在性；S6 设置页按钮禁用态数据源） */
  canRollback(): boolean {
    return this.swapManager.canRollback();
  }

  /** autoCheckDsh 读取（S6 B4：main 启动自动检查门控；无注入默认 true——S3 行为不变） */
  isAutoCheckEnabled(): boolean {
    return this.settingsProvider ? this.settingsProvider.getSettings().autoCheckDsh : true;
  }

  /** 版本检查（契约 #1）：自身 scope 内 acquire/release（gamma 裁决）；hasUpdate → confirm */
  async check(): Promise<CheckResult & { phase: UpgradePhase }> {
    if (this.phase !== UpgradePhase.Idle) {
      return { hasUpdate: false, current: this.currentVersion, latest: null, phase: this.phase }; // 冲突：非 idle 忽略
    }
    this.currentVersion = this.overlay.currentVersion();
    // Y-1：acquire 成功后才进 checking（失败直接返回，无 checking→idle 闪事件）
    if (!this.queue.acquire('dsh')) {
      this.error = UPGRADE_ERRORS.queueBusy;
      return { hasUpdate: false, current: this.currentVersion, latest: null, phase: UpgradePhase.Idle };
    }
    this.transition(UpgradePhase.Checking, '正在检查更新…');
    try {
      const result = await this.registry({ currentVersion: () => this.currentVersion });
      if (result.hasUpdate) {
        this.targetVersion = result.latest;
        this.transition(UpgradePhase.Confirm, `发现新版本 ${result.latest}`);
        return { ...result, phase: UpgradePhase.Confirm };
      }
      this.error = null;
      this.transition(UpgradePhase.Idle, '当前已是最新版本');
      return { ...result, phase: UpgradePhase.Idle };
    } catch (err) {
      this.error = UPGRADE_ERRORS.checkFailed;
      this.transition(UpgradePhase.Idle, `检查失败: ${(err as Error).message}`);
      return { hasUpdate: false, current: this.currentVersion, latest: null, phase: UpgradePhase.Idle };
    } finally {
      this.queue.release('dsh');
    }
  }

  /**
   * 执行升级（契约 #2 + S4 B1/B3/B5）：独立 acquire（T3-07 queue-busy）；仅 confirm 态可进入。
   * target 缺省 → channelService.resolveTarget()（默认目标：latest → registry latest / pinned → pinnedVersion）；
   * 显式传参（解锁升级）绕过 resolveTarget；无 channelService → registry latest 兜底。
   * B3 guard：目标 == 当前运行版本 → 拒绝「已在该版本」。
   * 解锁回写（B5）：显式绕过 + pinned 通道 + 升级成功 → set('latest')（成功才回写；失败告警容错不阻塞）。
   */
  async upgrade(target?: string): Promise<UpgradeStatus> {
    if (this.phase !== UpgradePhase.Confirm) return this.snapshot(); // 冲突：非 confirm 忽略（须先 check 确认）
    const explicit = target !== undefined;
    if (!explicit) {
      // 缺省目标：channelService（S4）→ resolveTarget；无注入 → registry latest 兜底（S3 兼容）
      target = this.channelService
        ? await this.channelService.resolveTarget()
        : await fetchLatestVersion();
    }
    if (target === undefined) throw new Error('升级目标未解析'); // 理论不可达（explicit / resolveTarget 均返回 string）
    // B3 guard：目标 == 当前运行版本 → 拒绝（🔴-A：先迁移 idle 再抛——与 doUpgrade 其他失败路径对齐，
    // 防 phase 卡 Confirm 导致后续 check/upgrade 被非 idle 拦截永久失效）
    const current = this.overlay.currentVersion();
    if (current !== null && target === current) {
      this.error = UPGRADE_ERRORS.versionInvalid;
      this.transition(UpgradePhase.Idle, `已在该版本: ${target}`);
      throw new HullError(UPGRADE_ERRORS.versionInvalid, `已在该版本: ${target}`);
    }
    this.targetVersion = target;
    if (!this.queue.acquire('dsh')) {
      this.error = UPGRADE_ERRORS.queueBusy;
      this.transition(UpgradePhase.Idle, '另一通道升级中');
      throw new HullError(UPGRADE_ERRORS.queueBusy, '另一通道升级中');
    }
    const run = this.doUpgrade(target);
    this.inFlight = run; // B8：暴露完成句柄
    try {
      const status = await run;
      // 解锁回写（B5）：显式绕过 + pinned 通道 + 升级成功（含未回滚）→ set('latest')
      if (explicit && this.channelService && status.error === null && !status.message.startsWith('已回滚')) {
        try {
          if (this.channelService.get().channel === 'pinned') {
            await this.channelService.set('latest');
            this.logger.info('解锁升级完成，channel 回写 latest');
          }
        } catch (err) {
          // 容错：告警 + resolveTarget 重读兜底（下次 set/启动重写），不阻塞升级结果
          this.logger.warn(`解锁升级 channel 回写失败（容错）: ${(err as Error).message}`);
        }
      }
      return status;
    } finally {
      this.inFlight = null;
    }
  }

  /** 设置页取消确认：confirm → idle，释放目标版本 */
  dismiss(): UpgradeStatus {
    if (this.phase === UpgradePhase.Confirm) {
      this.error = null;
      this.targetVersion = null;
      this.transition(UpgradePhase.Idle, '已稍后再说');
    }
    return this.snapshot();
  }

  /** 取消安装（契约 #3）：仅 installing 段；swapping+ 忽略 */
  async cancel(): Promise<UpgradeStatus> {
    if (this.phase !== UpgradePhase.Installing) return this.snapshot();
    await this.overlay.cancelInstall(); // 清 staging + not-installed + cancelled 事件
    this.error = UPGRADE_ERRORS.cancelled;
    this.transition(UpgradePhase.Idle, '升级已取消（原版本保留）');
    return this.snapshot();
  }

  /** 手动回滚（契约 #4 / W3）：canRollback 前置；三步由 doRollback 承载 */
  async rollback(): Promise<UpgradeStatus> {
    if (!this.swapManager.canRollback()) {
      this.error = UPGRADE_ERRORS.rollbackUnavailable;
      if (this.phase !== UpgradePhase.Idle) this.transition(UpgradePhase.Idle, '无 previous，无法回滚');
      return this.snapshot();
    }
    await this.doRollback('手动回滚');
    return this.snapshot();
  }

  private async doUpgrade(target: string): Promise<UpgradeStatus> {
    try {
      this.transition(UpgradePhase.Installing, `正在安装 dsh@${target}…`);
      this.pct = 50;
      try {
        await this.overlay.install(target);
      } catch (err) {
        const code = this.mapInstallError(err);
        this.error = code;
        this.transition(UpgradePhase.Idle, `安装失败: ${(err as Error).message}`);
        throw err instanceof HullError ? err : new HullError(code, (err as Error).message);
      }
      if (this.phase !== UpgradePhase.Installing) {
        // cancel() 已切 idle → 中止升级（原版保留，不 stop/swap/start）
        return this.snapshot();
      }
      this.pct = 90;
      this.transition(UpgradePhase.Swapping, '正在替换…');
      try {
        await this.runtime.stop(); // 停子进程（设计 §4.1：替换前）
        await this.swapManager.swap();
      } catch (err) {
        const code = this.mapSwapError(err);
        this.error = code;
        // 🟡-1：swap-recovered（已回滚）用原消息（含「已回滚原版可用」），其余统一「替换失败」
        this.transition(
          UpgradePhase.Idle,
          code === UPGRADE_ERRORS.swapRecovered ? (err as Error).message : `替换失败: ${(err as Error).message}`
        );
        throw err instanceof HullError ? err : new HullError(code, (err as Error).message);
      }
      // B1：swap 返回非 ready（overlay cancelled 标志路径）→ 中止：idle + 原版保留 + 不 start
      if (this.overlay.installStatus().phase !== InstallPhase.Ready) {
        this.error = UPGRADE_ERRORS.cancelled;
        this.transition(UpgradePhase.Idle, '升级已中止（原版本保留）');
        throw new HullError(UPGRADE_ERRORS.cancelled, '升级已中止（原版本保留）');
      }
      // verifying（B2：start() 内含就绪验证，无独立 probe 段）
      this.transition(UpgradePhase.Verifying, '正在验证新版本…');
      this.pct = 95;
      try {
        await this.runtime.start();
      } catch (err) {
        // verify-failed → 自动回滚（D6）；回滚成功 = 非失败语义（🟢-B），回滚失败 → 抛错误码
        await this.doRollback(`新版本验证失败: ${(err as Error).message}`);
        if (this.error) throw new HullError(this.error, (err as Error).message);
        return this.snapshot();
      }
      // 成功：清探测注入残留（B3 任务补充）+ 版本回读（🟢-2：读 overlay 实际版本，防 target 'latest' 字面误写）
      delete process.env.HULL_PROBE_TARGET;
      this.currentVersion = this.overlay.currentVersion();
      this.error = null;
      this.pct = 100;
      this.transition(UpgradePhase.Idle, `已升级至 v${this.currentVersion ?? target}`);
      return this.snapshot();
    } finally {
      this.queue.release('dsh'); // 释放 → queue changed 事件 → 托盘 busy 刷新（E2E-06）
    }
  }

  /** 自动/手动回滚共用（D6/D7 三步：stop → swapBack → start；B3/B11） */
  private async doRollback(reason: string): Promise<void> {
    if (!this.swapManager.canRollback()) {
      // 无 previous → 保留现场 + error 语义（无可回滚素材）
      this.error = UPGRADE_ERRORS.verifyFailed;
      this.transition(UpgradePhase.Idle, `${reason}，且无可回滚素材（现场保留）`);
      return;
    }
    this.transition(UpgradePhase.Rollback, `正在回滚: ${reason}`);
    this.pct = 50;
    try {
      await this.runtime.stop();
    } catch (err) {
      this.error = UPGRADE_ERRORS.verifyFailed;
      this.transition(UpgradePhase.Idle, `回滚 stop 失败，保持原状: ${(err as Error).message}`);
      return;
    }
    try {
      await this.swapManager.swapBack();
    } catch (err) {
      // 保留现场 + rollback-unavailable 语义
      this.error = UPGRADE_ERRORS.rollbackUnavailable;
      this.transition(UpgradePhase.Idle, `回滚失败（现场保留）: ${(err as Error).message}`);
      return;
    }
    // B3：回滚恢复 start 前清探测注入（注入生命周期 = verify 段与回滚恢复段各一次）
    delete process.env.HULL_PROBE_TARGET;
    try {
      await this.runtime.start();
    } catch (err) {
      // start 失败 → S1 failed 态可重试；不二次回滚（previous 已消耗）
      this.error = UPGRADE_ERRORS.verifyFailed;
      this.transition(UpgradePhase.Idle, `回滚后启动失败（S1 failed 态可重试）: ${(err as Error).message}`);
      return;
    }
    // B11：currentVersion 回写 previous 版本；🟢-B：回滚成功 = 非失败语义
    this.currentVersion = this.overlay.currentVersion();
    this.error = null;
    this.pct = 100;
    this.transition(UpgradePhase.Idle, '已回滚，原版本可用');
  }

  /** install 段错误映射（§4.3）：S2 码 → S3 install-failed 域 */
  private mapInstallError(err: unknown): UpgradeErrorCode {
    const code = err instanceof HullError ? err.code : null;
    switch (code) {
      case 'cancelled':
        return UPGRADE_ERRORS.cancelled;
      case 'version-invalid':
        return UPGRADE_ERRORS.versionInvalid;
      default:
        // npm-install-failed / registry-unreachable / runtime-unavailable / disk-insufficient → install-failed
        return UPGRADE_ERRORS.installFailed;
    }
  }

  /** swap 段错误映射（SwapManager 已做 B6 域映射；此处兜底非 HullError） */
  private mapSwapError(err: unknown): UpgradeErrorCode {
    const code = err instanceof HullError ? err.code : null;
    if (code === UPGRADE_ERRORS.cancelled) return UPGRADE_ERRORS.cancelled;
    if (code === UPGRADE_ERRORS.swapRecovered) return UPGRADE_ERRORS.swapRecovered; // 🟡-1 透传
    if (code === 'version-invalid') return UPGRADE_ERRORS.versionInvalid;
    return UPGRADE_ERRORS.swapBroken;
  }

  /** 迁移统一入口（表校验；非法 dev throw / prod log 忽略） */
  protected transition(to: UpgradePhase, message: string): boolean {
    const from = this.phase;
    if (!TRANSITIONS[from].includes(to)) {
      const err = new Error(`非法状态迁移: ${from} -> ${to}`);
      if (this.dev) throw err;
      this.logger.warn(`[updater] ${err.message}（忽略）`);
      return false;
    }
    this.phase = to;
    this.message = message;
    this.emit('status', this.snapshot());
    return true;
  }
}
