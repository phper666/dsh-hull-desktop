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
  'iVBORw0KGgoAAAANSUhEUgAAABQAAAAUCAYAAACNiR0NAAADmklEQVR4nK2VS2wbVRSG/3Nn/BonHj9il9RxQlMVQkkTEBKqWgQbwkOVuuqGNVsW7ZYtO5aIDeoGCSGx7aICAix4FqhKGloVmhanjpPW71ccxx7PvQfNjCdKowiExN3MvTP3fuf855x7BhgNZiZm1vAfBzNrzll/TYdsGAcQcObtNtABkDO9b8ViG4g569ELYEhE2/vPO1750DiAD5VSrzJEQBMQ/+SZVEppQlhKqa+EEO/As+257G6Q8jM+MNZaQ75W6rtzKZm//W2d7xaqB7exlPITn6UTkXRkKuB1h7tjSayUdsTyegeVPiMS0nAsmgIGFi5fuQ5p9TGTGce5l5/F4tM5NR4NO6w3mdkgop4vK6ikcqRrq+WeeP/nMtUt0BPxCM2nIxQPEKUTY7Qwl6NEwqTN+g6999HndPPPgnNeU8oNW9AB+UDWNW/6Rb6NXCKCrBlGOKRjPi4QCuoQgnBmPgfoQRxJJ5HJpHD1+zvuGV13o8Z7QCebzrjftl2Z6VgYgXAIixkDz2eiAHnGzs5ncXrhOPpKwDRj2Khs426h4n7LN5vu093ppQeo9SUiQQ0zMR0vxW1kSncw6O/Ctm0MhzYeFAo4cyyIt5ZOYXoyBS0YxmZ55E1zXx0yc9IxYgNmtbPLaSNA+Xv3cHX5G+i67lQAiAiDgQXDiOD8uTeQnZrCVrnJE4lxMiKhBoBZImo/VmtqKIG+5UIcyT5ISrU3V0qBpYTQNERTSYQiocfq0/VwY6OVzOXM/HcrD8zLV37lxbkZevHkUST1Hp6cziJiGI4MbD18BAVC1zyK6w+7+L3U5QsnYnQ2G23km5g9nqS27gBjMY8+OTEGaQ2wXiyjUG7j9MIsTj4zBjG6S9O5KSxXGDf+aqM/GKLXt5AIuMlFYuShK9k0TVfKidwEZo7E0OlsI0QSP928jx9vFf3KwmrDwo2tFng4RK1rIaUrzE1EPeCI6MeQFHuWzr8yj0qljkq1AZJDXLtdhG1LV+pKdYDdgY2tjoViYwdL04Zbn7ZSe+FzgbVazRJEDlGeeiqr3n37NZ5MGtxoNPnW2iaXqi1uWeDVR10ut3pswuJLz5n8wlTcQUnhFbV1sDl8evDS/7Fe5q9/WeP+YOiuf9js8u3SNjOrg83hY5+1v33FlFIfAFhiRkDTxL+0LygSsATwZb1ev5hKpdy+eFiDNfwG616nJjA760U83/Sy6Sdg1GB7h1r8v34BfwPY/QkCr0/TTgAAAABJRU5ErkJggg==';

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
