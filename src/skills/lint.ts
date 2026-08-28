/**
 * SKILL.md 健康度 lint（P0-2，设计决策 6，docs/design/SK-1-升级检测增强-skills-upgrade-design.md）
 * 只读标注，不触文件不改状态机。规则对齐 Hull 实际解析行为（缺字段降级 null、不丢弃条目）：
 *   warn：无 frontmatter/缺 name（无法按名聚合/识别）；缺 description（无触发描述，模型难触发）；
 *         description > 1024 字符（ZCode 硬失败阈值）。
 *   info：无 metadata.source（无法升级检测，恒 unknown）；source 非 https 形态（sourceResolver 降级 null 同理）。
 * level = 最高严重级；issues = 全部命中项。
 */
import type { Frontmatter } from './frontmatter';

export interface SkillLint {
  level: 'warn' | 'info' | null;
  issues: string[];
}

const DESCRIPTION_MAX = 1024;

export function lintSkill(fm: Frontmatter): SkillLint {
  const issues: string[] = [];
  let level: 'warn' | 'info' | null = null;
  const bump = (l: 'warn' | 'info', issue: string): void => {
    issues.push(issue);
    if (l === 'warn') level = 'warn';
    else if (level !== 'warn') level = 'info';
  };

  // warn 档
  if (fm.name == null) bump('warn', '缺 name（含无 frontmatter 场景，无法按名聚合/识别）');
  if (fm.description == null || fm.description === '') {
    bump('warn', '缺 description（无触发描述，模型难触发）');
  } else if (fm.description.length > DESCRIPTION_MAX) {
    bump('warn', `description 超过 ${DESCRIPTION_MAX} 字符（ZCode 硬失败阈值，超长难用）`);
  }
  // info 档
  const src = fm.metadata.source ?? null;
  if (src == null || src === '') {
    bump('info', '无 metadata.source（无法升级检测，恒 unknown）');
  } else if (!/^https:\/\/.+/.test(src)) {
    bump('info', 'metadata.source 非 https 形态（来源解析降级 null）');
  }

  return { level: issues.length ? level : null, issues };
}
