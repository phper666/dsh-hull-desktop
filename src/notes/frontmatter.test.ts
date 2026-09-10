import { test } from 'node:test';
import { deepEqual, equal, match, ok } from 'node:assert/strict';

import { applyFrontmatterPatch, parseNoteFrontmatter } from './frontmatter';

test('解析：四键提取 + 未知键忽略', () => {
  const r = parseNoteFrontmatter('---\ntitle: Hello\ntype: daily\ntask: ts_1\ntags: [a, b]\nunknown: keep\n---\n\nbody');
  equal(r.hasBlock, true);
  equal(r.fm.title, 'Hello');
  equal(r.fm.type, 'daily');
  equal(r.fm.task, 'ts_1');
  deepEqual(r.fm.tags, ['a', 'b']);
});

test('解析：引号剥离 + tags 纯文本逗号', () => {
  const r = parseNoteFrontmatter('---\ntitle: "quoted"\ntags: a, b\n---\nbody');
  equal(r.fm.title, 'quoted');
  deepEqual(r.fm.tags, ['a', 'b']);
});

test('解析：无 frontmatter / 未闭合 → hasBlock=false，三键为空', () => {
  equal(parseNoteFrontmatter('just body').hasBlock, false);
  equal(parseNoteFrontmatter('---\ntitle: x\n\nbody unclosed').hasBlock, false);
});

test('解析失败容忍：坏行跳过永不抛错（CON-R-notes-005）', () => {
  const r = parseNoteFrontmatter('---\nno colon line\ntitle: kept\n: bad\n---\nbody');
  equal(r.hasBlock, true);
  equal(r.fm.title, 'kept');
});

test('回写：键级替换，未知键与键序保留（CON-R-notes-005/T1-04）', () => {
  const src = '---\ntitle: Old\ncustom: keep\ntype: daily\n---\n\n# body';
  const out = applyFrontmatterPatch(src, { title: 'New' });
  equal(out, '---\ntitle: New\ncustom: keep\ntype: daily\n---\n\n# body');
});

test('回写：键不存在 → 闭合 --- 前追加', () => {
  const out = applyFrontmatterPatch('---\ntitle: T\n---\nbody', { task: 'ts_9' });
  equal(out, '---\ntitle: T\ntask: ts_9\n---\nbody');
});

test('回写：task:null 清除键行；无该键则无变化', () => {
  equal(applyFrontmatterPatch('---\ntitle: T\ntask: ts_1\n---\nbody', { task: null }), '---\ntitle: T\n---\nbody');
  equal(applyFrontmatterPatch('---\ntitle: T\n---\nbody', { task: null }), '---\ntitle: T\n---\nbody');
});

test('回写：tags 数组 → 行内 [a, b] 文本（不引 YAML）', () => {
  const out = applyFrontmatterPatch('---\ntitle: T\n---\nbody', { tags: ['a', 'b'] });
  equal(out, '---\ntitle: T\ntags: [a, b]\n---\nbody');
});

test('回写：无 frontmatter → 文件头注入新块，正文逐字节不动（T1-05）', () => {
  const body = '# 正文\n\nline2';
  const out = applyFrontmatterPatch(body, { title: 'N', type: 'daily' });
  equal(out, '---\ntitle: N\ntype: daily\n---\n\n# 正文\n\nline2');
});

test('回写：解析失败（未闭合块）→ 头注入新块，原内容原样保留在正文', () => {
  const src = '---\ntitle: broken\n\n正文未闭合';
  const out = applyFrontmatterPatch(src, { task: 'ts_2' });
  equal(out, '---\ntask: ts_2\n---\n\n---\ntitle: broken\n\n正文未闭合');
});

test('回写：空 patch 原样返回（仅换行归一）', () => {
  equal(applyFrontmatterPatch('---\ntitle: T\n---\nbody', {}), '---\ntitle: T\n---\nbody');
});

test('块边界统一：------ 不算闭合（解析面 + 回写面口径一致，oracle 🟡6）', () => {
  // 解析面：无整行闭合 → hasBlock=false（三键视为空）
  const r = parseNoteFrontmatter('---\ntitle: x\n------\nbody');
  equal(r.hasBlock, false);
  equal(r.fm.title, null);
  // 回写面：同口径 → 头注入新块而非误改 '------' 块
  const out = applyFrontmatterPatch('---\ntitle: x\n------\nbody', { task: 'ts_1' });
  ok(out.startsWith('---\ntask: ts_1\n---\n'));
  // 正常闭合不受影响
  equal(parseNoteFrontmatter('---\ntitle: y\n---\nbody').fm.title, 'y');
});

test('回写 key 正则元字符转义（oracle 🟡5）：键含 . 等不炸不误匹配', () => {
  const src = '---\ntitle: T\na.b: keepme\n---\nbody';
  // 'a.b' 键（契约外的防御面）：定位替换应按字面匹配
  const out = applyFrontmatterPatch(src, { 'a.b': 'newval' } as never);
  match(out, /^a\.b: newval$/m);
  match(out, /title: T/);
});
