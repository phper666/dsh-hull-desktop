/**
 * N1 服务门面（设计 §3 main 进程装配：new NotesService → registerNotesIpc）
 * 组合 Store/Scanner/Watcher/Trash；持 notes.dir 生效路径（settings.notesDir ?? <userData>/notes）；
 * setNotesDir 幂等（同目录重复设置无副作用，契约 §接口详情 11）；
 * indexChanged 推送 500ms 防抖合并（设计 §4.2）；写操作登记回声抑制 + 主动增量更新索引（§4.3）。
 */
import { existsSync, mkdirSync, readdirSync, rmdirSync, statSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';

import { HullError } from '../shared/errors';
import { NOOP_LOGGER, type RuntimeLogger } from '../shared/types';

import { NotesScanner } from './NotesScanner';
import { NotesStore, type SaveOutput } from './NotesStore';
import { NotesTrash } from './NotesTrash';
import { NotesWatcher } from './NotesWatcher';
import { resolveSafeNotePath, requireExistingDir } from './pathGuard';
import { NOTES_ERRORS } from './types';
import type { IndexChangedPayload, NoteDetail, NoteIndexEntry, SaveInput, TrashEntry } from './types';

/** indexChanged 推送防抖（同一窗口合并，防批量外部写入事件风暴） */
const PUSH_DEBOUNCE_MS = 500;
/** TTL/容量清理 24h 定时（契约 §核心流程） */
const CLEANUP_INTERVAL_MS = 24 * 60 * 60 * 1000;
/** watch 失效降级重扫间隔（契约 30s） */
const DEGRADED_RESCAN_MS = 30_000;

export class NotesService {
  private readonly logger: RuntimeLogger;
  private readonly userDataPath: string;
  private readonly store: NotesStore;
  private readonly scanner: NotesScanner;
  private readonly trash: NotesTrash;
  private readonly watcher: NotesWatcher;
  /** M→R 推送出口（main 晚绑定 winMgr 后 setBroadcaster 注入；未注入仅索引更新不推） */
  private broadcaster: ((payload: IndexChangedPayload) => void) | null = null;
  private pushTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingReasons = new Set<IndexChangedPayload['reason']>();
  private degradedTimer: ReturnType<typeof setInterval> | null = null;
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;
  private notesDir: string;

  constructor(options: { userDataPath: string; logger?: RuntimeLogger }) {
    this.userDataPath = options.userDataPath;
    this.logger = options.logger ?? NOOP_LOGGER;
    this.notesDir = join(options.userDataPath, 'notes'); // 默认 <userData>/notes/（CON-R-notes-001）
    this.store = new NotesStore({ root: this.notesDir, logger: this.logger });
    this.scanner = new NotesScanner({ root: this.notesDir, logger: this.logger });
    this.trash = new NotesTrash({ userDataPath: options.userDataPath, logger: this.logger });
    // 回收站恢复写回 notes.dir → 同样登记回声抑制（.trash 本体在监听忽略面内）
    this.trash.onNotesWrite = (abs) => this.watcher.markSelfWritten(abs);
    this.watcher = new NotesWatcher({
      root: () => this.notesDir,
      onChange: (rel) => void this.applyIncremental(rel),
      onRemove: (rel) => {
        this.scanner.remove(rel);
        this.schedulePush('incremental');
      },
      onFatal: () => this.enterDegraded(),
      logger: this.logger,
    });
    this.store.onWrite = (abs) => this.watcher.markSelfWritten(abs);
    // 启动：异步全量扫描（不阻塞窗口）+ watch + 清理定时（契约 §核心流程）
    void this.scanner.scan().then(() => this.schedulePush('rescan'));
    this.watcher.start();
    try {
      this.trash.cleanup(); // 启动时清理
    } catch (err) {
      this.logger.warn(`[notes] 启动清理失败: ${(err as Error).message}`);
    }
    this.cleanupTimer = setInterval(() => {
      try {
        this.trash.cleanup();
      } catch {
        /* 定时清理失败无害 */
      }
    }, CLEANUP_INTERVAL_MS);
  }

  setBroadcaster(fn: (payload: IndexChangedPayload) => void): void {
    this.broadcaster = fn;
  }

  getNotesDir(): string {
    return this.notesDir;
  }

  /**
   * settings 接线（契约 §接口详情 11）：换目录重扫不迁移（CON-R-notes-010）。
   * 调用方（main）已校验目录合法（存在、为目录、不在 DSH_HOME 内）；此处 resolve 规范化 + 幂等。
   */
  setNotesDir(dir: string): void {
    const abs = resolve(dir);
    requireExistingDir(abs, dir);
    if (abs === resolve(this.notesDir)) return; // 幂等：同目录重复设置无副作用
    this.watcher.stop(); // 旧 watch 销毁
    this.notesDir = abs;
    this.store.setRoot(abs);
    this.scanner.setRoot(abs); // 旧索引废弃
    this.exitDegraded();
    void this.scanner.scan().then(() => this.schedulePush('dir-changed'));
    this.watcher.start();
  }

  /** 退出/测试清理：watch + 定时器 */
  dispose(): void {
    this.watcher.stop();
    this.exitDegraded();
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
    if (this.pushTimer) {
      clearTimeout(this.pushTimer);
      this.pushTimer = null;
    }
  }

  // ─────────────────────────── IPC 原语（10 通道数据面） ───────────────────────────

  index(): { ready: boolean; entries: NoteIndexEntry[] } {
    return this.scanner.indexPayload();
  }

  get(relPath: string): NoteDetail {
    return this.store.get(relPath);
  }

  save(input: SaveInput): SaveOutput {
    const out = this.store.save(input);
    void this.afterSelfWrite(out.path);
    return out;
  }

  create(dir: string | undefined, title: string | undefined): SaveOutput {
    const out = this.store.create(dir, title);
    void this.afterSelfWrite(out.path);
    return out;
  }

  move(relPath: string, targetDir: string): SaveOutput {
    // targetDir 必须为 notes.dir 下已存在的真实子目录（契约 §接口详情 5）
    const targetAbs = resolveSafeNotePath(this.notesDir, targetDir);
    requireExistingDir(targetAbs, targetDir);
    const out = this.store.move(relPath, targetDir);
    void this.afterSelfWrite(out.path, relPath); // 旧路径移除 + 新路径入索引
    return out;
  }

  /**
   * notes:mkdir（v1.1 集成期补获，Q-075「+ 新建目录」）：
   * pathGuard 校验（拒 ../、绝对路径、隐藏段、.trash）→ mkdirSync recursive；
   * 已存在目录 → 幂等 ok；同名文件占位 → notes-io-error（不覆盖）。目录不进索引（仅 .md 入索引）。
   */
  mkdir(relDir: string): { path: string } {
    const abs = resolveSafeNotePath(this.notesDir, relDir);
    if (existsSync(abs)) {
      if (statSync(abs).isDirectory()) return { path: relDir }; // 幂等
      throw new HullError(NOTES_ERRORS.ioError, `同名文件已存在，无法创建目录: ${relDir}`);
    }
    try {
      mkdirSync(abs, { recursive: true });
    } catch (err) {
      throw new HullError(NOTES_ERRORS.ioError, `目录创建失败: ${relDir} ${(err as Error).message}`);
    }
    return { path: relDir };
  }

  /**
   * notes:rmdir（v1.2，CON-R-notes-015）：仅空目录可删——无子目录且无任何条目；
   * 非空 → notes-dir-not-empty（提示「先移空再删」）；空目录直接 rmdirSync，不进回收站
   * （目录非笔记实体，回收站只管 .md）；根目录/`.trash`/遍历/隐藏段由 pathGuard 拒（同 mkdir 守卫面）。
   */
  rmdir(relDir: string): { path: string } {
    if (relDir === '' || relDir === '.') {
      throw new HullError(NOTES_ERRORS.pathInvalid, '根目录不可删除');
    }
    const abs = resolveSafeNotePath(this.notesDir, relDir);
    let st;
    try {
      st = statSync(abs);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new HullError(NOTES_ERRORS.notFound, `目录不存在: ${relDir}`);
      }
      throw new HullError(NOTES_ERRORS.ioError, `目录读取失败: ${relDir} ${(err as Error).message}`);
    }
    if (!st.isDirectory()) {
      throw new HullError(NOTES_ERRORS.notFound, `不是目录: ${relDir}`);
    }
    if (readdirSync(abs).length > 0) {
      throw new HullError(NOTES_ERRORS.dirNotEmpty, `目录非空，先移空再删: ${relDir}`);
    }
    try {
      rmdirSync(abs);
    } catch (err) {
      throw new HullError(NOTES_ERRORS.ioError, `目录删除失败: ${relDir} ${(err as Error).message}`);
    }
    return { path: relDir };
  }

  delete(relPath: string): { trashId: string } {
    const out = this.trash.deleteFromNotes(this.notesDir, relPath);
    this.scanner.remove(relPath);
    this.schedulePush('incremental');
    return out;
  }

  trashList(): { entries: TrashEntry[]; totalSizeBytes: number } {
    try {
      this.trash.cleanup(); // trashList 惰性触发清理（契约）
    } catch (err) {
      this.logger.warn(`[notes] 惰性清理失败: ${(err as Error).message}`);
    }
    return this.trash.list();
  }

  restore(trashId: string): { restoredPath: string } {
    const out = this.trash.restore(trashId, this.notesDir);
    void this.afterSelfWrite(out.restoredPath);
    return out;
  }

  purge(trashId: string): Record<string, never> {
    return this.trash.purge(trashId);
  }

  search(query: string): { entries: NoteIndexEntry[] } {
    return this.scanner.search(query);
  }

  // ─────────────────────────── 内部：增量/降级/推送 ───────────────────────────

  /** 自写成功后：登记回声已在 store.onWrite 完成 → 索引增量 + 推送（防双推：watch 事件被 1s 窗口吞） */
  private async afterSelfWrite(relPath: string, removedRel?: string): Promise<void> {
    if (removedRel) this.scanner.remove(removedRel);
    await this.scanner.upsert(relPath);
    this.schedulePush('incremental');
  }

  private async applyIncremental(rel: string): Promise<void> {
    await this.scanner.upsert(rel);
    this.schedulePush('incremental');
  }

  /** watch 失效 → degraded：切 30s 定时全量重扫，重扫成功且能重建 watch 则回 ready（设计 §4.3） */
  private enterDegraded(): void {
    if (this.degradedTimer) return;
    this.logger.warn('[notes] watch 失效，降级 30s 定时全量重扫');
    this.degradedTimer = setInterval(() => {
      void this.degradedRescanTick();
    }, DEGRADED_RESCAN_MS);
  }

  private exitDegraded(): void {
    if (this.degradedTimer) {
      clearInterval(this.degradedTimer);
      this.degradedTimer = null;
    }
  }

  private async degradedRescanTick(): Promise<void> {
    await this.scanner.scan();
    if (this.scanner.getStatus() !== 'ready') return; // 目录仍不可读 → 下轮再试
    this.watcher.restart();
    if (!this.watcher.isRunning()) return;
    this.exitDegraded();
    this.schedulePush('rescan');
  }

  /** 500ms 防抖合并：多 reason 取最高优先（dir-changed > rescan > incremental；渲染层反正全量重拉） */
  private schedulePush(reason: IndexChangedPayload['reason']): void {
    this.pendingReasons.add(reason);
    if (this.pushTimer) return;
    this.pushTimer = setTimeout(() => {
      this.pushTimer = null;
      const reasons = this.pendingReasons;
      this.pendingReasons = new Set();
      const payload: IndexChangedPayload = {
        reason: reasons.has('dir-changed') ? 'dir-changed' : reasons.has('rescan') ? 'rescan' : 'incremental',
      };
      try {
        this.broadcaster?.(payload);
      } catch (err) {
        this.logger.warn(`[notes] indexChanged 推送失败: ${(err as Error).message}`);
      }
    }, PUSH_DEBOUNCE_MS);
  }
}

/**
 * notes.dir 禁区判定（oracle 🟡9/🟡10，CON-R-notes-001：绝不写 DSH_HOME / 壳自管 dsh overlay）：
 * 双侧 resolve 归一（拒尾随 /、/../、分隔符漂移绕过）；DSH_HOME 未设则跳过该禁区。
 * 返回 null = 允许；字符串 = 禁区原因（main 接线侧拒绝切换维持旧目录）。
 */
export function forbiddenNotesDirReason(dir: string, userDataPath: string): string | null {
  const dirN = resolve(dir);
  const dshHome = process.env.DSH_HOME;
  if (dshHome) {
    const home = resolve(dshHome);
    if (dirN === home || dirN.startsWith(home + sep)) return 'DSH_HOME 内';
  }
  const overlay = resolve(join(userDataPath, 'dsh'));
  if (dirN === overlay || dirN.startsWith(overlay + sep)) return '壳自管 dsh overlay 内';
  return null;
}
