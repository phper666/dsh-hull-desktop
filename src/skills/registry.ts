/**
 * Agent→目录注册表（CON-R-skills-001 硬编码单点，设计 D1）
 * 目录约定变化只改此处；opencode 多目录读取以 affectedPlatforms 数据驱动表达：
 * ~/.claude/skills 与 ~/.agents/skills 的条目同时被 opencode 读取（无 if 分支散落）。
 */

/** 全部 agent 平台（'shared' 是注册表键名非平台值） */
export const ALL_AGENT_PLATFORMS = [
  'claude-code',
  'opencode',
  'codex',
  'gemini-cli',
  'cursor',
  'windsurf',
  'warp',
  'trae',
  'cline',
  'roo',
  'continue',
  'devin',
  'dsh',
  'qoder',
  'reasonix',
] as const;

/**
 * ~/.agents/skills 共享目录的确认读者（2026-08-27 官方文档/源码逐平台校验，见
 * docs/research/2026-08-27-skills管理调研.md 与 registry 提交说明）：
 * 确认读：opencode/codex/gemini-cli/cursor/windsurf/warp/cline/roo/devin/dsh
 * 确认不读：claude-code（官方 repo 0 命中）、continue（源码仅 .continue+项目 .claude）
 * 未声明：trae/qoder/reasonix（不列入，不臆断）
 */
export const SHARED_DIR_READERS = [
  'opencode',
  'codex',
  'gemini-cli',
  'cursor',
  'windsurf',
  'warp',
  'cline',
  'roo',
  'devin',
  'dsh',
] as const;

export interface RegistryEntry {
  /** 注册表键（平台名或 shared） */
  platform: string;
  /** home 下相对目录 */
  dir: string;
  /** 该目录内 skill 的生效平台集合（全局/scoped 判定与平台徽标依据，CON-R-skills-002） */
  affectedPlatforms: string[];
}

export const REGISTRY: RegistryEntry[] = [
  // claude-code/codex 目录被多平台读取（2026-08-27 校验）：opencode（源码）+ cursor（官方 compat）+ warp（源码全局解析）
  { platform: 'claude-code', dir: '.claude/skills', affectedPlatforms: ['claude-code', 'opencode', 'cursor', 'warp'] },
  { platform: 'opencode', dir: '.config/opencode/skills', affectedPlatforms: ['opencode'] },
  { platform: 'codex', dir: '.codex/skills', affectedPlatforms: ['codex', 'cursor', 'warp'] }, // 官方标注 deprecated（替代 ~/.agents/skills），仍读取
  { platform: 'gemini-cli', dir: '.gemini/skills', affectedPlatforms: ['gemini-cli'] },
  { platform: 'cursor', dir: '.cursor/skills', affectedPlatforms: ['cursor'] },
  // windsurf/devin：Cognition 合并后同产品互读（docs.devin.ai）
  { platform: 'windsurf', dir: '.codeium/windsurf/skills', affectedPlatforms: ['windsurf', 'devin'] },
  { platform: 'warp', dir: '.warp/skills', affectedPlatforms: ['warp'] },
  { platform: 'trae', dir: '.trae/skills', affectedPlatforms: ['trae'] },
  { platform: 'trae-cn', dir: '.trae-cn/skills', affectedPlatforms: ['trae'] },
  { platform: 'cline', dir: '.cline/skills', affectedPlatforms: ['cline'] },
  { platform: 'roo', dir: '.roo/skills', affectedPlatforms: ['roo'] },
  { platform: 'continue', dir: '.continue/skills', affectedPlatforms: ['continue'] },
  { platform: 'devin', dir: '.config/devin/skills', affectedPlatforms: ['devin', 'windsurf'] },
  { platform: 'dsh', dir: '.dsh/skills', affectedPlatforms: ['dsh'] },
  { platform: 'qoder', dir: '.qoder/skills', affectedPlatforms: ['qoder'] },
  { platform: 'qoder-cn', dir: '.qoder-cn/skills', affectedPlatforms: ['qoder'] },
  { platform: 'reasonix', dir: '.reasonix/skills', affectedPlatforms: ['reasonix'] },
  { platform: 'shared', dir: '.agents/skills', affectedPlatforms: [...SHARED_DIR_READERS] },
];

/** shared（universal）目录相对路径（scope 判定基准，CON-R-skills-002） */
export const SHARED_DIR = '.agents/skills';
