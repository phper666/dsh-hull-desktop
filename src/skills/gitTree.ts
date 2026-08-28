/**
 * git tree 签名（P0-1，设计决策 1/4/5，docs/design/SK-1-升级检测增强-skills-upgrade-design.md）
 *
 * 本地侧：computeGitBlobSignature —— walk 语义复用 computeDirHash（跳过 symlink/不可读，相对路径排序），
 *   每文件算 git blob SHA-1（sha1("blob <len>\0" + content)，git 默认对象哈希），
 *   对排序后的 (relpath, blobSha1) 序列做 SHA-256（对齐设计 §4.2 / TokenTracker sourceSignatureFromTree）。
 * 远端侧：fetchGitTreeImpl / fetchTreeSignature —— GitHub Trees API（recursive=1），返回的 blob sha 即
 *   git 对象 SHA-1，同规则排序哈希。两端对同一目录内容签名必须逐字节相等（否则恒误报可升级）。
 *
 * RemoteSigCache：进程内 Map + 持久化 <userData>/skills/remote-sig-cache.json（temp+rename 原子写，
 *   对齐 hash-cache 模式），TTL 24h（决策 4）。
 */
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join as pjoin } from 'node:path';

import type { SkillFsOps } from './SkillFsOps';

/** git blob 对象 SHA-1：sha1("blob <len>\0" + content)（git 默认对象哈希；设计 §4.2） */
export function gitBlobSha1(content: string | Buffer): string {
  const buf = typeof content === 'string' ? Buffer.from(content, 'utf8') : content;
  const hash = createHash('sha1');
  hash.update(`blob ${buf.length}\0`);
  hash.update(buf);
  return hash.digest('hex');
}

/** 签名装配：对排序后 (relpath, blobSha1) 序列做 SHA-256（设计 §4.2：
 *  sha256(sorted(files).map(f => relpath + "\0" + sha1).join("\0"))） */
export function signatureFromFiles(files: Array<[string, string]>): string {
  const sorted = [...files].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  const hash = createHash('sha256');
  for (let i = 0; i < sorted.length; i++) {
    if (i > 0) hash.update('\0');
    hash.update(sorted[i][0]);
    hash.update('\0');
    hash.update(sorted[i][1]);
  }
  return hash.digest('hex');
}

/** 本地目录 → git tree 签名：walk 语义同 computeDirHash（跳过 symlink/不可读子目录，相对路径排序）；
 *  不可读文件跳过（对齐设计「跳过不可读」）。 */
export async function computeGitBlobSignature(ops: SkillFsOps, dir: string): Promise<string> {
  const files: Array<[string, string]> = [];
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
      else {
        try {
          files.push([rel, gitBlobSha1(await ops.readFile(abs))]);
        } catch {
          continue; // 不可读文件跳过
        }
      }
    }
  };
  await walk(dir, '');
  return signatureFromFiles(files);
}

/** GitHub Trees API blob 条目（type=blob；sha 即 git 对象 SHA-1） */
export interface TreeEntry {
  path: string;
  type: 'blob' | 'tree';
  sha: string;
}

/** tree 拉取注入点（生产 = Electron 主进程全局 fetch；测试注入 mock） */
export type FetchGitTree = (owner: string, repo: string, branch: string) => Promise<TreeEntry[]>;

/** 生产实现：GET /repos/{o}/{r}/git/trees/{branch}?recursive=1（决策 5：主进程 net.fetch，避开 renderer CSP） */
export async function fetchGitTreeImpl(owner: string, repo: string, branch: string): Promise<TreeEntry[]> {
  const url = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/trees/${encodeURIComponent(branch)}?recursive=1`;
  const res = await fetch(url, { headers: { accept: 'application/vnd.github+json', 'user-agent': 'dsh-hull-desktop' } });
  if (!res.ok) throw new Error(`GitHub tree API ${res.status}`);
  const data = (await res.json()) as { tree?: Array<{ path?: unknown; type?: unknown; sha?: unknown }> };
  const entries: TreeEntry[] = [];
  for (const t of data.tree ?? []) {
    if (t.type !== 'blob' || typeof t.path !== 'string' || typeof t.sha !== 'string') continue;
    entries.push({ path: t.path, type: 'blob', sha: t.sha });
  }
  return entries;
}

/** tree entries → subPath 内签名：过滤 subPath 前缀 + type=blob，取相对 relpath 同规则排序哈希（决策 1） */
export function signatureFromTreeEntries(entries: TreeEntry[], subPath: string): string {
  const prefix = subPath ? subPath.replace(/\/+$/, '') + '/' : '';
  const files: Array<[string, string]> = [];
  for (const e of entries) {
    if (e.type !== 'blob') continue;
    if (prefix) {
      if (!e.path.startsWith(prefix)) continue;
      files.push([e.path.slice(prefix.length), e.sha]);
    } else {
      files.push([e.path, e.sha]);
    }
  }
  return signatureFromFiles(files);
}

/** 单 subPath 便捷签名（fetch + 签名）；fetchTree 可注入（测试） */
export async function fetchTreeSignature(
  owner: string,
  repo: string,
  branch: string,
  subPath: string,
  fetchTree: FetchGitTree = fetchGitTreeImpl
): Promise<string> {
  return signatureFromTreeEntries(await fetchTree(owner, repo, branch), subPath);
}

/** metadata.source(GitHub) → {owner, repo, branch, subPath}；非 GitHub/不可解析 → null（Q-038 https 白名单语义） */
export function parseGithubSourceForTree(src: string | null | undefined): {
  owner: string;
  repo: string;
  branch: string;
  subPath: string;
} | null {
  if (!src) return null;
  const m = /^https:\/\/github\.com\/([^/\s]+)\/([^/\s#?]+?)(?:\.git)?(?:\/tree\/([^/\s]+)((?:\/.*)?))?$/i.exec(src);
  if (!m) return null;
  return {
    owner: m[1],
    repo: m[2],
    branch: m[3] ?? 'HEAD',
    subPath: m[4] ? m[4].replace(/^\/+/, '').replace(/\/+$/, '') : '',
  };
}

/** RemoteSigCache 缓存键（owner/repo 消歧 + branch + subPath） */
export function repoKey(gh: { owner: string; repo: string; branch: string; subPath: string }): string {
  return `${gh.owner}/${gh.repo}#${gh.branch}#${gh.subPath}`;
}

// ─────────────────────────── RemoteSigCache（TTL 24h + 持久化，决策 4） ───────────────────────────

export interface RemoteSigCacheEntry {
  sig: string;
  at: number; // epoch ms
}

export const REMOTE_SIG_TTL_MS = 24 * 60 * 60 * 1000;

/** 进程内 Map + 可选 JSON 持久化（<userData>/skills/remote-sig-cache.json，对齐 hash-cache 原子写模式） */
export class RemoteSigCache {
  private entries = new Map<string, RemoteSigCacheEntry>();

  constructor(private readonly filePath?: string) {}

  /** 损坏文件 → 空缓存重建（只影响网络次数，不影响正确性） */
  async load(): Promise<void> {
    if (!this.filePath) return;
    try {
      const parsed = JSON.parse(readFileSync(this.filePath, 'utf8')) as {
        entries?: Record<string, { sig?: unknown; at?: unknown }>;
      };
      for (const [k, v] of Object.entries(parsed.entries ?? {})) {
        if (v && typeof v.sig === 'string' && typeof v.at === 'number') this.entries.set(k, { sig: v.sig, at: v.at });
      }
    } catch {
      /* 缺失/损坏 → 空缓存重建 */
    }
  }

  /** 命中且未过期 → 签名；缺失/过期 → null（过期触发重取） */
  get(key: string, now: number = Date.now()): string | null {
    const e = this.entries.get(key);
    if (!e) return null;
    if (now - e.at > REMOTE_SIG_TTL_MS) return null;
    return e.sig;
  }

  set(key: string, sig: string, now: number = Date.now()): void {
    this.entries.set(key, { sig, at: now });
  }

  /** temp+rename 原子写（对齐 hash-cache 模式） */
  async save(): Promise<void> {
    if (!this.filePath) return;
    mkdirSync(pjoin(this.filePath, '..'), { recursive: true });
    const tmp = `${this.filePath}.tmp-${process.pid}-${Date.now()}`;
    writeFileSync(tmp, JSON.stringify({ version: 1, entries: Object.fromEntries(this.entries) }), 'utf8');
    renameSync(tmp, this.filePath);
  }
}
