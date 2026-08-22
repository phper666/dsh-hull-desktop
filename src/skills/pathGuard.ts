/**
 * 路径安全校验（Q-038 / CON-R-skills-007，设计 D7）
 * 目录名白名单正则（拒 ../、空名、路径分隔符、控制字符、非法字符）+ 白名单域包含判定。
 * renderer 输入一律不可信——校验在 main 侧强制。
 */
import { normalize, sep } from 'node:path';

/** 首字符须为字母/数字（含 Unicode），后续允许 字母/数字/./-/_；拒绝前导点与 .. 序列 */
const NAME_RE = /^[\p{L}\p{N}][\p{L}\p{N}._-]*$/u;

export function isValidSkillName(name: unknown): boolean {
  if (typeof name !== 'string' || name.length === 0) return false;
  if (name.includes('/') || name.includes('\\')) return false; // 路径分隔符
  if (name.includes('..')) return false; // 穿越序列
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f]/.test(name)) return false; // 控制字符
  return NAME_RE.test(name);
}

/** path 是否落在任一 root 域内（规范化后前缀包含；/root/foo 与 /root/foobar 不互认） */
export function isWithinRoots(path: string, roots: string[]): boolean {
  const norm = normalize(path);
  return roots.some((r) => {
    const rn = normalize(r);
    return norm === rn || norm.startsWith(rn + sep);
  });
}
