import { autoUpdater } from 'electron-updater';
import { CancellationToken } from 'builder-util-runtime';

import { type RuntimeLogger } from '../shared/types';

/** 更新信息（adapter 返回；releaseNotes 缺失降级为纯版本对比） */
export interface UpdateInfo {
  version: string;
  releaseNotes?: string;
}

export interface DownloadProgress {
  percent: number;
  /** 已下载字节 */
  transferred: number;
  /** 总字节（未知 = 0） */
  total: number;
  /** 下载速度 字节/秒 */
  bytesPerSecond: number;
}

/** 取消令牌 = builder-util-runtime 真实 CancellationToken（electron-updater 需要 createPromise/cancelled/onCancel，最小接口会报错） */
export type UpdateCancellationToken = CancellationToken;

/**
 * electron-updater 抽象（S5 设计 D2 DI 注入点）：
 * 单测 mock，不真调 electron-updater（需打包环境）；默认实现封装 autoUpdater（GitHub provider）。
 */
export interface ElectronUpdaterAdapter {
  checkForUpdates(): Promise<UpdateInfo | null>;
  downloadUpdate(cancellationToken?: UpdateCancellationToken): Promise<void>;
  quitAndInstall(): void;
  on(event: 'download-progress', cb: (p: DownloadProgress) => void): void;
  on(event: 'error', cb: (err: Error) => void): void;
}

export interface ElectronUpdaterAdapterOptions {
  /** GitHub owner（package.json repository 或注入） */
  owner: string;
  /** GitHub repo */
  repo: string;
  /** 接入后 electron-updater 内部日志（检查/下载/差分回退/Squirrel 错误）落 hull.log；缺省 console（打包环境不可见） */
  logger?: RuntimeLogger;
}

/** 默认实现：electron-updater autoUpdater（GitHub provider；latest-mac.yml 由 electron-builder 生成）
 *  HULL_UPDATE_FEED_URL 覆盖为 generic provider（本地/自定义更新源测试，如本地 mock 服务器） */
export function createElectronUpdaterAdapter(options: ElectronUpdaterAdapterOptions): ElectronUpdaterAdapter {
  if (options.logger) {
    // 观测性（v0.1.6→0.1.7 实测教训）：差分失败静默回退全量、Squirrel 安装错误都在内部日志里，
    // 不接则 hull.log 只有 error 事件级一条，用户看到"下载完又重新下载"但日志无因。
    // electron-updater 消息可能是对象（builder-util Logger 契约），统一字符串化。
    const fmt = (m: unknown): string => (typeof m === 'string' ? m : JSON.stringify(m));
    const hullLogger = options.logger;
    autoUpdater.logger = {
      debug: (m) => hullLogger.info(`[electron-updater] ${fmt(m)}`),
      info: (m) => hullLogger.info(`[electron-updater] ${fmt(m)}`),
      warn: (m) => hullLogger.warn(`[electron-updater] ${fmt(m)}`),
      error: (m) => hullLogger.error(`[electron-updater] ${fmt(m)}`),
    };
  }
  if (process.env.HULL_UPDATE_FEED_URL) {
    // dev（unpacked）模式 electron-updater 默认跳过更新检查——forceDevUpdateConfig 放行（仅测试/本地 mock 源用）
    autoUpdater.forceDevUpdateConfig = true;
    autoUpdater.setFeedURL({ provider: 'generic', url: process.env.HULL_UPDATE_FEED_URL });
  } else {
    autoUpdater.setFeedURL({ provider: 'github', owner: options.owner, repo: options.repo });
  }
  return {
    checkForUpdates: async () => {
      const result = await autoUpdater.checkForUpdates();
      // ⚠️ 必须检查 isUpdateAvailable：electron-updater 同版本时也返回 updateInfo（isUpdateAvailable=false），
      // 只查 updateInfo 会导致同版本误报"发现新版本"（如 0.1.0 显示有 0.1.0 更新）
      if (!result?.isUpdateAvailable || !result?.updateInfo) return null;
      return {
        version: result.updateInfo.version,
        releaseNotes: result.updateInfo.releaseNotes as string | undefined,
      };
    },
    downloadUpdate: async (cancellationToken) => {
      // electron-updater CancellationToken 结构兼容（最小接口透传）
      await autoUpdater.downloadUpdate(cancellationToken as never);
    },
    quitAndInstall: () => {
      autoUpdater.quitAndInstall();
    },
    on: (event: string, cb: (arg: any) => void) => {
      if (event === 'download-progress') {
        // 透传全量进度字段（percent + transferred/total/bytesPerSecond——UI 详情展示数据源）
        autoUpdater.on('download-progress', (p) =>
          (cb as (p: DownloadProgress) => void)({
            percent: p.percent,
            transferred: p.transferred,
            total: p.total,
            bytesPerSecond: p.bytesPerSecond,
          })
        );
      } else if (event === 'error') {
        autoUpdater.on('error', (err) => (cb as (err: Error) => void)(err));
      }
    },
  };
}
