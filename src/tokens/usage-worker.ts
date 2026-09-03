/**
 * Token 消耗扫描 worker（worker_threads 入口）：把 loadOrScan（可能的 11s 全量扫描）+ summarize 挪出主进程。
 * 入参（workerData）：{ cachePath, g, custom }；出参（postMessage）：{ ok, data?, fromCache?, message? }，与 IPC 响应形状一致。
 */
import { parentPort, workerData } from 'node:worker_threads';

import { platformSources } from './TokenUsageScanner';
import { loadOrScan } from './usage-cache';
import { summarize, type ScanSourceInfo } from './aggregator';
import type { CustomRange, PlatformSource, UsageGranularity, UsageSummary } from './types';

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

export interface UsageWorkerRequest {
  cachePath: string;
  g: UsageGranularity;
  custom?: CustomRange;
}

export type UsageWorkerResponse =
  | { ok: true; data: UsageSummary; fromCache: boolean }
  | { ok: false; message: string };

function run(): UsageWorkerResponse {
  const { cachePath, g, custom } = workerData as UsageWorkerRequest;
  const sources = platformSources();
  const { records, fromCache } = loadOrScan(cachePath, sources);
  const summary: UsageSummary = summarize(records, g, sourceInfos(sources), undefined, custom);
  return { ok: true, data: summary, fromCache };
}

if (parentPort) {
  let response: UsageWorkerResponse;
  try {
    response = run();
  } catch (err) {
    response = { ok: false, message: (err as Error).message };
  }
  parentPort.postMessage(response);
}
