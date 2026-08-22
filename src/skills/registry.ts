/**
 * Agent→目录注册表（CON-R-skills-001 硬编码单点，设计 D1）
 * 目录约定变化只改此处；opencode 多目录读取以 affectedPlatforms 数据驱动表达：
 * ~/.claude/skills 与 ~/.agents/skills 的条目同时被 opencode 读取（无 if 分支散落）。
 */

/** 全部 agent 平台（~/.agents universal 生效集合；'shared' 是注册表键名非平台值） */
export const ALL_AGENT_PLATFORMS = ['claude-code', 'opencode', 'codex', 'gemini-cli', 'cursor'] as const;

export interface RegistryEntry {
  /** 注册表键（平台名或 shared） */
  platform: string;
  /** home 下相对目录 */
  dir: string;
  /** 该目录内 skill 的生效平台集合（全局/scoped 判定与平台徽标依据，CON-R-skills-002） */
  affectedPlatforms: string[];
}

export const REGISTRY: RegistryEntry[] = [
  { platform: 'claude-code', dir: '.claude/skills', affectedPlatforms: ['claude-code', 'opencode'] },
  { platform: 'opencode', dir: '.config/opencode/skills', affectedPlatforms: ['opencode'] },
  { platform: 'codex', dir: '.codex/skills', affectedPlatforms: ['codex'] },
  { platform: 'gemini-cli', dir: '.gemini/skills', affectedPlatforms: ['gemini-cli'] },
  { platform: 'cursor', dir: '.cursor/skills', affectedPlatforms: ['cursor'] },
  { platform: 'shared', dir: '.agents/skills', affectedPlatforms: [...ALL_AGENT_PLATFORMS] },
];

/** shared（universal）目录相对路径（scope 判定基准，CON-R-skills-002） */
export const SHARED_DIR = '.agents/skills';
