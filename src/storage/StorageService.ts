import { promises as fsPromises, type Dirent } from 'node:fs';
import { join, resolve, sep } from 'node:path';

import { NOOP_LOGGER, type RuntimeLogger } from '../shared/types';

/**
 * 存储占用统计 + 白名单清理（设置页「存储」区块）：
 * - 只读尺寸：递归算字节（异步，目录不存在 = 0，不报错）
 * - 清理只允许白名单 id，路径必须位于 userData 下（resolve 后 startsWith，防注入）
 * - dsh-previous 清理会让壳失去回滚能力 → clearable 由 OverlayManager.canRollback 决定
 */

export type StorageEntryId = 'chromium-cache' | 'logs' | 'dsh-previous';

export interface StorageEntry {
  id: StorageEntryId;
  label: string;
  paths: string[];
  bytes: number;
  clearable: boolean;
  note?: string;
}

export interface StorageInfo {
  totalBytes: number;
  clearableBytes: number;
  entries: StorageEntry[];
}

/** 清理 id 白名单（IPC 入参校验同源，防渲染层传任意 id） */
export const STORAGE_ENTRY_IDS: readonly StorageEntryId[] = ['chromium-cache', 'logs', 'dsh-previous'];

/** Chromium 缓存子目录（清理走 session.clearCache/clearCodeCaches，路径仅用于尺寸统计） */
const CHROMIUM_CACHE_DIRS = ['Cache', 'Code Cache', 'GPUCache', 'DawnGraphiteCache', 'DawnWebGPUCache'];

/** 注入用最小 fs 面（测试替换；默认 node:fs/promises） */
export interface StorageFs {
  readdir(path: string, opts: { withFileTypes: true }): Promise<Dirent[]>;
  stat(path: string): Promise<{ size: number }>;
  rm(path: string, opts: { recursive: boolean; force: boolean }): Promise<void>;
}

export interface StorageServiceDeps {
  /** Electron userData 目录（所有条目根；清理路径越界拒绝） */
  userDataPath: string;
  logger?: RuntimeLogger;
  /** fs 注入（默认 node:fs/promises；测试传 fake） */
  fsImpl?: StorageFs;
  /** 回滚能力（OverlayManager.canRollback；false → dsh-previous 不可清理） */
  canRollback?: () => boolean;
  /** Chromium 缓存清理（main 注入 session.defaultSession.clearCache + clearCodeCaches） */
  clearChromium?: () => Promise<void>;
}

export class StorageService {
  private readonly userDataPath: string;
  private readonly logger: RuntimeLogger;
  private readonly fs: StorageFs;
  private readonly canRollback: () => boolean;
  private readonly clearChromium: () => Promise<void>;

  constructor(deps: StorageServiceDeps) {
    this.userDataPath = deps.userDataPath;
    this.logger = deps.logger ?? NOOP_LOGGER;
    this.fs = deps.fsImpl ?? (fsPromises as unknown as StorageFs);
    this.canRollback = deps.canRollback ?? (() => false);
    this.clearChromium = deps.clearChromium ?? (async () => {});
  }

  /** 当前占用（每次实时测量，不缓存） */
  async info(): Promise<StorageInfo> {
    const rollbackable = this.canRollback();
    const entries: StorageEntry[] = [
      {
        id: 'chromium-cache',
        label: '网页缓存',
        paths: CHROMIUM_CACHE_DIRS.map((dir) => join(this.userDataPath, dir)),
        bytes: 0,
        clearable: true,
      },
      {
        id: 'logs',
        label: '运行日志',
        paths: [join(this.userDataPath, 'logs')],
        bytes: 0,
        clearable: true,
      },
      {
        id: 'dsh-previous',
        label: '上一版 dsh（回滚备份）',
        paths: [join(this.userDataPath, 'dsh-previous')],
        bytes: 0,
        clearable: rollbackable,
        note: '清理后无法回滚到上一版 dsh',
      },
    ];
    for (const entry of entries) {
      for (const path of entry.paths) entry.bytes += await this.measure(path);
    }
    return {
      totalBytes: entries.reduce((sum, entry) => sum + entry.bytes, 0),
      clearableBytes: entries.reduce((sum, entry) => (entry.clearable ? sum + entry.bytes : sum), 0),
      entries,
    };
  }

  /** 清理指定条目（白名单外的 id 记入 skipped；不可清理/失败同样 skipped） */
  async clear(ids: StorageEntryId[]): Promise<{ freedBytes: number; info: StorageInfo; skipped: string[] }> {
    const before = await this.info();
    const targets = new Set<StorageEntryId>();
    const skipped: string[] = [];
    for (const id of ids) {
      if (!STORAGE_ENTRY_IDS.includes(id)) {
        skipped.push(String(id));
        continue;
      }
      targets.add(id);
    }
    for (const entry of before.entries) {
      if (!targets.has(entry.id)) continue;
      if (!entry.clearable) {
        skipped.push(entry.id);
        continue;
      }
      try {
        if (entry.id === 'chromium-cache') {
          await this.clearChromium(); // Electron 自管目录：交给 session 清，随后重新量尺寸
        } else if (entry.id === 'logs') {
          await this.removeContents(entry.paths); // 删目录内文件，保留目录（Logger 继续写）
        } else {
          await this.removeEntry(entry.paths);
        }
      } catch (err) {
        this.logger.warn(`[storage] 清理 ${entry.id} 失败: ${(err as Error).message}`);
        skipped.push(entry.id);
      }
    }
    const info = await this.info();
    let freedBytes = 0;
    for (const entry of before.entries) {
      if (!targets.has(entry.id)) continue;
      const after = info.entries.find((e) => e.id === entry.id)?.bytes ?? 0;
      freedBytes += Math.max(0, entry.bytes - after);
    }
    return { freedBytes, info, skipped };
  }

  /** 递归尺寸（异步；不存在/不可读 = 0；越界路径拒绝） */
  private async measure(target: string): Promise<number> {
    if (!this.isInside(target)) return 0;
    let entries: Dirent[];
    try {
      entries = await this.fs.readdir(target, { withFileTypes: true });
    } catch {
      return 0; // 目录不存在（未生成缓存/日志）
    }
    let total = 0;
    for (const entry of entries) {
      const child = join(target, entry.name);
      if (entry.isDirectory()) {
        total += await this.measure(child);
      } else if (entry.isFile() && this.isInside(child)) {
        try {
          total += (await this.fs.stat(child)).size;
        } catch {
          /* 竞态删除 */
        }
      }
    }
    return total;
  }

  private async removeContents(paths: string[]): Promise<void> {
    for (const target of paths) {
      if (!this.isInside(target)) continue;
      let entries: Dirent[];
      try {
        entries = await this.fs.readdir(target, { withFileTypes: true });
      } catch {
        continue; // 目录不存在
      }
      for (const entry of entries) {
        const child = join(target, entry.name);
        if (!this.isInside(child)) continue;
        await this.fs.rm(child, { recursive: true, force: true });
      }
    }
  }

  private async removeEntry(paths: string[]): Promise<void> {
    for (const target of paths) {
      if (!this.isInside(target)) continue;
      await this.fs.rm(target, { recursive: true, force: true });
    }
  }

  /** 路径必须位于 userData 下（resolve 后比较，防 ../ 注入） */
  private isInside(target: string): boolean {
    const root = resolve(this.userDataPath);
    const path = resolve(target);
    return path === root || path.startsWith(root + sep);
  }
}
