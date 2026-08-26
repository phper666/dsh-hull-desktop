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
  'iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAAAXNSR0IArs4c6QAAAERlWElmTU0AKgAAAAgAAYdpAAQAAAABAAAAGgAAAAAAA6ABAAMAAAABAAEAAKACAAQAAAABAAAAIKADAAQAAAABAAAAIAAAAACshmLzAAADa0lEQVRYCe1WS08TURT+7p2htUALLUKpDwggCL7QhVFRokYTEx+JLsRojCsXJibGhYk/wJU742PlwujKRBcG0WBIxKBG3Ul8xBdKASkthWILtJ3OzPXcQY2Jiw5j1Jhwmskkk3vO993vfOfestJgo8A/DP4PsS3oOQJzCswp8H8rIISAfH4nHCugaznUb2tBzZZ10DXNMQfHBAzTRJkO0dqwNKfphmMCqpNMKbvL7RK79u8ZP7h3J//cP1B4p/2e2+OZN+tyjhTQczrajh2Jb969PcXA2LmLZ1Nbt7VqmUz2zxIQJHtmKo1NOzYnj54+Hs+m09zQdfh8XnH5yoXk6tUrdC07Oz9w2gDsPCaBl1TMx/JNa+GvXuTu6XzgE6aAm2SPDI/wrodPPBUNNTxQWQ651k5NuYaV167PO0cSqLa50QKL9n/GxOgY0pPTOHBoX7Z55VJ+6dLVgpHROMqC5VhQV4VsOoOPvW/AOG0uT6iM5bcBVxli4QhSiS+AYRBxDn9TLQaXBPlQIvYyyVFdwNXARHQME7FxFPt9UFTV1hnBKupa8iogN2HS3DNVga+pBqHdrQhsWAWl0J0pLSu9aSSnjfCt7urBjp6mVH8kKAwTnNbaCdsEvAS8YE8rvM31YC4VjNoiDJHxetwdpHWauVUTOVOJdD1dONDes2wyPFxBBPL2wBYBxjncwQApwBEKVaGwsAiRoQFqBRNCy00Ve0uEv2w+BsN9mJxMGUSOZxJJL/UgLwFbB5Ecv/RQzHJ3qG4NJsbiWFbVKDcoAYplv0ejw2igb4+7Oy2P2DGgbFF+B8pVFEyhiaVH9lZxuSD3ljNy0HKa5Xa1gL7Rj1Sx5f6ZqoAtBb4vlsXfvuqFx1OEd697oSiK5XRPUTFKSgPWtxlRvmfkf5MHNtIU2BoEq5pBY0io4AQu39Jm8m4wyZSSkCQ5m6AJFwkq47ebJEF+xDcw+SKfOghGHmDsDOM/FXVQxkmKPMzIM+e5MNh9IUzdSZHfySFMahq/xmOfHr2AMNv/pgoSi6bobrwv9Fx2zlRRcJKOtTd/g4QFbhofuKKeAG4YVvNTiXDSV7K4gy7RKrJ1A/WHiNmfDDutmLn0hEl+vU3nyeHou4efZN4vM1NZ27LWZKyNCJyyU9juGkF/nDhj16PvHz37Oecr4RVEwP4me9cAAAAASUVORK5CYII=';

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
