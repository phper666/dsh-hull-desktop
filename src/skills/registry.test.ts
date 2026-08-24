/**
 * S1 注册表单测（CON-R-skills-001，设计 D1）
 * 十四目录硬编码单点：目录映射 + opencode 多目录读取特殊处理（affectedPlatforms 数据驱动）
 * v1.5 平台扩展：新增 windsurf/warp/trae(+cn)/cline/roo/continue/devin
 */
import { test } from 'node:test';
import { deepEqual, equal, ok } from 'node:assert/strict';

import { REGISTRY } from './registry';

test('注册表 14 条目：平台与目录映射正确（CON-R-skills-001）', () => {
  equal(REGISTRY.length, 14);
  const byPlatform = new Map(REGISTRY.map((r) => [r.platform, r]));
  equal(byPlatform.get('claude-code')?.dir, '.claude/skills');
  equal(byPlatform.get('opencode')?.dir, '.config/opencode/skills');
  equal(byPlatform.get('codex')?.dir, '.codex/skills');
  equal(byPlatform.get('gemini-cli')?.dir, '.gemini/skills');
  equal(byPlatform.get('cursor')?.dir, '.cursor/skills');
  equal(byPlatform.get('windsurf')?.dir, '.codeium/windsurf/skills');
  equal(byPlatform.get('warp')?.dir, '.warp/skills');
  equal(byPlatform.get('trae')?.dir, '.trae/skills');
  equal(byPlatform.get('trae-cn')?.dir, '.trae-cn/skills');
  equal(byPlatform.get('cline')?.dir, '.cline/skills');
  equal(byPlatform.get('roo')?.dir, '.roo/skills');
  equal(byPlatform.get('continue')?.dir, '.continue/skills');
  equal(byPlatform.get('devin')?.dir, '.config/devin/skills');
  equal(byPlatform.get('shared')?.dir, '.agents/skills');
});

test('affectedPlatforms：~/.claude 含 claude-code+opencode；~/.config/opencode 仅 opencode（CON-R-skills-002）', () => {
  const byPlatform = new Map(REGISTRY.map((r) => [r.platform, r]));
  deepEqual(byPlatform.get('claude-code')?.affectedPlatforms, ['claude-code', 'opencode']);
  deepEqual(byPlatform.get('opencode')?.affectedPlatforms, ['opencode']);
});

test('affectedPlatforms：新增平台各自专属；trae-cn 归并 trae（CON-R-skills-002）', () => {
  const byPlatform = new Map(REGISTRY.map((r) => [r.platform, r]));
  for (const p of ['windsurf', 'warp', 'cline', 'roo', 'continue', 'devin']) {
    deepEqual(byPlatform.get(p)?.affectedPlatforms, [p]);
  }
  deepEqual(byPlatform.get('trae')?.affectedPlatforms, ['trae']);
  deepEqual(byPlatform.get('trae-cn')?.affectedPlatforms, ['trae'], 'trae-cn 归并 trae 平台');
});

test('affectedPlatforms：~/.agents universal = 全部 agent 平台', () => {
  const shared = REGISTRY.find((r) => r.platform === 'shared');
  ok(shared);
  deepEqual(shared!.affectedPlatforms, [
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
  ]);
});
