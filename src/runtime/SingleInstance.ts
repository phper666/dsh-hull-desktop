import { app } from 'electron';

/** 单实例锁结果（设计 D4 / 契约 #6） */
export interface SingleInstanceResult {
  /** true = 本实例获得锁；false = 已有实例在跑，应 app.quit() */
  ok: boolean;
  /** 第二实例唤醒回调（T1-03：show + focus + restore） */
  onSecondInstance(cb: () => void): void;
}

/**
 * 单实例锁（Electron 原生 requestSingleInstanceLock）。
 * 必须在 app ready 之前调用（启动流程第 1 步）。
 */
export function acquireSingleInstanceLock(): SingleInstanceResult {
  const ok = app.requestSingleInstanceLock();
  if (!ok) return { ok: false, onSecondInstance() {} };
  return {
    ok: true,
    onSecondInstance(cb) {
      app.on('second-instance', () => cb());
    },
  };
}
