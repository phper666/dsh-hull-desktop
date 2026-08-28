/**
 * P0-2 SKILL.md 健康度 lint 单测（设计决策 6，docs/design/SK-1-升级检测增强-skills-upgrade-design.md）
 * warn：无 frontmatter/缺 name、缺 description、description>1024；
 * info：无 metadata.source、source 非 https 形态。level = 最高严重级；issues = 全部命中项。
 */
import { test } from 'node:test';
import { deepEqual, equal, ok } from 'node:assert/strict';

import { parseFrontmatter } from './frontmatter';
import { lintSkill } from './lint';

test('无 frontmatter（空内容）→ warn（name+description）+ info（source）', () => {
  const r = lintSkill(parseFrontmatter(''));
  equal(r.level, 'warn');
  ok(r.issues.some((i) => i.includes('name')));
  ok(r.issues.some((i) => i.includes('description')));
  ok(r.issues.some((i) => i.includes('source')));
});

test('缺 name → warn', () => {
  const r = lintSkill(parseFrontmatter('---\ndescription: 有描述\n---'));
  equal(r.level, 'warn');
  ok(r.issues.some((i) => i.includes('name')));
});

test('缺 description / 空 description → warn', () => {
  for (const content of ['---\nname: x\n---', '---\nname: x\ndescription:\n---']) {
    const r = lintSkill(parseFrontmatter(content));
    equal(r.level, 'warn');
    ok(r.issues.some((i) => i.includes('description')));
  }
});

test('description > 1024 字符 → warn', () => {
  const r = lintSkill(parseFrontmatter(`---\nname: x\ndescription: ${'d'.repeat(1025)}\n---`));
  equal(r.level, 'warn');
  ok(r.issues.some((i) => i.includes('1024')));
});

test('description 恰好 1024 → 无 warn', () => {
  const r = lintSkill(parseFrontmatter(`---\nname: x\ndescription: ${'d'.repeat(1024)}\nmetadata:\n  source: https://github.com/o/r\n---`));
  equal(r.level, null);
  deepEqual(r.issues, []);
});

test('无 metadata.source → info', () => {
  const r = lintSkill(parseFrontmatter('---\nname: x\ndescription: ok\n---'));
  equal(r.level, 'info');
  ok(r.issues.some((i) => i.includes('source')));
});

test('source 非 https 形态 → info', () => {
  const r = lintSkill(parseFrontmatter('---\nname: x\ndescription: ok\nmetadata:\n  source: git://foo\n---'));
  equal(r.level, 'info');
  ok(r.issues.some((i) => i.includes('source')));
});

test('健康条目 → level null + issues 空', () => {
  const r = lintSkill(parseFrontmatter('---\nname: x\ndescription: ok\nmetadata:\n  source: https://github.com/o/r\n---'));
  equal(r.level, null);
  deepEqual(r.issues, []);
});

test('warn + info 并存 → level=warn，issues 全列', () => {
  const r = lintSkill(parseFrontmatter('---\ndescription:\n---')); // 缺 name + 缺 desc + 无 source
  equal(r.level, 'warn');
  equal(r.issues.length, 3);
});
