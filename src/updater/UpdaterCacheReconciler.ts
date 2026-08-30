import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { type RuntimeLogger } from '../shared/types';

/** 下载记录文件名（Hull 自有元数据，写缓存根目录；非 electron-updater 产物） */
export const DOWNLOAD_RECORD_FILE = 'download-record.json';

export interface DownloadRecord {
  version: string;
  at: number;
}

/**
 * 下载成功时写记录（best-effort，失败仅告警）：记录本次下载的目标版本。
 * 用途见 reconcileHullUpdaterCache——electron-updater 自身不记录缓存归属版本，
 * 跨版本后无法自判缓存是否还能做差分基。
 */
export function writeDownloadRecord(cacheDir: string | null | undefined, version: string | null, logger: RuntimeLogger): void {
  if (!cacheDir || !version) return;
  try {
    const record: DownloadRecord = { version, at: Date.now() };
    writeFileSync(join(cacheDir, DOWNLOAD_RECORD_FILE), JSON.stringify(record));
  } catch (err) {
    logger.warn(`[hull-updater] 写下载记录失败（忽略）: ${(err as Error).message}`);
  }
}

/**
 * 更新缓存对账（启动后首次 check 执行一次，HullUpdater 调用）：
 * electron-updater 假设缓存根的 update.zip/current.blockmap 与运行中版本同源
 * （作为下次差分下载的基文件），但它的下载/安装失败或用户手动重装跨版本后
 * 缓存即失配 → 差分装配必然 sha512 不中 → 静默回退全量下载（用户看到进度条
 * 假回退"下载完又重新下载"，v0.1.6→0.1.7 实测）。
 *
 * 对账规则：下载记录版本 == 运行版本 → 缓存是合法差分基，保留；
 * 记录缺失/损坏/不一致 → 清 update.zip + current.blockmap（下次走一次全量重建缓存）。
 * pending/ 不动：electron-updater 以 update-info.json + sha512 自校验，误清反而丢断点续传。
 */
export function reconcileHullUpdaterCache(opts: { cacheDir?: string | null; currentVersion: string; logger: RuntimeLogger }): void {
  const { cacheDir, currentVersion, logger } = opts;
  if (!cacheDir) return;
  const zipPath = join(cacheDir, 'update.zip');
  const blockmapPath = join(cacheDir, 'current.blockmap');
  if (!existsSync(zipPath) && !existsSync(blockmapPath)) return; // 无差分基，无需对账
  let recordedVersion: string | null = null;
  try {
    const raw = JSON.parse(readFileSync(join(cacheDir, DOWNLOAD_RECORD_FILE), 'utf8')) as Partial<DownloadRecord>;
    recordedVersion = typeof raw?.version === 'string' ? raw.version : null;
  } catch {
    recordedVersion = null; // 无记录/损坏 = 无法证明同源 → 按失配处理
  }
  if (recordedVersion === currentVersion) return; // 同源，保留差分基
  try {
    rmSync(zipPath, { force: true });
    rmSync(blockmapPath, { force: true });
    logger.info(
      `[hull-updater] 更新缓存与运行版本不同源（记录: ${recordedVersion ?? '无'} / 运行: ${currentVersion}），已清差分基 update.zip/current.blockmap——防差分失败假回退`
    );
  } catch (err) {
    logger.warn(`[hull-updater] 清理更新缓存失败（忽略）: ${(err as Error).message}`);
  }
}
