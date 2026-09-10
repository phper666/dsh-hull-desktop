import { test, after } from 'node:test';
import { deepEqual, equal, throws } from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { NotesScanner } from './NotesScanner';

const tempDirs: string[] = [];
after(() => {
  for (const d of tempDirs) rmSync(d, { recursive: true, force: true });
});

function makeRoot(files: Record<string, string>): { scanner: NotesScanner; root: string } {
  const root = mkdtempSync(join(tmpdir(), 'hull-notes-scan-'));
  tempDirs.push(root);
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(join(root, rel, '..'), { recursive: true });
    writeFileSync(join(root, rel), content, 'utf8');
  }
  return { scanner: new NotesScanner({ root }), root };
}

test('全量扫描：仅可见 .md 入索引；隐藏目录与 .trash 跳过（T1-02/T2-06 口径）', async () => {
  const { scanner } = makeRoot({
    'a.md': '---\ntitle: A\n---\n\nhello world',
    'sub/b.md': 'plain body only',
    '.hidden/x.md': 'skipped',
    'sub/.secret.md': 'skipped',
  });
  mkdirSync(join(scanner.getRoot(), '.trash'), { recursive: true });
  writeFileSync(join(scanner.getRoot(), '.trash', 'tr_x.md'), 'skipped');
  await scanner.scan();
  const { ready, entries } = scanner.indexPayload();
  equal(ready, true);
  deepEqual(entries.map((e) => e.path).sort(), ['a.md', 'sub/b.md']);
});

test('索引条目：title 回退基名 + snippet 换行折叠前 200 字符 + updatedAt ISO', async () => {
  const long = 'x'.repeat(300);
  const { scanner } = makeRoot({
    'b.md': `第一行\n第二行\n${long}`,
    'c.md': '---\nbadline\ntitle: C\n---\n\nbody', // 坏行跳过仍解析出 title
  });
  await scanner.scan();
  const { entries } = scanner.indexPayload();
  const b = entries.find((e) => e.path === 'b.md')!;
  equal(b.title, 'b');
  equal(b.snippet, `第一行 第二行 ${long}`.slice(0, 200));
  equal(new Date(b.updatedAt).toISOString(), b.updatedAt);
  const c = entries.find((e) => e.path === 'c.md')!;
  equal(c.title, 'C');
  equal(c.frontmatter.title, 'C');
});

test('frontmatter 解析失败 → 三键视为空，照常入索引并可搜索（T3-04/CON-R-notes-005）', async () => {
  const { scanner } = makeRoot({ 'bad.md': '---\nnot: [closed\n\n正文 needle here' });
  await scanner.scan();
  const { entries } = scanner.indexPayload();
  const bad = entries.find((e) => e.path === 'bad.md')!;
  equal(bad.frontmatter.title, null);
  equal(bad.frontmatter.type, null);
  equal(bad.frontmatter.task, null);
  equal(bad.frontmatter.tags, null);
  equal(bad.title, 'bad');
  const { entries: hits } = scanner.search('needle');
  equal(hits.length, 1);
});

test('search：标题+内容子串、大小写不敏感、updatedAt 倒序；空串 = 全部（T1-08）', async () => {
  const { scanner } = makeRoot({
    'old.md': '---\ntitle: Alpha Report\n---\n\nnothing',
    'new.md': '---\ntitle: Other\n---\n\ncontains ALPHA inside body',
  });
  await scanner.scan();
  // 让 updatedAt 可分序（同 ms 也稳定：倒序比较用字符串，mtime 可能同值——不强断言顺序依赖文件，仅断言命中与排序合法性）
  const { entries } = scanner.search('alpha');
  deepEqual(entries.map((e) => e.path).sort(), ['new.md', 'old.md']);
  const all = scanner.search('').entries;
  equal(all.length, 2);
  const sortedDesc = [...all].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  deepEqual(all, sortedDesc);
});

test('upsert/remove：watch 增量路径（新文件入索引、删除后出索引）', async () => {
  const { scanner, root } = makeRoot({ 'a.md': 'a content' });
  await scanner.scan();
  writeFileSync(join(root, 'new.md'), 'brand new marker');
  await scanner.upsert('new.md');
  equal(scanner.search('marker').entries.length, 1);
  scanner.remove('new.md');
  equal(scanner.search('marker').entries.length, 0);
  equal(scanner.indexPayload().entries.length, 1);
});

test('幂等 scan：scanning 中重入返回同一 Promise（对齐 SkillsScanner）', async () => {
  const { scanner } = makeRoot({ 'a.md': 'x' });
  const p1 = scanner.scan();
  const p2 = scanner.scan();
  equal(p1, p2);
  await p1;
  equal(scanner.getStatus(), 'ready');
});

test('根不可读 → degraded；indexPayload 抛 notes-scan-error', async () => {
  const root = mkdtempSync(join(tmpdir(), 'hull-notes-degraded-'));
  tempDirs.push(root);
  const scanner = new NotesScanner({ root });
  rmSync(root, { recursive: true, force: true });
  await scanner.scan();
  equal(scanner.getStatus(), 'degraded');
  throws(() => scanner.indexPayload(), (e: unknown) => (e as { code: string }).code === 'notes-scan-error');
  throws(() => scanner.search('x'), (e: unknown) => (e as { code: string }).code === 'notes-scan-error');
});
