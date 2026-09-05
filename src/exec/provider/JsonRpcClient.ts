/**
 * JSON-RPC 2.0 over stdio 客户端（B4 design §4.1 帧契约，冻结）
 *
 * 帧编解码（对齐契约 §ACP JSON-RPC 帧契约）：
 * - 行分隔（\n）+ JSON.parse，无 Content-Length 头（契约帧契约 = 逐行 JSON）
 * - 单行上限 8KB 截断丢弃（防畸形，对齐 B1 写盘防抖口径）
 * - 请求带 id 匹配响应；通知（无 id 帧）分发 + server→client 请求（带 id 反向帧，
 *   Q-017-C 标准 ACP session/request_permission）经 onRequest 分发、sendResponse 回帧
 * - 坏 JSON 帧丢弃 + 日志，不中断后续帧
 *
 * 通道所有权：stdin/stdout 流由本客户端独占（每 ACP 子进程一个实例）；
 * dispose() 清理订阅 + reject 全部 pending。
 */
import type { RuntimeLogger } from '../../shared/types';
import { NOOP_LOGGER } from '../../shared/types';

export interface JsonRpcClientOptions {
  /** 写帧通道（子进程 stdin） */
  stdin: NodeJS.WritableStream;
  /** 读帧通道（子进程 stdout） */
  stdout: NodeJS.ReadableStream;
  /** 单行最大字节（超长截断丢弃；默认 8KB） */
  maxLineBytes?: number;
  logger?: RuntimeLogger;
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  /** 超时 timer（Q-024：timeoutMs=0 表示无超时——session/prompt 回合时长由 agent 决定） */
  timer?: NodeJS.Timeout;
}

type NotificationHandler = (params: unknown) => void;
/** Q-017-C：server→client 请求处理（标准 ACP session/request_permission 带 id 须回 response 帧） */
type ServerRequestHandler = (params: unknown, id: number) => void;

export class JsonRpcClient {
  private readonly stdin: NodeJS.WritableStream;
  private readonly stdout: NodeJS.ReadableStream;
  private readonly maxLineBytes: number;
  private readonly logger: RuntimeLogger;
  private readonly pending = new Map<number, PendingRequest>();
  private readonly handlers = new Map<string, Set<NotificationHandler>>();
  private readonly requestHandlers = new Map<string, Set<ServerRequestHandler>>();
  private nextId = 1;
  private buffer = '';
  private disposed = false;

  constructor(options: JsonRpcClientOptions) {
    this.stdin = options.stdin;
    this.stdout = options.stdout;
    this.maxLineBytes = options.maxLineBytes ?? 8192;
    this.logger = options.logger ?? NOOP_LOGGER;
    this.stdout.on('data', (chunk: Buffer | string) => this.onData(chunk));
    this.stdin.on('error', (err: Error) => this.onDisconnect(err));
  }

  /**
   * 发送请求（id 匹配响应；超时 reject）。
   * Q-024 按方法超时：timeoutMs=0 → 无超时（session/prompt 真实回合含工具调用/审批等待，
   * 时长由 agent 决定；取消走 session/cancel + cancel 句柄，壳退出/子进程退出自然终止）；
   * 快操作（initialize/new/set_config_option）保持 15-30s 预算。
   */
  sendRequest<T = unknown>(method: string, params?: unknown, timeoutMs = 30_000): Promise<T> {
    if (this.disposed) return Promise.reject(new Error('JsonRpcClient 已释放'));
    const id = this.nextId++;
    const payload = JSON.stringify({ jsonrpc: '2.0', id, method, params });
    return new Promise<T>((resolve, reject) => {
      let timer: NodeJS.Timeout | undefined;
      if (timeoutMs > 0) {
        timer = setTimeout(() => {
          this.pending.delete(id);
          reject(new Error(`JSON-RPC 请求超时: ${method}`));
        }, timeoutMs);
        timer.unref?.(); // 超时 timer 不阻塞进程退出（响应到达即 clearTimeout）
      }
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
      this.write(payload);
    });
  }

  /** 发送通知（无响应帧） */
  sendNotification(method: string, params?: unknown): void {
    if (this.disposed) return;
    this.write(JSON.stringify({ jsonrpc: '2.0', method, params }));
  }

  /**
   * Q-017-C：响应 server→client 请求帧（标准 ACP：session/request_permission 是带 id 的
   * 请求而非通知，客户端须回 {jsonrpc, id, result} 响应帧）
   */
  sendResponse(id: number, result: unknown): void {
    if (this.disposed) return;
    this.write(JSON.stringify({ jsonrpc: '2.0', id, result }));
  }

  /** 订阅通知（method 匹配分发）；返回退订函数 */
  onNotification(method: string, handler: NotificationHandler): () => void {
    let set = this.handlers.get(method);
    if (!set) {
      set = new Set();
      this.handlers.set(method, set);
    }
    set.add(handler);
    return () => {
      set.delete(handler);
    };
  }

  /** 订阅 server→client 请求（带 id 帧分发；handler 自行决定是否 sendResponse） */
  onRequest(method: string, handler: ServerRequestHandler): () => void {
    let set = this.requestHandlers.get(method);
    if (!set) {
      set = new Set();
      this.requestHandlers.set(method, set);
    }
    set.add(handler);
    return () => {
      set.delete(handler);
    };
  }

  /** 释放：清理订阅 + reject 全部 pending（err 缺省 = 常规释放） */
  dispose(err?: Error): void {
    if (this.disposed) return;
    this.disposed = true;
    this.stdout.removeAllListeners('data');
    this.stdin.removeAllListeners('error');
    const reason = err ?? new Error('JsonRpcClient 已释放');
    for (const [, p] of this.pending) {
      if (p.timer) clearTimeout(p.timer); // Q-024：无超时请求（prompt）timer 为空
      p.reject(reason);
    }
    this.pending.clear();
    this.handlers.clear();
    this.requestHandlers.clear();
  }

  private onData(chunk: Buffer | string): void {
    this.buffer += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    if (this.buffer.length > this.maxLineBytes) {
      this.logger.warn(`[jsonrpc] 单行超 ${this.maxLineBytes}B 截断丢弃`);
      this.buffer = '';
      return;
    }
    let idx: number;
    while ((idx = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, idx).trim();
      this.buffer = this.buffer.slice(idx + 1);
      if (line) this.processLine(line);
    }
  }

  private processLine(line: string): void {
    let msg: unknown;
    try {
      msg = JSON.parse(line);
    } catch {
      this.logger.warn('[jsonrpc] 坏 JSON 帧丢弃');
      return;
    }
    if (msg === null || typeof msg !== 'object') return;
    const m = msg as { method?: unknown; id?: unknown; result?: unknown; error?: unknown; params?: unknown };
    // 有 method = 反向帧：带 id = server→client 请求（Q-017-C 分派 onRequest）；
    // 无 id = 通知（dispatch）
    if (typeof m.method === 'string') {
      if (typeof m.id === 'number') {
        this.dispatchRequest(m.method, m.params, m.id);
        return;
      }
      this.dispatch(m.method, m.params);
      return;
    }
    // 有 id 无 method = 请求响应
    if (typeof m.id === 'number') {
      const pending = this.pending.get(m.id);
      if (!pending) return; // 未知 id（超时后迟到）忽略
      this.pending.delete(m.id);
      if (pending.timer) clearTimeout(pending.timer); // Q-024：无超时请求 timer 为空
      if (m.error !== undefined) pending.reject(this.makeError(m.error));
      else pending.resolve(m.result);
    }
  }

  private dispatch(method: string, params: unknown): void {
    const set = this.handlers.get(method);
    if (!set || set.size === 0) {
      this.logger.info(`[jsonrpc] 未订阅通知: ${method}`);
      return;
    }
    for (const h of set) {
      try {
        h(params);
      } catch (err) {
        this.logger.error(`[jsonrpc] 通知处理异常: ${(err as Error).message}`);
      }
    }
  }

  private dispatchRequest(method: string, params: unknown, id: number): void {
    const set = this.requestHandlers.get(method);
    if (!set || set.size === 0) {
      this.logger.info(`[jsonrpc] 未订阅请求: ${method}`);
      return;
    }
    for (const h of set) {
      try {
        h(params, id);
      } catch (err) {
        this.logger.error(`[jsonrpc] 请求处理异常: ${(err as Error).message}`);
      }
    }
  }

  private write(payload: string): void {
    try {
      this.stdin.write(payload + '\n');
    } catch (err) {
      this.onDisconnect(err as Error);
    }
  }

  private makeError(error: unknown): Error {
    const e = error as { code?: unknown; message?: unknown };
    const message = typeof e?.message === 'string' ? e.message : 'JSON-RPC 错误响应';
    const err = new Error(message);
    if (e?.code !== undefined) (err as { code?: unknown }).code = e.code;
    return err;
  }

  private onDisconnect(err: Error): void {
    if (this.disposed) return;
    this.logger.warn(`[jsonrpc] 通道断开: ${err.message}`);
    this.dispose(new Error(`JSON-RPC 通道断开: ${err.message}`));
  }
}
