/**
 * Token 消耗 IPC（tokens:getUsage）：参数校验在 main，扫描+聚合挪进 worker_threads（不阻塞主进程）。
 * 注册（main）：registerTokenUsageIpc()；渲染层走 window.tokens.getUsage(period, customFrom?, customTo?)。
 * 扫描入口唯一化：loadOrScan 负责全部扫描（指纹比对/重扫落盘）；worker 内只 listFiles 构造空态概况，不重扫内容。
 */
import { ipcMain, app } from 'electron';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';

import { USAGE_GRANULARITIES, type CustomRange, type UsageGranularity, type UsageSummary } from './types';

type GetUsageResult = { ok: true; data: UsageSummary; fromCache: boolean } | { ok: false; message: string };

function runUsageWorker(cachePath: string, g: UsageGranularity, custom?: CustomRange): Promise<GetUsageResult> {
  return new Promise((resolve) => {
    const worker = new Worker(join(__dirname, 'usage-worker.js'), { workerData: { cachePath, g, custom } });
    let settled = false;
    worker.once('message', (msg: GetUsageResult) => {
      settled = true;
      resolve(msg);
    });
    worker.once('error', (err) => {
      if (!settled) {
        settled = true;
        resolve({ ok: false, message: err.message });
      }
    });
    worker.once('exit', (code) => {
      if (!settled) {
        settled = true;
        resolve({ ok: false, message: `usage worker exited unexpectedly (code ${code})` });
      }
    });
  });
}

export function registerTokenUsageIpc(): void {
  ipcMain.handle('tokens:getUsage', async (_e, period: unknown, customFrom: unknown, customTo: unknown): Promise<GetUsageResult> => {
    try {
      const g: UsageGranularity = USAGE_GRANULARITIES.includes(period as UsageGranularity)
        ? (period as UsageGranularity)
        : 'day';
      const custom: CustomRange | undefined =
        g === 'custom' && typeof customFrom === 'string' && typeof customTo === 'string'
          ? { from: customFrom, to: customTo }
          : undefined;
      const cachePath = join(app.getPath('userData'), 'token-buckets.json');
      const result = await runUsageWorker(cachePath, g, custom);
      return result;
    } catch (err) {
      return { ok: false, message: (err as Error).message };
    }
  });
}
