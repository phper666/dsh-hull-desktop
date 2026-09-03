/**
 * Token 消耗 IPC（tokens:getUsage）：桶缓存命中（免全量扫描）→ 范围窗口聚合摘要。
 * 注册（main）：registerTokenUsageIpc()；渲染层走 window.tokens.getUsage(period, customFrom?, customTo?)。
 * 扫描入口唯一化：loadOrScan 负责全部扫描（指纹比对/重扫落盘）；IPC 层只 listFiles 构造空态概况，不重扫内容。
 */
import { app, ipcMain } from 'electron';
import { join } from 'node:path';

import { platformSources } from './TokenUsageScanner';
import { loadOrScan } from './usage-cache';
import { summarize, type ScanSourceInfo } from './aggregator';
import { USAGE_GRANULARITIES, type CustomRange, type UsageGranularity, type UsageSummary } from './types';
import type { PlatformSource } from './types';

/** 扫描概况（空态指引用）：仅 listFiles 计数 + home，不重扫内容（内容扫描由 loadOrScan 负责） */
function sourceInfos(sources: PlatformSource[]): ScanSourceInfo[] {
  return sources.map((src) => {
    const info: ScanSourceInfo = { platform: src.platform, home: src.home, files: 0, records: 0 };
    try {
      info.files = src.listFiles().length;
    } catch (err) {
      info.error = (err as Error).message;
    }
    return info;
  });
}

export function registerTokenUsageIpc(): void {
  ipcMain.handle('tokens:getUsage', (_e, period: unknown, customFrom: unknown, customTo: unknown) => {
    try {
      const g: UsageGranularity = USAGE_GRANULARITIES.includes(period as UsageGranularity)
        ? (period as UsageGranularity)
        : 'day';
      const custom: CustomRange | undefined =
        g === 'custom' && typeof customFrom === 'string' && typeof customTo === 'string'
          ? { from: customFrom, to: customTo }
          : undefined;
      const sources = platformSources();
      const cachePath = join(app.getPath('userData'), 'token-buckets.json');
      const { records, fromCache } = loadOrScan(cachePath, sources);
      const summary: UsageSummary = summarize(records, g, sourceInfos(sources), undefined, custom);
      return { ok: true, data: summary, fromCache };
    } catch (err) {
      return { ok: false, message: (err as Error).message };
    }
  });
}
