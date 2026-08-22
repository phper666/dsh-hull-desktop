/**
 * 来源三级降级解析（CON-R-skills-005，设计 D5）：
 * ① frontmatter metadata.source → ② lock source+skillPath 构建 GitHub tree URL → ③ null「来源未知」。
 * 纯函数表驱动可测（T8/T9/T10）；URL 仅接受 ^https://（Q-038 白名单语义）。
 */

export interface LockEntry {
  source?: string;
  skillPath?: string;
  branch?: string;
  /** 远端哈希字段（Q-034 一级来源；口径实测协调项，字段名两种形态都收） */
  hash?: string;
  content_hash?: string;
}

const GITHUB_REPO_RE = /^https:\/\/github\.com\/([^/\s]+)\/([^/\s#?]+?)(?:\.git)?(?:\/.*)?$/i;

/**
 * 三级降级：metadataSource（frontmatter metadata.source）优先，lock 次之，均无 null。
 */
export function resolveSource(
  metadataSource: string | null | undefined,
  lock: LockEntry | null | undefined
): string | null {
  if (metadataSource && /^https:\/\/.+/.test(metadataSource)) return metadataSource;
  if (lock?.source && lock.skillPath && /^https:\/\/.+/.test(lock.source)) {
    const m = lock.source.match(GITHUB_REPO_RE);
    if (m) {
      const branch = lock.branch || 'main';
      const skillPath = lock.skillPath.replace(/^\/+/, '');
      return `https://github.com/${m[1]}/${m[2]}/tree/${branch}/${skillPath}`;
    }
  }
  return null;
}

/**
 * skills-lock.json 防御性解析 → name→entry 归一 map。
 * 接受数组形态 [{name,...}] 与 map 形态 {name:{...}}；坏 JSON/非预期结构 → 空 map 不抛错。
 * （lock 文件 schema 无官方文档——O-1 同款实测协调项，缺字段置空不阻塞。）
 */
export function parseSkillsLock(raw: string): Record<string, LockEntry> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  const out: Record<string, LockEntry> = {};
  if (Array.isArray(parsed)) {
    for (const e of parsed) {
      if (e && typeof e === 'object' && typeof (e as { name?: unknown }).name === 'string') {
        const { name: _name, ...rest } = e as { name: string } & Record<string, unknown>;
        out[_name] = rest as LockEntry;
      }
    }
    return out;
  }
  if (parsed && typeof parsed === 'object') {
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (v && typeof v === 'object' && !Array.isArray(v)) out[k] = v as LockEntry;
    }
  }
  return out;
}
