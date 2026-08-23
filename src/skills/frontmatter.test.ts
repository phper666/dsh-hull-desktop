/**
 * S1 SKILL.md frontmatter 最小解析器单测（设计 D3 / 共识 §7.2）
 * 有效解析 / 缺失降级 / 坏 YAML 不抛错
 */
import { test } from 'node:test';
import { deepEqual, equal } from 'node:assert/strict';

import { parseFrontmatter, setMetadataSource } from './frontmatter';

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

// ── setMetadataSource（O-3 本地来源可填）──

test('无 metadata 块 → 在闭合前插入 metadata: + source 行，不破坏其它字段', () => {
  const input = '---\nname: foo\ndescription: "desc"\n---\nbody';
  const out = setMetadataSource(input, 'https://github.com/o/r');
  const fm = parseFrontmatter(out);
  equal(fm.name, 'foo');
  equal(fm.metadata.source, 'https://github.com/o/r');
  // 其它字段保留 + 正文保留
  equal(out.includes('description: "desc"'), true);
  equal(out.endsWith('body'), true);
});

test('已有 metadata 无 source → source 行追加进 metadata 块', () => {
  const input = '---\nname: foo\nmetadata:\n  requires:\n    bins: ["x"]\n---\n';
  const out = setMetadataSource(input, 'https://github.com/o/r');
  equal(parseFrontmatter(out).metadata.source, 'https://github.com/o/r');
  // requires 保留
  equal(out.includes('requires:'), true);
});

test('已有 metadata.source → 原位替换', () => {
  const input = '---\nname: foo\nmetadata:\n  source: https://old.example\n---\n';
  const out = setMetadataSource(input, 'https://github.com/o/r');
  equal(parseFrontmatter(out).metadata.source, 'https://github.com/o/r');
  equal(out.includes('https://old.example'), false);
});

test('无 frontmatter（非 --- 开头）→ 原样返回不写', () => {
  const input = '# Not a skill frontmatter\nplain text';
  equal(setMetadataSource(input, 'https://github.com/o/r'), input);
});
