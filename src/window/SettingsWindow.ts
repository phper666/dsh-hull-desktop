import { BrowserWindow } from 'electron';
import { join } from 'node:path';

/**
 * 设置页静态 HTML + preload 编译产物路径。
 * dist/window/SettingsWindow.js → ../../src/renderer/settings.html
 * dist/window/SettingsWindow.js → ../preload/settings.js
 */
const SETTINGS_HTML = join(__dirname, '..', '..', 'src', 'renderer', 'settings.html');
const SETTINGS_PRELOAD = join(__dirname, '..', 'preload', 'settings.js');

export interface SettingsWindowOptions {
  /** 主窗口 getter（设置页设为其子窗口，非 modal） */
  getMainWindow?: () => BrowserWindow | null;
}

/**
 * 设置窗口（设计 D1 + B1/B2/B9）：
 * - 独立 BrowserWindow，partition: 'settings'，独立 preload
 * - 560×640，父窗口非 modal，单实例
 * - 关闭即销毁，无托盘隐藏语义
 */
export class SettingsWindow {
  private win: BrowserWindow | null = null;
  private readonly getMainWindow?: () => BrowserWindow | null;

  constructor(options?: SettingsWindowOptions) {
    this.getMainWindow = options?.getMainWindow;
  }

  show(): BrowserWindow {
    if (this.win && !this.win.isDestroyed()) {
      this.win.show();
      this.win.focus();
      if (this.win.isMinimized()) this.win.restore();
      return this.win;
    }

    const parent = this.getMainWindow ? this.getMainWindow() : null;
    const win = new BrowserWindow({
      width: 560,
      height: 640,
      title: 'Hull 设置',
      parent: parent && !parent.isDestroyed() ? parent : undefined,
      modal: false,
      resizable: false,
      useContentSize: true,
      webPreferences: {
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
        partition: 'settings',
        preload: SETTINGS_PRELOAD,
      },
    });

    win.removeMenu?.();
    this.win = win;
    void win.loadFile(SETTINGS_HTML);

    win.on('closed', () => {
      this.win = null;
    });

    return win;
  }
}
