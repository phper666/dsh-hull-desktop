/**
 * 远端哈希梯子实现（P0-1，设计决策 2，docs/design/SK-1-升级检测增强-skills-upgrade-design.md）
 *
 * ① 平台 lock（name→hash，最高优先）→ ② metadata.source(GitHub) → tree 签名（缓存命中/拉取）→ null。
 * 非 GitHub source / 无 source → null（unknown，保守不误报可升级；不降级临时 clone——网络成本高，检测侧不值）。
 * 同步扫描（allowFetch=false）：缓存未命中 → 记 pending 不网络请求（保持扫描 <2s，后台预取补全）。
 */
import {
  parseGithubSourceForTree,
  repoKey,
  signatureFromTreeEntries,
  type FetchGitTree,
  type RemoteSigCache,
} from './gitTree';

export interface LadderPending {
  owner: string;
  repo: string;
  branch: string;
  subPath: string;
}

export interface LadderResult {
  remoteHash: string | null;
  /** GitHub source 且缓存未命中（同步侧需后台预取）；命中/非 GitHub → null */
  pending: LadderPending | null;
}

export interface LadderOptions {
  /** 平台 lock 命中的 hash（① 最高优先；null 表示未命中） */
  lockHash: string | null;
  /** 已解析的 metadata.source（可能 null） */
  source: string | null;
  cache: RemoteSigCache;
  fetchTree: FetchGitTree;
  /** true=允许网络拉取（后台预取侧）；false=仅缓存命中（同步扫描侧，保持 <2s） */
  allowFetch: boolean;
  /** 测试注入时间基准 */
  now?: number;
}

export async function ladderRemoteHash(opts: LadderOptions): Promise<LadderResult> {
  if (opts.lockHash) return { remoteHash: opts.lockHash, pending: null }; // ① 平台 lock 最高优先（不进 ②，避免重复网络请求）
  const gh = parseGithubSourceForTree(opts.source);
  if (!gh) return { remoteHash: null, pending: null }; // 无 source / 非 GitHub → unknown
  const key = repoKey(gh);
  const hit = opts.cache.get(key, opts.now);
  if (hit !== null) return { remoteHash: hit, pending: null }; // 缓存命中（TTL 内）不请求
  if (!opts.allowFetch) return { remoteHash: null, pending: gh }; // 同步侧：记 pending，后台预取
  try {
    const entries = await opts.fetchTree(gh.owner, gh.repo, gh.branch);
    const sig = signatureFromTreeEntries(entries, gh.subPath);
    opts.cache.set(key, sig, opts.now);
    return { remoteHash: sig, pending: null };
  } catch {
    return { remoteHash: null, pending: null }; // 失败静默降级 unknown（不重试风暴，下次扫描再试）
  }
}
