import { appendFileSync, existsSync, mkdirSync, renameSync, statSync } from 'node:fs';
import { join } from 'node:path';

import type { RuntimeLogger } from '../shared/types';

/** 单文件轮转阈值默认（设计 §5.1 日志规范：1MB） */
export const DEFAULT_MAX_BYTES = 1024 * 1024;
/** 轮转备份数默认（.1/.2/.3） */
export const DEFAULT_KEEP_COUNT = 3;

export interface LoggerOptions {
  /** 日志目录（<userData>/logs；路径注入便于测试） */
  logDir: string;
  /** 单文件轮转阈值字节（默认 1MB；测试注入小阈值） */
  maxBytes?: number;
  /** 轮转备份数（默认 3 → .1/.2/.3） */
  keepCount?: number;
}

/**
 * 壳日志（设计 §3 / §5.1）：
 * - hull.log 追加 + dsh.log 追加（FR-8 子进程输出落盘，带 [dsh pid=<pid>] 前缀）
 * - 单文件轮转（改进：dsh-<pid>.log → dsh.log 统一单文件，与 hull.log 同规约，不再每 spawn 一个文件）
 * - size 轮转：写前检查当前文件大小，超限 → .1/.2/.3（旧→新移位）
 * - 初始化/写入失败降级：console.warn 告警，不抛不阻塞启动
 */
export class Logger implements RuntimeLogger {
  private readonly logDir: string;
  private readonly maxBytes: number;
  private readonly keepCount: number;
  private readonly hullPath: string;
  private readonly dshPath: string;
  private degraded = false;

  constructor(options: LoggerOptions) {
    this.logDir = options.logDir;
    this.maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
    this.keepCount = options.keepCount ?? DEFAULT_KEEP_COUNT;
    this.hullPath = join(this.logDir, 'hull.log');
    this.dshPath = join(this.logDir, 'dsh.log');
    try {
      mkdirSync(this.logDir, { recursive: true });
    } catch (err) {
      this.degraded = true;
      console.warn(`[hull] 日志目录初始化失败，降级 console: ${(err as Error).message}`);
    }
  }

  info(message: string): void {
    this.append('info', message);
  }

  warn(message: string): void {
    this.append('warn', message);
  }

  error(message: string): void {
    this.append('error', message);
  }

  /** dsh 子进程输出落盘（FR-8）：统一写 dsh.log（带时间戳 + [dsh pid=<pid>] 前缀——与 hull.log 格式一致，
   *  否则 pkgmgr 逐包输出无时间轴无法排查安装慢/卡包；同一轮转规则。旧 dsh-<pid>.log 不再创建，历史文件不删） */
  dshLog(pid: number, line: string): void {
    const text = line.endsWith('\n') ? line : `${line}\n`;
    this.appendTo(this.dshPath, `[${Logger.formatTime(new Date())}] [dsh pid=${pid}] ${text}`);
  }

  /** 上海时区标准时间戳（YYYY-MM-DD HH:mm:ss.SSS，Asia/Shanghai）——不用 toISOString（UTC Z 后缀非本地可读） */
  private static formatTime(d: Date): string {
    const pad = (n: number, w = 2): string => String(n).padStart(w, '0');
    const p = new Intl.DateTimeFormat('zh-CN', {
      timeZone: 'Asia/Shanghai',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    }).formatToParts(d);
    const get = (t: Intl.DateTimeFormatPartTypes): string => p.find((x) => x.type === t)?.value ?? '00';
    // 毫秒用本地毫秒（formatToParts 无 ms；上海 = UTC+8，用 getTime+8h 的 ms 等价本地 ms）
    const ms = pad(d.getTime() % 1000, 3);
    return `${get('year')}-${get('month')}-${get('day')} ${get('hour')}:${get('minute')}:${get('second')}.${ms}`;
  }

  private append(level: string, message: string): void {
    this.appendTo(this.hullPath, `[${Logger.formatTime(new Date())}] [${level}] ${message}\n`);
  }

  private appendTo(basePath: string, text: string): void {
    if (this.degraded) {
      console.warn(`[hull] ${text.trimEnd()}`);
      return;
    }
    try {
      const size = existsSync(basePath) ? statSync(basePath).size : 0;
      if (size > this.maxBytes) this.rotate(basePath);
      appendFileSync(basePath, text);
    } catch (err) {
      this.degraded = true;
      console.warn(`[hull] 日志写入失败，降级 console: ${(err as Error).message}`);
    }
  }

  /** 轮转：.2→.3、.1→.2、base→.1（keepCount 个备份，旧文件被覆盖丢弃） */
  private rotate(basePath: string): void {
    for (let i = this.keepCount - 1; i >= 1; i--) {
      const from = `${basePath}.${i}`;
      const to = `${basePath}.${i + 1}`;
      try {
        if (existsSync(from)) renameSync(from, to);
      } catch {
        /* 轮转尽力而为，失败不阻断写入 */
      }
    }
    try {
      if (existsSync(basePath)) renameSync(basePath, `${basePath}.1`);
    } catch {
      /* 同上 */
    }
  }
}
