/**
 * 来源解析（CON-R-skills-005，设计 D5，Q-034 变更）：
 * ① frontmatter metadata.source（唯一来源）→ 无则 null「来源未知」。
 * 已移除 lock 二级降级（skills-lock.json 不再读取——历史静态快照无持续生成者，
 * 升级检测只依赖标准位置 .arkcli 平台 lock + frontmatter source 推断）。
 * URL 仅接受 ^https://（Q-038 白名单语义）。
 */

export interface LockEntry {
  source?: string;
  skillPath?: string;
  branch?: string;
  /** 远端哈希字段（Q-034 一级来源；口径实测协调项，字段名两种形态都收） */
  hash?: string;
  content_hash?: string;
}

/**
 * 来源解析：metadataSource（frontmatter metadata.source）匹配 https 则采用，否则 null。
 * （LockEntry 保留仅供 lockProvider 测试注入类型使用，不再参与来源解析。）
 */
export function resolveSource(metadataSource: string | null | undefined): string | null {
  if (metadataSource && /^https:\/\/.+/.test(metadataSource)) return metadataSource;
  return null;
}
