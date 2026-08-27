import { Menu, Tray, nativeImage } from 'electron';

import {
  HullUpdatePhase,
  RuntimePhase,
  UpgradePhase,
  type HullUpdateStatus,
  type RuntimeSnapshot,
  type UpgradeStatus,
} from '../shared/types';
import type { RuntimeManager } from '../runtime/RuntimeManager';
import type { Updater } from '../updater/Updater';
import type { HullUpdater } from '../updater/HullUpdater';
import type { UpgradeQueue } from '../updater/UpgradeQueue';

/**
 * 托盘图标：16x16 占位 PNG（纯蓝实心，程序生成的合法 PNG base64）。
 * ⚠️ 真实图标资产后续补（S2 打包期），届时替换此常量即可。
 */
const TRAY_ICON_PNG_BASE64 =
  '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';

export interface TrayControllerOptions {
  runtime: RuntimeManager;
  /** dsh 升级编排（S3） */
  updater: Updater;
  /** Hull 自更新编排（S5） */
  hullUpdater: HullUpdater;
  /** 互斥队列（busy 禁用数据源） */
  queue: UpgradeQueue;
  /** 打开主窗口（show + focus） */
  onOpenMain: () => void;
  /** 打开设置视图（S8' D5：聚焦主窗口 + 切 settings 视图；S6 启用） */
  onOpenSettings: () => void;
  /** 检查 dsh 更新（托盘入口 → main 编排 dialog） */
  onCheckUpdates: () => void;
  /** 检查 Hull 更新（S5 托盘入口 → main 编排 dialog） */
  onCheckHullUpdates: () => void;
  /** 退出（先停 dsh，编排在 main） */
  onQuit: () => void;
  /** dsh 当前版本（tooltip 展示） */
  getDshVersion?: () => string | null;
}

/**
 * 托盘（设计 §3 / 契约 §2 + S3 D11 + S5 切片 3）：
 * 菜单五项：打开主窗口 / 检查更新…（dsh）/ 检查 Hull 更新…（S5）/ Hull 设置…（S1 禁用占位，S6 启用）/ 退出。
 * busy 禁用：queue 占用时「检查更新…」/「检查 Hull 更新…」禁用（queue.inFlight() 数据源；
 * 菜单在队列状态变化时重建——Hull/dsh 升级状态事件驱动）。
 * tooltip：Hull 升级中（downloading phase + pct）优先 → dsh 升级中 → runtime 状态。
 */
export class TrayController {
  private tray: Tray | null = null;
  private lastMenu: Menu | null = null;
  private runtimeSnapshot: RuntimeSnapshot | null = null;
  private upgradeSnapshot: UpgradeStatus | null = null;
  private hullSnapshot: HullUpdateStatus | null = null;
  private lastBusy = true;
  private readonly options: TrayControllerOptions;

  constructor(options: TrayControllerOptions) {
    this.options = options;
  }

  create(): Tray {
    if (this.tray) return this.tray;
    const image = nativeImage.createFromDataURL(`data:image/png;base64,${TRAY_ICON_PNG_BASE64}`);
    const tray = new Tray(image);
    this.tray = tray;
    tray.setToolTip('Dsh Hull Desktop');
    this.rebuildMenu();
    this.options.runtime.on('status', (s: RuntimeSnapshot) => {
      this.runtimeSnapshot = s;
      this.renderTooltip();
    });
    this.options.updater.on('status', (s: UpgradeStatus) => {
      this.upgradeSnapshot = s;
      this.renderTooltip();
      this.rebuildMenu(); // dsh 升级状态变化 → busy 禁用刷新
    });
    this.options.hullUpdater.on('status', (s: HullUpdateStatus) => {
      this.hullSnapshot = s;
      this.renderTooltip();
      this.rebuildMenu(); // Hull 升级状态变化 → busy 禁用刷新
    });
    // E2E-06：升级状态机的 Idle 迁移事件在 queue release 之前发出，仅靠 status 事件托盘 busy 不会刷新
    //（升级完成后菜单永久禁用）→ queue changed（acquire/release）直连刷新
    this.options.queue.on('changed', () => this.rebuildMenu());
    return tray;
  }

  /** 重建菜单（busy 状态变化时；queue.inFlight() 数据源） */
  private rebuildMenu(): void {
    if (!this.tray) return;
    const busy = this.options.queue.inFlight().channel !== null;
    if (busy === this.lastBusy) return;
    this.lastBusy = busy;
    this.lastMenu = Menu.buildFromTemplate([
      { label: '打开主窗口', click: () => this.options.onOpenMain() },
      { label: '检查更新…', enabled: !busy, click: () => this.options.onCheckUpdates() }, // S3 dsh 升级入口
      { label: '检查 Hull 更新…', enabled: !busy, click: () => this.options.onCheckHullUpdates() }, // S5 自更新入口
      { label: 'Hull 设置…', click: () => this.options.onOpenSettings() }, // S6 启用
      { type: 'separator' },
      { label: '退出', click: () => this.options.onQuit() }, // 退出先停 dsh（main 编排）
    ]);
    this.tray.setContextMenu(this.lastMenu);
  }

  /** 当前菜单（e2e 测试读取：原生托盘菜单 Playwright 无法点击，读 items 校验禁用态） */
  getMenu(): Menu | null {
    return this.lastMenu;
  }

  /** tooltip 合并：Hull 升级中 → dsh 升级中 → runtime 状态 */
  private renderTooltip(): void {
    if (!this.tray) return;
    const h = this.hullSnapshot;
    if (h && h.phase !== HullUpdatePhase.Idle) {
      const pct = h.phase === HullUpdatePhase.Downloading ? ` ${h.pct}%` : '';
      this.tray.setToolTip(`Hull — 自更新中（${h.phase}${pct}）`);
      return;
    }
    const up = this.upgradeSnapshot;
    if (up && up.phase !== UpgradePhase.Idle) {
      this.tray.setToolTip(`Hull — 升级中（${up.phase} ${up.pct}%）`);
      return;
    }
    const rs = this.runtimeSnapshot;
    if (!rs) {
      this.tray.setToolTip('Dsh Hull Desktop');
      return;
    }
    if (rs.phase === RuntimePhase.Ready && rs.url) {
      const version = this.options.getDshVersion ? this.options.getDshVersion() : null;
      this.tray.setToolTip(`Hull — dsh 运行中 · v${version ?? 'unknown'} · ${rs.url}`);
      return;
    }
    this.tray.setToolTip(`Hull — ${rs.phase}`);
  }
}
