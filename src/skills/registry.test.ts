/**
 * S1 注册表单测（CON-R-skills-001，设计 D1）
 * 十九目录硬编码单点：目录映射 + opencode 多目录读取特殊处理（affectedPlatforms 数据驱动）
 * v1.5 平台扩展：windsurf/warp/trae(+cn)/cline/roo/continue/devin
 * v1.6 平台扩展：dsh/harness/qoder(+cn)/reasonix
 */
import { test } from 'node:test';
import { deepEqual, equal, ok } from 'node:assert/strict';

import { REGISTRY } from './registry';

test('注册表 18 条目：平台与目录映射正确（CON-R-skills-001）', () => {
  equal(REGISTRY.length, 18);
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
  equal(byPlatform.get('dsh')?.dir, '.dsh/skills');
  equal(byPlatform.get('qoder')?.dir, '.qoder/skills');
  equal(byPlatform.get('qoder-cn')?.dir, '.qoder-cn/skills');
  equal(byPlatform.get('reasonix')?.dir, '.reasonix/skills');
  equal(byPlatform.get('shared')?.dir, '.agents/skills');
});

test('affectedPlatforms：~/.claude 含 claude-code+opencode+cursor+warp；~/.config/opencode 仅 opencode（CON-R-skills-002，2026-08-27 校验）', () => {
  const byPlatform = new Map(REGISTRY.map((r) => [r.platform, r]));
  deepEqual(byPlatform.get('claude-code')?.affectedPlatforms, ['claude-code', 'opencode', 'cursor', 'warp']);
  deepEqual(byPlatform.get('opencode')?.affectedPlatforms, ['opencode']);
  deepEqual(byPlatform.get('codex')?.affectedPlatforms, ['codex', 'cursor', 'warp'], 'cursor/warp 官方声明读 ~/.codex/skills');
});

test('affectedPlatforms：单平台专属；trae-cn/qoder-cn 归并主平台；windsurf/devin 同产品互读（CON-R-skills-002）', () => {
  const byPlatform = new Map(REGISTRY.map((r) => [r.platform, r]));
  for (const p of ['gemini-cli', 'cursor', 'warp', 'cline', 'roo', 'continue', 'dsh', 'reasonix']) {
    deepEqual(byPlatform.get(p)?.affectedPlatforms, [p]);
  }
  deepEqual(byPlatform.get('windsurf')?.affectedPlatforms, ['windsurf', 'devin'], 'devin 同产品读 ~/.codeium/windsurf/skills');
  deepEqual(byPlatform.get('devin')?.affectedPlatforms, ['devin', 'windsurf'], 'windsurf 同产品读 ~/.config/devin/skills');
  deepEqual(byPlatform.get('trae')?.affectedPlatforms, ['trae']);
  deepEqual(byPlatform.get('trae-cn')?.affectedPlatforms, ['trae'], 'trae-cn 归并 trae 平台');
  deepEqual(byPlatform.get('qoder')?.affectedPlatforms, ['qoder']);
  deepEqual(byPlatform.get('qoder-cn')?.affectedPlatforms, ['qoder'], 'qoder-cn 归并 qoder 平台');
});

test('affectedPlatforms：~/.agents 共享 = 确认读者集合（2026-08-27 官方校验；claude-code/continue 确认不读，trae/qoder/reasonix 未声明）', () => {
  const shared = REGISTRY.find((r) => r.platform === 'shared');
  ok(shared);
  deepEqual(shared!.affectedPlatforms, [
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
  ]);
});
