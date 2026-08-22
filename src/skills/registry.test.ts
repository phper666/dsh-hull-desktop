/**
 * S1 注册表单测（CON-R-skills-001，设计 D1）
 * 六目录硬编码单点：目录映射 + opencode 多目录读取特殊处理（affectedPlatforms 数据驱动）
 */
import { test } from 'node:test';
import { deepEqual, equal, ok } from 'node:assert/strict';

import { REGISTRY } from './registry';

test('注册表 6 条目：平台与目录映射正确（CON-R-skills-001）', () => {
  equal(REGISTRY.length, 6);
  const byPlatform = new Map(REGISTRY.map((r) => [r.platform, r]));
  equal(byPlatform.get('claude-code')?.dir, '.claude/skills');
  equal(byPlatform.get('opencode')?.dir, '.config/opencode/skills');
  equal(byPlatform.get('codex')?.dir, '.codex/skills');
  equal(byPlatform.get('gemini-cli')?.dir, '.gemini/skills');
  equal(byPlatform.get('cursor')?.dir, '.cursor/skills');
  equal(byPlatform.get('shared')?.dir, '.agents/skills');
});

test('affectedPlatforms：~/.claude 含 claude-code+opencode；~/.config/opencode 仅 opencode（CON-R-skills-002）', () => {
  const byPlatform = new Map(REGISTRY.map((r) => [r.platform, r]));
  deepEqual(byPlatform.get('claude-code')?.affectedPlatforms, ['claude-code', 'opencode']);
  deepEqual(byPlatform.get('opencode')?.affectedPlatforms, ['opencode']);
});

test('affectedPlatforms：~/.agents universal = 全部 agent 平台', () => {
  const shared = REGISTRY.find((r) => r.platform === 'shared');
  ok(shared);
  deepEqual(shared!.affectedPlatforms, ['claude-code', 'opencode', 'codex', 'gemini-cli', 'cursor']);
});
