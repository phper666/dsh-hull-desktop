import { test, after } from 'node:test';
import { equal, match, ok, throws } from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { NotesStore } from './NotesStore';
import { resolveSafeNotePath } from './pathGuard';

const tempDirs: string[] = [];
after(() => {
  for (const d of tempDirs) rmSync(d, { recursive: true, force: true });
});

function makeRoot(): { store: NotesStore; root: string } {
  const root = mkdtempSync(join(tmpdir(), 'hull-notes-store-'));
  tempDirs.push(root);
  return { store: new NotesStore({ root }), root };
}

/** 预置一篇笔记并返回 { relPath, mtime 基线 } */
function seed(store: NotesStore, relPath: string, content: string): string {
  const abs = resolveSafeNotePath(store.getRoot(), relPath);
  writeFileSync(abs, content, 'utf8');
  return statSync(abs).mtime.toISOString();
}

test('get：全文 + frontmatter + mtime 基线', () => {
  const { store } = makeRoot();
  const mtime = seed(store, 'a.md', '---\ntitle: A\n---\n\nbody here');
  const d = store.get('a.md');
  equal(d.path, 'a.md');
  equal(d.content, '---\ntitle: A\n---\n\nbody here');
  equal(d.frontmatter.title, 'A');
  equal(d.mtime, mtime);
});

test('get：不存在 → notes-not-found', () => {
  const { store } = makeRoot();
  throws(() => store.get('missing.md'), (e: unknown) => (e as { code: string }).code === 'notes-not-found');
});

test('save 缺省：mtime 一致 → 落盘成功，响应 mtime 为新基线（T1-03）', () => {
  const { store } = makeRoot();
  const mtime = seed(store, 'a.md', 'old');
  const out = store.save({ path: 'a.md', content: 'new content', expectedMtime: mtime });
  equal(out.path, 'a.md');
  equal(readFileSync(join(store.getRoot(), 'a.md'), 'utf8'), 'new content');
  ok(new Date(out.mtime).getTime() >= new Date(mtime).getTime());
  ok(!existsSync(join(store.getRoot(), 'a.md.tmp')), '原子写无 .tmp 残留');
});

test('save 缺省：外部改动 → notes-conflict-modified 携 detected.diskMtime，磁盘零改动（T2-01）', () => {
  const { store } = makeRoot();
  seed(store, 'a.md', 'v1');
  utimesSync(join(store.getRoot(), 'a.md'), new Date(), new Date(Date.now() + 5000)); // mtime 推移
  const oldMtime = new Date(Date.now() - 10000).toISOString();
  try {
    store.save({ path: 'a.md', content: 'v2', expectedMtime: oldMtime });
    ok(false, '应抛冲突');
  } catch (err) {
    const e = err as { code: string; detected?: { diskMtime: string } };
    equal(e.code, 'notes-conflict-modified');
    ok(typeof e.detected?.diskMtime === 'string' && e.detected.diskMtime.length > 0);
  }
  equal(readFileSync(join(store.getRoot(), 'a.md'), 'utf8'), 'v1', '磁盘零改动');
});

test('save 缺省：文件已删 → notes-conflict-deleted，不静默重建（T2-02）', () => {
  const { store } = makeRoot();
  throws(
    () => store.save({ path: 'gone.md', content: 'x', expectedMtime: new Date().toISOString() }),
    (e: unknown) => (e as { code: string }).code === 'notes-conflict-deleted'
  );
  ok(!existsSync(join(store.getRoot(), 'gone.md')));
});

test('save overwrite：跳过 mtime 校验覆盖；文件已删仍拒（T2-03）', () => {
  const { store } = makeRoot();
  seed(store, 'a.md', 'v1');
  store.save({ path: 'a.md', content: 'overwritten', expectedMtime: 'bogus', strategy: 'overwrite' });
  equal(readFileSync(join(store.getRoot(), 'a.md'), 'utf8'), 'overwritten');
  throws(
    () => store.save({ path: 'gone.md', content: 'x', expectedMtime: '', strategy: 'overwrite' }),
    (e: unknown) => (e as { code: string }).code === 'notes-conflict-deleted'
  );
});

test('save saveAsCopy：原路径不动，生成 `<基名> (冲突副本 YYYY-MM-DD).md`（T1-07）', () => {
  const { store } = makeRoot();
  seed(store, 'a.md', 'disk version');
  const date = new Date().toISOString().slice(0, 10);
  const out = store.save({ path: 'a.md', content: 'my version', expectedMtime: 'stale', strategy: 'saveAsCopy' });
  equal(readFileSync(join(store.getRoot(), 'a.md'), 'utf8'), 'disk version', '原路径不动');
  equal(out.path, `a (冲突副本 ${date}).md`);
  equal(readFileSync(join(store.getRoot(), out.path), 'utf8'), 'my version');
});

test('save saveAsCopy：同名副本已存在 → 追加序号 2（TBD 建议实现）', () => {
  const { store } = makeRoot();
  seed(store, 'a.md', 'disk');
  const date = new Date().toISOString().slice(0, 10);
  writeFileSync(join(store.getRoot(), `a (冲突副本 ${date}).md`), 'already');
  const out = store.save({ path: 'a.md', content: 'mine', expectedMtime: 'x', strategy: 'saveAsCopy' });
  equal(out.path, `a (冲突副本 ${date}) 2.md`);
});

test('save 携 frontmatterPatch：patch 生效落盘', () => {
  const { store } = makeRoot();
  const mtime = seed(store, 'a.md', '---\ntitle: A\ncustom: keep\n---\n\nbody');
  store.save({ path: 'a.md', content: '---\ntitle: A\ncustom: keep\n---\n\nbody', expectedMtime: mtime, frontmatterPatch: { task: 'ts_1' } });
  const written = readFileSync(join(store.getRoot(), 'a.md'), 'utf8');
  match(written, /task: ts_1/);
  match(written, /custom: keep/);
});

test('create：YYYY-MM-DD-<slug>.md + frontmatter title 预写', () => {
  const { store } = makeRoot();
  const out = store.create(undefined, '会议纪要 Go');
  const date = new Date().toISOString().slice(0, 10);
  equal(out.path, `${date}-会议纪要-Go.md`);
  match(readFileSync(join(store.getRoot(), out.path), 'utf8'), /title: 会议纪要 Go/);
});

test('create：slug 空 → 时间戳序号；同名 → notes-name-conflict 不覆盖（T2-05）', () => {
  const { store } = makeRoot();
  const out1 = store.create(undefined, '!!!');
  ok(/^\d{4}-\d{2}-\d{2}-\d+\.md$/.test(out1.path), `实际 ${out1.path}`);
  // 时间戳序号：连续两次均成功且不同名（时间戳推进）
  const out2 = store.create(undefined, '!!!');
  ok(out2.path !== out1.path);
  // 固定 slug：同名 → 冲突
  store.create(undefined, 'hello');
  throws(
    () => store.create(undefined, 'hello'),
    (e: unknown) => (e as { code: string }).code === 'notes-name-conflict'
  );
});

test('move：磁盘 rename 到已存在子目录；目标同名 → notes-name-conflict', () => {
  const { store, root } = makeRoot();
  seed(store, 'b.md', 'content');
  mkdirSub(root, 'target');
  const moved = store.move('b.md', 'target');
  equal(moved.path, 'target/b.md');
  equal(readFileSync(join(root, 'target', 'b.md'), 'utf8'), 'content');
  ok(!existsSync(join(root, 'b.md')));
  // 同名冲突
  seed(store, 'c.md', 'x');
  seed(store, 'target/c.md', 'y');
  throws(
    () => store.move('c.md', 'target'),
    (e: unknown) => (e as { code: string }).code === 'notes-name-conflict'
  );
});

test('onWrite 回调：写盘成功后带绝对路径触发（回声抑制/索引联动挂点）', () => {
  const { store } = makeRoot();
  const seen: string[] = [];
  store.onWrite = (abs) => seen.push(abs);
  const mtime = seed(store, 'a.md', 'x');
  store.save({ path: 'a.md', content: 'y', expectedMtime: mtime });
  equal(seen.length, 1);
  ok(seen[0].endsWith('a.md'));
});

function mkdirSub(root: string, name: string): void {
  mkdirSync(join(root, name), { recursive: true });
}
