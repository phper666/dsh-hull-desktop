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
