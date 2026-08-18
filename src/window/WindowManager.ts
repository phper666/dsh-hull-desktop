import { BrowserWindow } from 'electron';
import { join } from 'node:path';

import { RuntimePhase, type RuntimeLogger, NOOP_LOGGER, type RuntimeSnapshot } from '../shared/types';
import type { RuntimeManager } from '../runtime/RuntimeManager';

/**
 * 占位页静态 HTML（不进 tsc；S1 dev 直接引用 src 原样，S2 打包时决定产物布局）
 * dist/window/WindowManager.js → ../../src/renderer/placeholder.html
 */
const PLACEHOLDER_HTML = join(__dirname, '..', '..', 'src', 'renderer', 'placeholder.html');
/** preload 编译产物：dist/preload/index.js */
const PRELOAD_PATH = join(__dirname, '..', 'preload', 'index.js');

export interface WindowManagerOptions {
  runtime: RuntimeManager;
  /** 读取 closeToQuit（每次 close 时取，S6 可动态改） */
  isCloseToQuit: () => boolean;
  /** closeToQuit=true → 通知 main 走退出编排（before-quit 防递归由 main 管） */
  onCloseToQuit: () => void;
  /** 计时埋点（t4 did-finish-load） */
  logger?: RuntimeLogger;
}

export type PlaceholderMode = 'starting' | 'installing' | 'failed' | 'not-installed';

/**
 * 主窗口（设计 §3 / §4.3）：
 * - 安全基线：contextIsolation + sandbox + nodeIntegration=false（PRD §6）
 * - preload 仅随占位页挂载；官方 UI loadURL 不挂（零注入 CON-R001）
 *   ⚠️ 偏离 D6 实现形态：electron loadURL 无 preload 选项（LoadURLOptions 无此字段，
 *   已核对 electron 43 d.ts），用 session.setPreloads 实现同语义：占位页加载前挂载、官方加载前清空。
 * - close：closeToQuit=false → preventDefault+hide（T1-06）；true → 放行并通知 main
 * - 状态订阅：ready → loadURL 官方地址；failed → 占位页 failed 态
 */
export class WindowManager {
  private win: BrowserWindow | null = null;
  private officialLoading = false;
  /** 退出编排中：close 事件放行（防 closeToQuit=false 的 preventDefault 阻断 app.quit() 最终退出） */
  private quitting = false;
  private readonly options: WindowManagerOptions;
  private readonly logger: RuntimeLogger;

  constructor(options: WindowManagerOptions) {
    this.options = options;
    this.logger = options.logger ?? NOOP_LOGGER;
  }

  /** 创建主窗口 + 占位页（starting），并订阅状态 */
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
        // 注意：webPreferences 不挂 preload（preload 挂载由 session.setPreloads 按加载目标控制）
      },
    });
    this.win = win;
    win.once('ready-to-show', () => win.show());
    win.on('close', (e) => {
      if (this.quitting) return; // 退出编排中：放行默认关闭（app.quit() 收尾）
      if (this.options.isCloseToQuit()) {
        this.options.onCloseToQuit(); // 放行默认关闭，退出编排由 main 执行
        return;
      }
      e.preventDefault();
      win.hide(); // T1-06：关闭隐藏到托盘，dsh 继续跑
    });
    win.webContents.on('did-fail-load', (_e, errorCode, errorDescription) => {
      this.officialLoading = false; // 🟢-5：加载失败不算 did-finish-load，防 t4 误记
      if (errorCode === -3) return; // ERR_ABORTED（导航竞态），非真实失败
      this.loadPlaceholder('failed', `页面加载失败 (${errorCode} ${errorDescription})`);
    });
    win.webContents.on('did-finish-load', () => {
      if (this.officialLoading) {
        this.logger.info('[timing] t4 did-finish-load');
        this.officialLoading = false;
      }
    });
    this.options.runtime.on('status', (s) => this.onStatus(s));
    this.loadPlaceholder('starting', '');
    return win;
  }

  /** 状态订阅：标题 + 目标页面切换 */
  private onStatus(s: RuntimeSnapshot): void {
    if (!this.win || this.win.isDestroyed()) return;
    this.win.setTitle(`Hull — ${s.phase}`);
    if (s.phase === RuntimePhase.Ready && s.url) {
      this.loadOfficialUrl(s.url);
    } else if (s.phase === RuntimePhase.Failed) {
      this.loadPlaceholder('failed', s.message);
    }
  }

  /** 官方 UI（零注入）：清空 session preload 后 loadURL 就绪行 URL（语义固化） */
  loadOfficialUrl(url: string): void {
    const win = this.win;
    if (!win || win.isDestroyed()) return;
    win.webContents.session.setPreloads([]); // CON-R001：官方 UI 不挂 preload
    this.officialLoading = true;
    void win.loadURL(url).catch((err) => {
      this.logger.warn(`官方 UI 加载失败: ${(err as Error).message}`);
    });
  }

  /** 占位页（唯一挂 preload 的加载目标） */
  showPlaceholder(mode: PlaceholderMode, message: string): void {
    this.loadPlaceholder(mode, message);
  }

  private loadPlaceholder(mode: PlaceholderMode, message: string): void {
    const win = this.win;
    if (!win || win.isDestroyed()) return;
    win.webContents.session.setPreloads([PRELOAD_PATH]);
    const qs = new URLSearchParams({ mode, message });
    void win.loadURL(`file://${PLACEHOLDER_HTML}?${qs}`).catch(() => {
      /* 占位页加载失败无更好降级，忽略 */
    });
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
