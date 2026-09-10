/**
 * N1 扫描器（设计 D2/§4.2，契约 §接口详情 1/10）
 * 纯内存索引（事实源 = 磁盘 md 文件）：启动全量扫描（跳隐藏目录与 .trash，仅 .md）
 * → 内存索引快照原子替换（旧快照持续可读，模式对齐 SkillsScanner:105）；
 * 状态机 idle→scanning→ready/degraded；幂等 scan（scanning 中重入返回同一 Promise）；
 * watch 增量经 upsert/remove 单文件更新。搜索 = 标题+全文子串、大小写不敏感、updatedAt 倒序（D3）。
 */
import { statSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { HullError } from '../shared/errors';
import { NOOP_LOGGER, type RuntimeLogger } from '../shared/types';

import { parseNoteFrontmatter } from './frontmatter';
import { NOTES_ERRORS, type NoteIndexEntry } from './types';

/** 全量扫描并发读上限（设计 §4.8） */
const SCAN_CONCURRENCY = 8;
/** snippet 长度（契约 NoteIndexEntry.snippet：前 200 字符） */
const SNIPPET_LEN = 200;

export type ScannerStatus = 'idle' | 'scanning' | 'ready' | 'degraded';

/** 内部条目（NoteIndexEntry + 全文，供搜索；body 不出 IPC 面） */
interface InternalEntry {
  entry: NoteIndexEntry;
  body: string;
}

export class NotesScanner {
  private readonly logger: RuntimeLogger;
  private root: string;
  private status: ScannerStatus = 'idle';
  private scanError: string | null = null;
  private index = new Map<string, InternalEntry>(); // key = 相对路径（'/' 分隔）
  private scanPromise: Promise<void> | null = null;

  constructor(options: { root: string; logger?: RuntimeLogger }) {
    this.root = options.root;
    this.logger = options.logger ?? NOOP_LOGGER;
  }

  getStatus(): ScannerStatus {
    return this.status;
  }

  isReady(): boolean {
    return this.status === 'ready';
  }

  getRoot(): string {
    return this.root;
  }

  /** 换目录：旧索引废弃（setNotesDir 由 Service 编排 scan） */
  setRoot(root: string): void {
    this.root = root;
    this.index = new Map();
    this.status = 'idle';
    this.scanError = null;
  }

  /** 全量扫描（幂等：scanning 中重入返回同一 Promise，对齐 SkillsScanner §4.2） */
  scan(): Promise<void> {
    if (this.scanPromise) return this.scanPromise;
    this.status = 'scanning';
    this.scanPromise = this.runScan().finally(() => {
      this.scanPromise = null;
    });
    return this.scanPromise;
  }

  private async runScan(): Promise<void> {
    try {
      const rels = await this.walk('');
      const next = new Map<string, InternalEntry>();
      let idx = 0;
      const worker = async (): Promise<void> => {
        while (idx < rels.length) {
          const rel = rels[idx++];
          try {
            const abs = join(this.root, rel);
            const content = await readFile(abs, 'utf8');
            next.set(rel, this.buildEntry(rel, abs, content));
          } catch (err) {
            this.logger.warn(`[notes] 单文件扫描失败跳过: ${rel} ${(err as Error).message}`);
          }
        }
      };
      await Promise.all(Array.from({ length: Math.min(SCAN_CONCURRENCY, rels.length || 1) }, worker));
      // 快照原子替换（旧快照持续可读）
      this.index = next;
      this.status = 'ready';
      this.scanError = null;
    } catch (err) {
      // notes.dir 不可读 → degraded（保留旧快照，定时重扫兜底）
      this.status = 'degraded';
      this.scanError = (err as Error).message;
      this.logger.warn(`[notes] 全量扫描失败（degraded）: ${this.scanError}`);
    }
  }

  /** 递归收集 .md 相对路径：跳过 `.` 开头段（含 .trash），仅 .md */
  private async walk(relDir: string): Promise<string[]> {
    const absDir = relDir === '' ? this.root : join(this.root, relDir);
    let names: import('node:fs').Dirent[];
    try {
      names = await readdir(absDir, { withFileTypes: true });
    } catch (err) {
      if (relDir === '') throw err; // 根不可读 = 致命（degraded）
      return []; // 子目录不可读 → 跳过
    }
    const out: string[] = [];
    for (const e of names) {
      if (e.name.startsWith('.')) continue; // 隐藏目录/文件 + .trash
      const rel = relDir === '' ? e.name : `${relDir}/${e.name}`;
      if (e.isDirectory()) out.push(...(await this.walk(rel)));
      else if (e.isFile() && e.name.endsWith('.md')) out.push(rel);
    }
    return out;
  }

  /** 单文件构建索引条目（解析失败 = 三键视为空照常入索引，CON-R-notes-005；title 回退文件名基名 CON-R-notes-014） */
  private buildEntry(rel: string, abs: string, content: string): InternalEntry {
    const { fm } = parseNoteFrontmatter(content);
    const body = stripFrontmatter(content);
    const title = fm.title ?? basenameNoExt(rel);
    const snippet = body.replace(/\r\n/g, '\n').replace(/\s*\n\s*/g, ' ').trim().slice(0, SNIPPET_LEN);
    let updatedAt = new Date(0).toISOString();
    try {
      updatedAt = statSync(abs).mtime.toISOString();
    } catch {
      /* mtime 缺失 → epoch（理论不可达：read 已成功） */
    }
    return {
      entry: { path: rel, title, frontmatter: fm, snippet, updatedAt },
      body,
    };
  }

  /** watch 增量：单文件重读入索引（文件已消失/不可读 → 移除） */
  async upsert(rel: string): Promise<void> {
    const abs = join(this.root, rel);
    try {
      const content = await readFile(abs, 'utf8');
      this.index.set(rel, this.buildEntry(rel, abs, content));
    } catch {
      this.index.delete(rel);
    }
  }

  /** watch 增量：删除对应项（不存在则无害） */
  remove(rel: string): void {
    this.index.delete(rel);
  }

  /** notes:index 响应（updatedAt 倒序全量；degraded → notes-scan-error） */
  indexPayload(): { ready: boolean; entries: NoteIndexEntry[] } {
    if (this.status === 'degraded') {
      throw new HullError(NOTES_ERRORS.scanError, `notes.dir 不可读: ${this.scanError ?? 'unknown'}`);
    }
    return { ready: this.isReady(), entries: this.sortedEntries() };
  }

  /** notes:search（标题+全文子串、大小写不敏感、updatedAt 倒序；空串 = 全部） */
  search(query: unknown): { entries: NoteIndexEntry[] } {
    if (this.status === 'degraded') {
      throw new HullError(NOTES_ERRORS.scanError, `notes.dir 不可读: ${this.scanError ?? 'unknown'}`);
    }
    const q = typeof query === 'string' ? query.toLowerCase() : '';
    const entries = this.sortedEntries().filter((e) => {
      if (q === '') return true;
      const item = this.index.get(e.path);
      return e.title.toLowerCase().includes(q) || (item ? item.body.toLowerCase().includes(q) : false);
    });
    return { entries };
  }

  private sortedEntries(): NoteIndexEntry[] {
    return [...this.index.values()].map((i) => i.entry).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }
}

function basenameNoExt(rel: string): string {
  const base = rel.split('/').pop() ?? rel;
  return base.endsWith('.md') ? base.slice(0, -3) : base;
}

/** 去 frontmatter 块（合法边界剥块含尾随空行；无块/未闭合原文返回） */
function stripFrontmatter(content: string): string {
  const text = content.replace(/\r\n/g, '\n');
  if (!text.startsWith('---\n')) return text;
  const end = text.indexOf('\n---', 4);
  if (end === -1) return text;
  let rest = text.slice(end + 4);
  if (rest.startsWith('\n')) rest = rest.slice(1);
  return rest;
}
