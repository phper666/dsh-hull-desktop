import { BrowserWindow, WebContentsView, screen } from 'electron';
import { join } from 'node:path';

import { RuntimePhase, type RuntimeLogger, NOOP_LOGGER, type RuntimeSnapshot, type UpgradeStatus } from '../shared/types';
import type { RuntimeManager } from '../runtime/RuntimeManager';
import { getViewBounds } from './getViewBounds';

/**
 * 壳框架页静态 HTML（不进 tsc；S1 dev 直接引用 src 原样，S2 打包时决定产物布局）
 * dist/window/WindowManager.js → ../../src/renderer/shell.html
 */
const SHELL_HTML = join(__dirname, '..', '..', 'src', 'renderer', 'shell.html');
/** 壳 preload 编译产物：dist/preload/index.js */
const SHELL_PRELOAD = join(__dirname, '..', 'preload', 'index.js');
/** 左侧导航宽（S8 D2 方案 b：官方 view x 偏移 = 200；R4 兜底 nav 最小宽 120px，200 > 120） */
const NAV_WIDTH = 200;

export interface WindowManagerOptions {
  runtime: RuntimeManager;
  /** hull:status 载荷的 getDshStatus 形状部分（D5：runtime + upgrade + currentVersion + canRollback） */
  getStatus: () => DshStatusBase;
  /** 读取 closeToQuit（每次 close 时取，S6 可动态改） */
  isCloseToQuit: () => boolean;
  /** closeToQuit=true → 通知 main 走退出编排（before-quit 防递归由 main 管） */
  onCloseToQuit: () => void;
  /** 升级状态订阅入口（P1-1：updater 状态迁移 → 仅刷新 hull:status payload，不改 view）。
   *  回调注入而非依赖 Updater 类型——保持 S8 模块边界；main 装配时接 updater.on('status') */
  onUpgradeStatus: (cb: () => void) => void;
  /** 计时埋点（t4 did-finish-load） */
  logger?: RuntimeLogger;
}

/** getDshStatus 形状（不含 view；main 的 hull:getDshStatus handler 与 hull:status 推送共用，D5） */
export interface DshStatusBase {
  runtime: RuntimeSnapshot;
  upgrade: UpgradeStatus;
  currentVersion: string | null;
  /** Hull 应用版本（app.getVersion；nav 状态区「Hull 版本」行，M1-重构） */
  hullVersion: string;
  canRollback: boolean;
}

/** hull:status 载荷（D5：getDshStatus 形状 + view 字段 + 占位消息） */
export interface HullStatus extends DshStatusBase {
  /** 右侧内容区视图（主进程单一事实源，D6：renderer 无 view 控制通道） */
  view: ViewState;
  /** 占位视图说明（failed/not-installed 消息；starting/installing 空串） */
  message: string;
}

export type ViewState = 'official' | PlaceholderView;
export type PlaceholderView =
  | 'placeholder:starting'
  | 'placeholder:installing'
  | 'placeholder:failed'
  | 'placeholder:not-installed'
  | 'placeholder:board'
  | 'placeholder:skills'
  | 'placeholder:tokens'
  | 'placeholder:connections'
  | 'placeholder:workflows'
  | 'placeholder:notifs'
  | 'placeholder:settings';
export type PlaceholderMode = 'starting' | 'installing' | 'failed' | 'not-installed' | 'board' | 'skills' | 'tokens' | 'connections' | 'workflows' | 'notifs' | 'settings';

/**
 * 主窗口壳框架（S8 D1-D7 唯一实现依据）：
 * - 壳窗口：BrowserWindow 加载 shell.html（左侧 nav + 右侧内容区 + 占位四区块），
 *   webPreferences { contextIsolation, sandbox, nodeIntegration:false, partition:'persist:shell', preload: 壳 preload }
 *   （D3：'shell' 与 'persist:shell' 是两个不同 session，勿混写；Q-053 看板视图记忆（localStorage kanban:lastView）
 *   需跨重启保持 → 壳页用持久分区，落盘 userData/Partitions/shell）
 * - 官方 UI：WebContentsView（默认 session + 无 preload——CON-R001 结构性零注入，
 *   registerPreloadScript 机制整体删除：PRELOAD_SCRIPT_ID/register/unregister/getPreloadScripts 全无）；
 *   官方 view 只 loadURL 官方地址，永不加载 file://（红线）
 * - 就绪时序（D4 顺序固化防闪错位）：view 创建即 setVisible(false) → 就绪后 setBounds → setVisible(true) → loadURL
 * - 边界同步（D2 幂等）：resize/maximize/unmaximize/enter-full-screen/leave-full-screen +
 *   screen('display-metrics-changed') → applyViewBounds()（getViewBounds 纯函数，单测覆盖）
 * - 状态→视图决策（D5）：runtime status + crash/installFlow 调用点 → hull:status 推送
 *   （payload = getDshStatus 形状 + view；右侧内容区显示完全由主进程 view 字段驱动，D6）
 * - close：closeToQuit=false → preventDefault+hide（T1-06）；true → 放行并通知 main
 */
export class WindowManager {
  private win: BrowserWindow | null = null;
  private officialView: WebContentsView | null = null;
  /** 当前视图状态（初始 placeholder:starting——壳页首载 getDshStatus 取初值） */
  private view: ViewState = 'placeholder:starting';
  private placeholderMessage = '';
  /** official loadURL 已发出（首次 ready） */
  private officialLoaded = false;
  /** 视图离开 official（崩溃/升级/失败）→ 下次 ready 需重载（D6：升级/回滚后同 view 再 loadURL） */
  private officialDirty = false;
  private officialLoading = false;
  private officialUrl: string | null = null;
  /** 退出编排中：close 事件放行（防 closeToQuit=false 的 preventDefault 阻断 app.quit() 最终退出） */
  private quitting = false;
  private readonly options: WindowManagerOptions;
  private readonly logger: RuntimeLogger;

  constructor(options: WindowManagerOptions) {
    this.options = options;
    this.logger = options.logger ?? NOOP_LOGGER;
  }

  /** 创建壳窗口 + official view（起始隐藏），并订阅状态 */
  create(): BrowserWindow {
    if (this.win && !this.win.isDestroyed()) return this.win;
    const win = new BrowserWindow({
      width: 1200,
      height: 800,
      show: false,
      title: 'Hull',
      webPreferences: {
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
        // D3：壳页 partition 'persist:shell'（Q-053 视图记忆需 localStorage 跨重启落盘）+ 静态 preload（SettingsWindow 模式）
        partition: 'persist:shell',
        preload: SHELL_PRELOAD,
      },
    });
    this.win = win;
    // D2：官方 UI 独立 webContents（默认 session、无 preload——CON-R001 结构上不可能注入）
    const officialView = new WebContentsView({
      webPreferences: {
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
      },
    });
    this.officialView = officialView;
    win.contentView.addChildView(officialView);
    officialView.setVisible(false); // D4：就绪前隐藏（顺序固化：setBounds → setVisible(true) → loadURL）
    // did-fail-load / did-finish-load 迁到 official view（t4 计时语义不变）
    officialView.webContents.on('did-fail-load', (_e, errorCode, errorDescription) => {
      this.officialLoading = false; // 🟢-5：加载失败不算 did-finish-load，防 t4 误记
      if (errorCode === -3) return; // ERR_ABORTED（导航竞态），非真实失败
      this.showPlaceholder('failed', `页面加载失败 (${errorCode} ${errorDescription})`);
    });
    officialView.webContents.on('did-finish-load', () => {
      if (this.officialLoading) {
        this.logger.info('[timing] t4 did-finish-load');
        this.officialLoading = false;
      }
    });
    win.once('ready-to-show', () => {
      this.applyViewBounds(); // D2：ready-to-show 补一次
      win.show();
    });
    win.on('close', (e) => {
      if (this.quitting) return; // 退出编排中：放行默认关闭（app.quit() 收尾）
      if (this.options.isCloseToQuit()) {
        this.options.onCloseToQuit(); // 放行默认关闭，退出编排由 main 执行
        return;
      }
      e.preventDefault();
      win.hide(); // T1-06：关闭隐藏到托盘，dsh 继续跑
    });
    // 边界同步（D2）：统一幂等重算；窗口 move 跨屏无需处理（view 坐标相对窗口内容区）
    win.on('resize', () => this.applyViewBounds());
    win.on('maximize', () => this.applyViewBounds());
    win.on('unmaximize', () => this.applyViewBounds());
    win.on('enter-full-screen', () => this.applyViewBounds());
    win.on('leave-full-screen', () => this.applyViewBounds());
    screen.on('display-metrics-changed', () => this.applyViewBounds()); // 注：监听不手动移除——进程级，随 app 退出自然回收（WindowManager 单例常驻）
    this.options.runtime.on('status', (s) => this.onStatus(s));
    // P1-1：updater 状态迁移（checking/confirm/installing…）→ 仅刷新 payload 推送
    // （nav 状态区"升级"列实时；view 字段仍由 runtime 状态驱动，两源职责分离：
    //  runtime → 视图切换，updater → 升级快照渲染）
    this.options.onUpgradeStatus(() => this.sendViewState());
    void win.loadFile(SHELL_HTML).catch(() => {
      /* 壳页加载失败无更好降级，忽略 */
    });
    return win;
  }

  /** 状态订阅：标题 + 视图状态切换 + hull:status 推送 */
  private onStatus(s: RuntimeSnapshot): void {
    if (!this.win || this.win.isDestroyed()) return;
    this.win.setTitle(`Dsh Hull Desktop — ${s.phase}`);
    if (s.phase === RuntimePhase.Ready && s.url) {
      this.loadOfficialUrl(s.url);
    } else if (s.phase === RuntimePhase.Failed) {
      this.showPlaceholder('failed', s.message);
    } else {
      // idle/starting：占位 starting（升级/回滚/重试期间的过渡态推送，S8 §6 R6）
      this.showPlaceholder('starting', '');
    }
  }

  /** 官方 UI（零注入，D2/D4）：setBounds → setVisible(true) → loadURL（顺序固化）；
   *  未加载过 / URL 变化 / 视图曾离开 official（升级/回滚/崩溃/失败）→ loadURL；否则仅复用显示（D6） */
  loadOfficialUrl(url: string): void {
    const win = this.win;
    const view = this.officialView;
    if (!win || win.isDestroyed() || !view) return;
    this.applyViewBounds();
    view.setVisible(true);
    this.view = 'official';
    this.placeholderMessage = '';
    this.sendViewState();
    // 早退条件（未加载过 / URL 变化 / 视图曾离开 official → 必须重载）：
    // 依赖 RuntimeManager 状态机保证"任何 dsh 重启必经 idle/starting 过渡"——
    // 届时 onStatus → showPlaceholder 置 officialDirty，升级/回滚/崩溃后同 view 再 loadURL（D6）
    if (this.officialLoaded && !this.officialDirty && url === this.officialUrl) return;
    this.officialUrl = url;
    this.officialDirty = false;
    this.officialLoaded = true;
    this.officialLoading = true;
    view.webContents.loadURL(url).catch((err) => {
      this.logger.warn(`官方 UI 加载失败: ${(err as Error).message}`);
    });
  }

  /** 占位视图（D4 + S8'：view 3 态扩展——starting/installing/failed/not-installed/board/settings 迁 shell.html 内容区；
   *  main 的 crash/installFlow/导航调用点 + runtime 驱动共用）。
   *  仅切换 view 状态 + hull:status 推送——右侧内容区显示完全由主进程 view 字段驱动（D6） */
  showPlaceholder(mode: PlaceholderMode, message: string): void {
    if (!this.win || this.win.isDestroyed()) return;
    const view: PlaceholderView = `placeholder:${mode}`;
    if (this.view === 'official') this.officialDirty = true;
    this.view = view;
    this.placeholderMessage = message;
    this.officialView?.setVisible(false);
    this.sendViewState();
  }

  /** S8' D1：壳导航/托盘设置入口 → 切 settings 视图（封装 showPlaceholder + 推送，§4.1） */
  showSettings(): void {
    this.showPlaceholder('settings', '');
  }

  /** S1：壳导航 Skills 入口 → 切 skills 视图（镜像 showSettings/showBoard，D6 view 单一事实源不破） */
  showSkills(): void {
    this.showPlaceholder('skills', '');
  }

  /** Token 消耗视图（Skills 之后，镜像 showSkills） */
  showTokens(): void {
    this.showPlaceholder('tokens', '');
  }

  /** 工作台连接视图（设置之前，镜像 showTokens） */
  showConnections(): void {
    this.showPlaceholder('connections', '');
  }

  /** 工作流视图（设置之前，镜像 showConnections） */
  showWorkflows(): void {
    this.showPlaceholder('workflows', '');
  }

  /** 通知中心视图（§9 V1：铃铛入口；工作流首源，source 维度预留） */
  showNotifs(): void {
    this.showPlaceholder('notifs', '');
  }

  /** 官方 view 边界同步（D2）：幂等；resize/maximize/unmaximize/全屏/display-metrics-changed 统一入口 */
  applyViewBounds(): void {
    const win = this.win;
    const view = this.officialView;
    if (!win || win.isDestroyed() || !view) return;
    view.setBounds(getViewBounds(win.getContentBounds(), NAV_WIDTH));
  }

  /** hull:status 载荷（main 的 hull:getDshStatus handler 复用——壳页首载取初值，D5） */
  hullStatus(): HullStatus {
    return { ...this.options.getStatus(), view: this.view, message: this.placeholderMessage };
  }

  /** 官方 view 状态（e2e R2 断言用：Playwright page 不可得时主进程侧兜底） */
  officialViewState(): { url: string; visible: boolean } {
    const view = this.officialView;
    return view && !view.webContents.isDestroyed()
      ? { url: view.webContents.getURL(), visible: view.getVisible() }
      : { url: '', visible: false };
  }

  /** hull:status 推送（D5）：发送前 isDestroyed 兜底（注记 ③——托盘隐藏态 webContents 未销毁，发送无问题） */
  private sendViewState(): void {
    if (!this.win || this.win.isDestroyed()) return;
    this.win.webContents.send('hull:status', this.hullStatus());
  }

  /** 单实例唤醒 / activate 复用（T1-03） */
  show(): void {
    this.win?.show();
  }

  focus(): void {
    this.win?.focus();
  }

  restore(): void {
    if (this.win && !this.win.isDestroyed() && this.win.isMinimized()) this.win.restore();
  }

  /** 供设置页取主窗口作父窗口（非 modal） */
  getWindow(): BrowserWindow | null {
    return this.win && !this.win.isDestroyed() ? this.win : null;
  }

  /** 退出编排标记：main 在最终 app.quit() 前调用，close 事件据此放行 */
  setQuitting(): void {
    this.quitting = true;
  }
}
