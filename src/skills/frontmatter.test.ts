/**
 * S1 SKILL.md frontmatter 最小解析器单测（设计 D3 / 共识 §7.2）
 * 有效解析 / 缺失降级 / 坏 YAML 不抛错
 */
import { test } from 'node:test';
import { deepEqual, equal } from 'node:assert/strict';

import { parseFrontmatter } from './frontmatter';

test('标准 frontmatter 全字段解析（T6）', () => {
  const md = [
    '---',
    'name: commit-helper',
    'description: 生成规范提交信息',
    'license: MIT',
    'compatibility: opencode >= 1.0',
    'metadata:',
    '  source: https://github.com/o/r',
    '  author: phper666',
    '---',
    '# 正文',
  ].join('\n');
  const fm = parseFrontmatter(md);
  equal(fm.name, 'commit-helper');
  equal(fm.description, '生成规范提交信息');
  equal(fm.license, 'MIT');
  equal(fm.compatibility, 'opencode >= 1.0');
  deepEqual(fm.metadata, { source: 'https://github.com/o/r', author: 'phper666' });
});

test('无 frontmatter（缺 --- 开头）→ 全 null 不抛错（T7）', () => {
  const fm = parseFrontmatter('# 只有正文\n没有元数据');
  equal(fm.name, null);
  equal(fm.description, null);
  equal(fm.license, null);
  equal(fm.compatibility, null);
  deepEqual(fm.metadata, {});
});

test('坏 YAML 行跳过不抛错，其余字段保留（T7）', () => {
  const md = ['---', 'name: x', '这行没有冒号是坏的', 'description: y', '---'].join('\n');
  const fm = parseFrontmatter(md);
  equal(fm.name, 'x');
  equal(fm.description, 'y');
});

test('引号值剥离', () => {
  const md = ['---', "name: 'quoted'", 'description: "double quoted"', '---'].join('\n');
  const fm = parseFrontmatter(md);
  equal(fm.name, 'quoted');
  equal(fm.description, 'double quoted');
});

test('块标量 description（|）多行合并为空格连接', () => {
  const md = ['---', 'description: |', '  第一行', '  第二行', 'name: blk', '---'].join('\n');
  const fm = parseFrontmatter(md);
  equal(fm.description, '第一行 第二行');
  equal(fm.name, 'blk');
});

test('空内容 / 空白输入 → 全 null', () => {
  for (const input of ['', '   \n  ', '---', '---\n---']) {
    const fm = parseFrontmatter(input);
    equal(fm.name, null, `input=${JSON.stringify(input)}`);
    equal(fm.description, null);
  }
});
