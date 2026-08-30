/**
 * Token 消耗 IPC（tokens:getUsage）：扫描全部平台源 → 粒度聚合摘要。
 * 注册（main）：registerTokenUsageIpc()；渲染层走 window.tokens.getUsage(granularity)。
 */
import { ipcMain } from 'electron';

import { scanAllSources } from './TokenUsageScanner';
import { summarize } from './aggregator';
import { USAGE_GRANULARITIES, type UsageGranularity, type UsageSummary } from './types';

export function registerTokenUsageIpc(): void {
  ipcMain.handle('tokens:getUsage', (_e, granularity: unknown) => {
    try {
      const g: UsageGranularity = USAGE_GRANULARITIES.includes(granularity as UsageGranularity)
        ? (granularity as UsageGranularity)
        : 'day';
      const { records, sources } = scanAllSources();
      const summary: UsageSummary = summarize(records, g, sources);
      return { ok: true, data: summary };
    } catch (err) {
      return { ok: false, message: (err as Error).message };
    }
  });
}
