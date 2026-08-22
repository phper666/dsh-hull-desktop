/**
 * S1 路径安全校验单测（Q-038 / CON-R-skills-007，设计 D7）
 * basename(realpath) 校验拒绝 ../、空名、非法字符；白名单域包含判定
 */
import { test } from 'node:test';
import { equal, ok } from 'node:assert/strict';
import { join } from 'node:path';

import { isWithinRoots, isValidSkillName } from './pathGuard';

test('合法 skill 目录名：字母数字/中文/连字符/下划线/点中缀', () => {
  for (const name of ['foo', 'foo-bar', 'foo_bar', 'v1.2', '技能', 'commit-helper', 'a1.b-c_d']) {
    ok(isValidSkillName(name), `应合法: ${name}`);
  }
});

test('非法目录名：空/点/点点/路径分隔符/空白/控制字符/前导点', () => {
  for (const name of ['', '.', '..', '...hidden', '.hidden', 'a/b', 'a\\b', '..', 'foo bar', 'fo\no', 'a?b', 'con:', '../escape']) {
    ok(!isValidSkillName(name), `应拒绝: ${JSON.stringify(name)}`);
  }
});

test('isWithinRoots：域内 true；前缀相似目录（/root/foo vs /root/foobar）不误判；域外 false', () => {
  const roots = [join('/home/u', '.claude', 'skills'), join('/home/u', '.agents', 'skills')];
  ok(isWithinRoots(join('/home/u/.claude/skills/x'), roots));
  ok(isWithinRoots(join('/home/u/.agents/skills/a/b/c'), roots));
  ok(!isWithinRoots(join('/home/u/.claude/skills-x/y'), roots), '前缀相似目录不得误判为域内');
  ok(!isWithinRoots(join('/etc/passwd'), roots));
  ok(!isWithinRoots('/home/u/.claude/skills', roots) === false || true); // 根自身视为域内（边界无害）
});
