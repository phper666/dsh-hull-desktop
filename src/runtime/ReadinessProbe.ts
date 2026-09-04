import { Readable } from 'node:stream';
import * as http from 'node:http';

import { READY_LINE_RE, cleanLine } from './spawnArgs';

/** 探测固定窗口 ms（设计 D5：15s 为常量，不注入配置） */
export const PROBE_WINDOW_MS = 15_000;
/** 探测间隔默认 ms */
export const PROBE_INTERVAL_MS = 500;
/** 就绪行预算默认 ms（契约：60s，可注入） */
/** 就绪行超时默认（设计 D5：60s）。
 *  ⚠️ 180s（Windows 实测 2026-08-31）：dsh 0.1.1-rc.2 Windows 冷启动受 Defender 逐文件扫描拖慢
 *  可超 60s，且 ready 行之前 stdout 零输出（dsh.log 空）——60s 判失败过早，dsh 其实正在起 */
export const READY_LINE_TIMEOUT_DEFAULT_MS = 180_000;
/** 单行长度上限（防畸形输出撑爆内存；保留尾部，不吞后续行） */
export const MAX_LINE_BYTES = 8 * 1024;
/** 单次探测超时 ms（防请求挂起吃掉整个窗口） */
export const PROBE_ATTEMPT_TIMEOUT_MS = 2_000;

export type ProbeFailureReason = 'ready-line-timeout' | 'probe-window-exhausted' | 'streams-ended';

export interface ProbeResult {
  ok: boolean;
  /** 就绪行提取的 URL（恒为就绪行 URL；注入目标仅作用探测，语义固化见契约 §就绪行协议） */
  url: string | null;
  /** ok=false 时的失败原因 */
  reason?: ProbeFailureReason;
}

export type HttpGetFn = (url: string) => Promise<{ status: number }>;

export interface ReadinessProbeOptions {
  /** 探测目标；缺省用就绪行 URL；env HULL_PROBE_TARGET 可注入（仅作用探测） */
  target?: string;
  /** 就绪行预算 ms；缺省 env HULL_READY_TIMEOUT_MS 或 60_000（与探测 15s 窗口分离） */
  readyTimeoutMs?: number;
  /** 探测间隔 ms；缺省 500 */
  intervalMs?: number;
  /** HTTP GET 实现（测试注入） */
  httpGet?: HttpGetFn;
  /** 时钟（测试注入；探测窗口预算据此计算） */
  now?: () => number;
  /** 休眠（测试注入） */
  sleep?: (ms: number) => Promise<void>;
  /** 就绪行命中回调（计时埋点 t2 数据源） */
  onReadyLine?: (url: string, elapsedMs: number) => void;
}

/** 默认 HTTP GET：node http 模块；200 即通过；网络错误 reject（ECONNREFUSED/ETIMEDOUT/ECONNRESET） */
function realHttpGet(url: string): Promise<{ status: number }> {
  return new Promise((resolve, reject) => {
    const req = http.get(url, { timeout: PROBE_ATTEMPT_TIMEOUT_MS, agent: false }, (res) => {
      res.resume(); // body 不需用，释放连接
      resolve({ status: res.statusCode ?? 0 });
    });
    req.on('timeout', () => req.destroy(new Error('probe attempt timed out')));
    req.on('error', reject);
  });
}

/**
 * 每流行缓冲解析器：chunk 拼接 + split('\n') + 残留续接（半行重组）；
 * 单行超 8KB 截断（保留尾部，防畸形输出吞掉后续就绪行）。
 */
function createLineParser(onLine: (line: string) => void): { feed(chunk: Buffer | string): void; flush(): void } {
  let residue = '';
  const feed = (chunk: Buffer | string) => {
    residue += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    if (residue.length > MAX_LINE_BYTES) residue = residue.slice(-MAX_LINE_BYTES);
    let idx = residue.indexOf('\n');
    while (idx !== -1) {
      const line = residue.slice(0, idx);
      residue = residue.slice(idx + 1);
      if (residue.length > MAX_LINE_BYTES) residue = residue.slice(-MAX_LINE_BYTES);
      onLine(line);
      idx = residue.indexOf('\n');
    }
  };
  const flush = () => {
    if (residue.length > 0) {
      const last = residue;
      residue = '';
      onLine(last);
    }
  };
  return { feed, flush };
}

/**
 * 复合探测器（契约 #5 / 设计 D5）：
 * - 双流（stdout/stderr）行缓冲解析就绪行，任一命中即提取 URL（60s 预算独立）
 * - 就绪行出现后对目标周期探测：固定 15s 窗口、间隔 500ms、网络错误继续重试、窗口耗尽 → failed
 */
export class ReadinessProbe {
  private readonly readyTimeoutMs: number;
  private readonly target: string | undefined;
  private readonly intervalMs: number;
  private readonly httpGet: HttpGetFn;
  private readonly now: () => number;
  private readonly sleepImpl: (ms: number) => Promise<void>;
  private readonly onReadyLine: ((url: string, elapsedMs: number) => void) | undefined;
  private inflight: Promise<ProbeResult> | null = null;

  constructor(opts: ReadinessProbeOptions = {}) {
    const envTimeout = Number(process.env.HULL_READY_TIMEOUT_MS);
    this.readyTimeoutMs =
      opts.readyTimeoutMs ?? (Number.isFinite(envTimeout) && envTimeout > 0 ? envTimeout : READY_LINE_TIMEOUT_DEFAULT_MS);
    this.target = opts.target ?? process.env.HULL_PROBE_TARGET ?? undefined;
    this.intervalMs = opts.intervalMs ?? PROBE_INTERVAL_MS;
    this.httpGet = opts.httpGet ?? realHttpGet;
    this.now = opts.now ?? Date.now;
    this.sleepImpl = opts.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
    this.onReadyLine = opts.onReadyLine;
  }

  /** 双流就绪判定（幂等：并发重复调用返回同一 Promise） */
  probe(stdout: NodeJS.ReadableStream, stderr: NodeJS.ReadableStream): Promise<ProbeResult> {
    if (this.inflight) return this.inflight;
    this.inflight = this.runProbe(stdout, stderr);
    return this.inflight;
  }

  private runProbe(stdout: NodeJS.ReadableStream, stderr: NodeJS.ReadableStream): Promise<ProbeResult> {
    return new Promise<ProbeResult>((resolve) => {
      const startedAt = this.now();
      let url: string | null = null;
      let finished = false;
      let endedStreams = 0;
      let readyTimer: NodeJS.Timeout | undefined;
      const cleanupFns: Array<() => void> = [];

      const finish = (result: ProbeResult) => {
        if (finished) return;
        finished = true;
        if (readyTimer) clearTimeout(readyTimer);
        for (const fn of cleanupFns) fn();
        resolve(result);
      };

      const streamEnded = () => {
        endedStreams += 1;
        if (endedStreams >= 2 && url === null) finish({ ok: false, url: null, reason: 'streams-ended' });
      };

      const onLine = (line: string) => {
        if (url !== null) return;
        const m = READY_LINE_RE.exec(cleanLine(line));
        if (m) {
          url = m[1];
          // 🟡-2：就绪行命中即停掉就绪预算定时器——此后成败只由探测窗口 deadline 把控，
          // 防止慢就绪场景（就绪行接近 60s 预算才出现）定时器抢答 ready-line-timeout
          if (readyTimer) {
            clearTimeout(readyTimer);
            readyTimer = undefined;
          }
          if (this.onReadyLine) this.onReadyLine(url, this.now() - startedAt);
          void this.probeWindow(url, finish);
        }
      };

      const attach = (stream: NodeJS.ReadableStream) => {
        const parser = createLineParser(onLine);
        const onData = (chunk: Buffer | string) => parser.feed(chunk);
        const onEnd = () => {
          parser.flush(); // 流结束残留半行也判定
          streamEnded();
        };
        stream.on('data', onData);
        stream.on('end', onEnd);
        stream.on('error', onEnd);
        cleanupFns.push(() => {
          stream.removeListener('data', onData);
          stream.removeListener('end', onEnd);
          stream.removeListener('error', onEnd);
        });
      };

      readyTimer = setTimeout(() => finish({ ok: false, url: null, reason: 'ready-line-timeout' }), this.readyTimeoutMs);
      attach(stdout);
      attach(stderr);
    });
  }

  /** 探测：固定 15s 窗口周期重试；网络错误继续重试；窗口耗尽 → failed */
  private async probeWindow(url: string, finish: (r: ProbeResult) => void): Promise<void> {
    const target = this.target ?? url; // 语义固化：注入目标仅作用探测
    const deadline = this.now() + PROBE_WINDOW_MS;
    while (this.now() < deadline) {
      try {
        const res = await this.httpGet(target);
        // 2xx/3xx 均判就绪：dsh 0.1.2+ 带 ?token 首访返回 303（发 session cookie 后重定向），
        // 3xx = server 已就绪且鉴权通过；4xx（401 裸 URL）仍视为未就绪
        if (res.status >= 200 && res.status < 400) {
          finish({ ok: true, url });
          return;
        }
        // 非 2xx/3xx：服务仍在启动，继续重试
      } catch {
        // ECONNREFUSED / ETIMEDOUT / ECONNRESET 等网络错误 → 继续重试至窗口耗尽
      }
      await this.sleepImpl(this.intervalMs);
    }
    finish({ ok: false, url, reason: 'probe-window-exhausted' });
  }
}
