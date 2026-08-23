/**
 * 内容哈希 + mtime 缓存（CON-R-skills-004/009，设计 §4.3）
 * SHA-256 覆盖 skill 文件夹全部文件（相对路径+内容按路径排序后计算，顺序无关）；
 * 缓存键=path，mtime 一致命中，否则重算回写；持久化 temp+rename 原子写。
 */
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join as pjoin } from 'node:path';

import type { SkillFsOps } from './SkillFsOps';

/** 目录内容哈希：递归收集文件（相对路径排序）→ SHA-256(path\0content\0...)。
 *  symlink 一律跳过（lstat 判定，不跟随）——循环防护（契约「symlink 循环检测到即跳过」） */
export async function computeDirHash(ops: SkillFsOps, dir: string): Promise<string> {
  const files: Array<{ rel: string; abs: string }> = [];
  const walk = async (d: string, prefix: string): Promise<void> => {
    let names: string[];
    try {
      names = (await ops.readdir(d)).sort();
    } catch {
      return; // 不可读子目录跳过
    }
    for (const name of names) {
      const abs = ops.join(d, name);
      const rel = prefix ? `${prefix}/${name}` : name;
      let ls;
      try {
        ls = await ops.lstat(abs);
      } catch {
        continue; // 悬空/异常条目跳过
      }
      if (ls.isSymbolicLink()) continue; // 不跟随链接（循环/逃逸防护）
      const st = await ops.stat(abs).catch(() => null);
      if (!st) continue;
      if (st.isDirectory()) await walk(abs, rel);
      else files.push({ rel, abs });
    }
  };
  await walk(dir, '');
  files.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
  const hash = createHash('sha256');
  for (const f of files) {
    hash.update(f.rel);
    hash.update('\0');
    try {
      hash.update(await ops.readFile(f.abs));
    } catch {
      hash.update('<unreadable>'); // 读失败的文件以占位参与（不静默崩溃）
    }
    hash.update('\0');
  }
  return hash.digest('hex');
}

interface CacheEntry {
  mtimeMs: number;
  hash: string;
}

/** 哈希缓存：内存 Map + 可选 JSON 持久化（<userData>/skills/hash-cache.json，契约 §哈希缓存） */
export class HashCache {
  private entries = new Map<string, CacheEntry>();

  constructor(private readonly filePath?: string) {}

  /** 损坏文件 → 告警语义由调用方承担，此处按空缓存重建不抛错 */
  async load(): Promise<void> {
    if (!this.filePath) return;
    try {
      const parsed = JSON.parse(readFileSync(this.filePath, 'utf8')) as {
        entries?: Record<string, { mtimeMs?: unknown; hash?: unknown }>;
      };
      for (const [k, v] of Object.entries(parsed.entries ?? {})) {
        if (v && typeof v.mtimeMs === 'number' && typeof v.hash === 'string') {
          this.entries.set(k, { mtimeMs: v.mtimeMs, hash: v.hash });
        }
      }
    } catch {
      /* 缺失/损坏 → 空缓存重建（只影响性能不影响正确性） */
    }
  }

  lookup(path: string, mtimeMs: number): string | undefined {
    const e = this.entries.get(path);
    return e && e.mtimeMs === mtimeMs ? e.hash : undefined;
  }

  store(path: string, mtimeMs: number, hash: string): void {
    this.entries.set(path, { mtimeMs, hash });
  }

  /** ponytail: 目录 mtime 不反映深层文件改动——升级检测正确性由 S2 写前守卫+强制重算兜底，此处只服务展示性能 */
  async get(path: string, mtimeMs: number, compute: () => Promise<string>): Promise<string> {
    const hit = this.lookup(path, mtimeMs);
    if (hit !== undefined) return hit;
    const h = await compute();
    this.store(path, mtimeMs, h);
    return h;
  }

  /** temp+rename 原子写；userData 不可写时抛错（扫描管线顶层捕获 → status=error，设计 §4.1 致命错误） */
  async save(): Promise<void> {
    if (!this.filePath) return;
    mkdirSync(pjoin(this.filePath, '..'), { recursive: true });
    const tmp = `${this.filePath}.tmp-${process.pid}-${Date.now()}`;
    writeFileSync(tmp, JSON.stringify({ version: 1, entries: Object.fromEntries(this.entries) }), 'utf8');
    renameSync(tmp, this.filePath);
  }
}
