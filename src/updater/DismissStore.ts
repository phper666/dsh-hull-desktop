import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { NOOP_LOGGER, type RuntimeLogger } from '../shared/types';

export interface DismissStoreOptions {
  /** Electron userData 目录（dismiss.json 落点） */
  userDataPath: string;
  logger?: RuntimeLogger;
}

/** 分通道（S5 双键：dsh / hull） */
export type DismissChannel = 'dsh' | 'hull';

/** 本地日期 YYYY-MM-DD（dismiss 语义 = 本地日期） */
export function localDate(d: Date): string {
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${m}-${day}`;
}

/**
 * 「稍后再说」当日不重复（S3 D9 + S5 B7/D8b 双键改造）：
 * <userData>/dismiss.json 双键 { dsh?, hull? }；temp+rename 原子写；
 * 缺失/损坏 → false（不覆盖原文件）；旧单键 { date } 读兼容视作 dsh 侧（隔离旧数据，Hull 不受污染）；
 * 写失败无害降级（当日不去重，与读损坏降级对称）。
 */
export class DismissStore {
  private readonly filePath: string;
  private readonly logger: RuntimeLogger;

  constructor(options: DismissStoreOptions) {
    this.filePath = join(options.userDataPath, 'dismiss.json');
    this.logger = options.logger ?? NOOP_LOGGER;
  }

  /** 记录指定通道今日已 dismiss（原子写；写失败无害降级） */
  dismissToday(channel: DismissChannel): void {
    try {
      const current = this.readAll();
      const next = { ...current, [channel]: localDate(new Date()) };
      const tmp = `${this.filePath}.tmp`;
      writeFileSync(tmp, JSON.stringify(next), 'utf8');
      renameSync(tmp, this.filePath);
    } catch (err) {
      this.logger.warn(`dismiss.json 写入失败（当日不去重，无害降级）: ${(err as Error).message}`);
    }
  }

  /** 指定通道今日是否已 dismiss（缺失/损坏/旧日期 → false） */
  isDismissedToday(channel: DismissChannel): boolean {
    const all = this.readAll();
    const today = localDate(new Date());
    if (channel === 'hull') {
      return all.hull === today;
    }
    // dsh：新键优先；旧单键 { date } 兼容（无 channel 归属 → 视作 dsh 侧）
    return all.dsh === today || (all.dsh === undefined && all.date === today);
  }

  /** 读全部键（缺失/损坏 → 空对象，不覆盖原文件） */
  private readAll(): { dsh?: string; hull?: string; date?: string } {
    try {
      const parsed = JSON.parse(readFileSync(this.filePath, 'utf8')) as Record<string, unknown>;
      const out: { dsh?: string; hull?: string; date?: string } = {};
      if (typeof parsed.dsh === 'string') out.dsh = parsed.dsh;
      if (typeof parsed.hull === 'string') out.hull = parsed.hull;
      if (typeof parsed.date === 'string') out.date = parsed.date; // 旧单键兼容
      return out;
    } catch {
      return {};
    }
  }
}
