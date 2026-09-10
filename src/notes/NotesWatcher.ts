/**
 * N1 Watcher（设计 D5/§4.3，契约 §Watch 细节）
 * chokidar 封装（Q-074 定案首选，设计 D2）：增量事件 → 回声抑制（自写路径 1s 窗口吞掉）
 * → 回调进 Service（索引更新 + indexChanged 推送）；rename 由 chokidar 归一为 unlink+add（契约按 delete+add）。
 * 初始化失败/运行中 error/close → onFatal 回调（Service 切 degraded + 30s 重扫）。
 * 仅关注 .md；`.` 开头隐藏目录/文件与 .trash 一律忽略。
 */
import { watch, type FSWatcher } from 'chokidar';

import { NOOP_LOGGER, type RuntimeLogger } from '../shared/types';

/** 自写回声窗口（契约 Q-074 定死 1s） */
const ECHO_WINDOW_MS = 1000;

export interface NotesWatcherOptions {
  root: () => string;
  /** 新增/修改（已过回声抑制） */
  onChange: (relPath: string) => void;
  /** 删除 */
  onRemove: (relPath: string) => void;
  /** watch 初始化失败/运行中失效（Service 切降级） */
  onFatal: () => void;
  logger?: RuntimeLogger;
}

export class NotesWatcher {
  private readonly opts: NotesWatcherOptions;
  private readonly logger: RuntimeLogger;
  private watcher: FSWatcher | null = null;
  /** 自写登记：absPath → 写盘时刻（1s 过期清理，D5） */
  private readonly selfWritten = new Map<string, number>();
  private fatalFired = false;

  constructor(options: NotesWatcherOptions) {
    this.opts = options;
    this.logger = options.logger ?? NOOP_LOGGER;
  }

  /** 启动监听（幂等：已在跑直接返回；旧 watcher 已 closed 则重建）。错误经 onFatal 异步上报 */
  start(): void {
    if (this.watcher && !this.watcher.closed) return;
    this.watcher = null;
    this.fatalFired = false;
    try {
      this.watcher = watch(this.opts.root(), {
        ignoreInitial: true,
        awaitWriteFinish: { stabilityThreshold: 300, pollInterval: 100 }, // R4：过滤外部原子写半写窗口
        ignored: (p: string) => /(^|[\\/])\.[^\\/]/.test(p), // 隐藏目录/文件 + .trash
      });
    } catch (err) {
      this.watcher = null;
      this.logger.warn(`[notes] watch 初始化失败: ${(err as Error).message}`);
      this.fireFatal();
      return;
    }
    this.watcher.on('add', (p) => this.emit(p, 'add'));
    this.watcher.on('change', (p) => this.emit(p, 'change'));
    this.watcher.on('unlink', (p) => this.emit(p, 'unlink'));
    this.watcher.on('error', (err: unknown) => {
      this.logger.warn(`[notes] watch 运行错误: ${(err as Error).message}`);
      this.fireFatal();
    });
    // chokidar v4 无 'close' 事件——关闭仅由本类 stop() 主动触发（fatal 语义由 'error' 承担）
  }

  isRunning(): boolean {
    return this.watcher !== null && !this.watcher.closed;
  }

  stop(): void {
    if (!this.watcher) return;
    const w = this.watcher;
    this.watcher = null;
    this.fatalFired = true; // 主动 stop 不触发 onFatal（setNotesDir 场景）
    void w.close().catch(() => {
      /* 关闭失败无害（进程退出兜底） */
    });
  }

  /** 主进程自身写盘登记（save/create/move/delete/restore 后 1s 内对应路径事件吞掉，D5） */
  markSelfWritten(absPath: string): void {
    this.selfWritten.set(absPath, Date.now());
    if (this.selfWritten.size > 256) this.pruneExpired();
  }

  /** 降级恢复：重试启动（fatal 状态复位） */
  restart(): void {
    this.stop();
    this.fatalFired = false;
    this.start();
  }

  private emit(absPath: string, kind: 'add' | 'change' | 'unlink'): void {
    if (this.isSelfEcho(absPath)) return;
    const root = this.opts.root();
    const rel = absPath.startsWith(root + '/') ? absPath.slice(root.length + 1) : absPath;
    if (!rel.endsWith('.md')) return; // 非 .md（trash.json 等）不入索引
    if (kind === 'unlink') this.opts.onRemove(rel);
    else this.opts.onChange(rel);
  }

  private isSelfEcho(absPath: string): boolean {
    const ts = this.selfWritten.get(absPath);
    if (ts === undefined) return false;
    if (Date.now() - ts <= ECHO_WINDOW_MS) return true;
    this.selfWritten.delete(absPath);
    return false;
  }

  private pruneExpired(): void {
    const now = Date.now();
    for (const [p, ts] of this.selfWritten) {
      if (now - ts > ECHO_WINDOW_MS) this.selfWritten.delete(p);
    }
  }

  private fireFatal(): void {
    if (this.fatalFired) return;
    this.fatalFired = true;
    this.opts.onFatal();
  }
}
