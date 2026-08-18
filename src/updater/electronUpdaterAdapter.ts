import { autoUpdater } from 'electron-updater';

/** 更新信息（adapter 返回；releaseNotes 缺失降级为纯版本对比） */
export interface UpdateInfo {
  version: string;
  releaseNotes?: string;
}

export interface DownloadProgress {
  percent: number;
}

/** 取消令牌（最小结构；electron-updater CancellationToken 结构兼容） */
export interface UpdateCancellationToken {
  cancel(): void;
}

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
}

/** 默认实现：electron-updater autoUpdater（GitHub provider；latest-mac.yml 由 electron-builder 生成） */
export function createElectronUpdaterAdapter(options: ElectronUpdaterAdapterOptions): ElectronUpdaterAdapter {
  autoUpdater.setFeedURL({ provider: 'github', owner: options.owner, repo: options.repo });
  return {
    checkForUpdates: async () => {
      const result = await autoUpdater.checkForUpdates();
      if (!result?.updateInfo) return null;
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
        autoUpdater.on('download-progress', (p) => (cb as (p: DownloadProgress) => void)({ percent: p.percent }));
      } else if (event === 'error') {
        autoUpdater.on('error', (err) => (cb as (err: Error) => void)(err));
      }
    },
  };
}
