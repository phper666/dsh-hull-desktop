import { test, after } from 'node:test';
import { equal, ok, throws } from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { NotesTrash } from './NotesTrash';

const tempDirs: string[] = [];
after(() => {
  for (const d of tempDirs) rmSync(d, { recursive: true, force: true });
});

const TTL_30D_MS = 30 * 24 * 3600 * 1000;
const CAP = 500 * 1024 * 1024;

function makeFixture(): { trash: NotesTrash; userDataPath: string; notesRoot: string; trashDir: string } {
  const userDataPath = mkdtempSync(join(tmpdir(), 'hull-notes-trash-'));
  tempDirs.push(userDataPath);
  const notesRoot = join(userDataPath, 'notes-src'); // 独立目录模拟 notes.dir
  mkdirSync(notesRoot, { recursive: true });
  const trash = new NotesTrash({ userDataPath });
  return { trash, userDataPath, notesRoot, trashDir: join(userDataPath, 'notes', '.trash') };
}

function seed(notesRoot: string, rel: string, content: string): void {
  mkdirSync(join(notesRoot, rel, '..'), { recursive: true });
  writeFileSync(join(notesRoot, rel), content, 'utf8');
}

/** 边界构造：改写 manifest 中条目的 deletedAt / sizeBytes（内部态与落盘同步） */
function patchEntry(trash: NotesTrash, id: string, patch: Partial<{ deletedAt: string; sizeBytes: number }>): void {
  const entries = (trash as unknown as { entries: Array<{ id: string } & Record<string, unknown>> }).entries;
  const entry = entries.find((e) => e.id === id)!;
  Object.assign(entry, patch);
  const manifestPath = (trash as unknown as { manifestPath: string }).manifestPath;
  writeFileSync(manifestPath, JSON.stringify({ entries }), 'utf8');
}

test('delete → 实体入 .trash/tr_<uuid>.md + manifest 四字段正确（T1-06）', () => {
  const { trash, notesRoot, trashDir } = makeFixture();
  seed(notesRoot, 'a.md', 'content-a');
  const { trashId } = trash.deleteFromNotes(notesRoot, 'a.md');
  ok(/^tr_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(trashId));
  ok(existsSync(join(trashDir, `${trashId}.md`)));
  equal(readFileSync(join(trashDir, `${trashId}.md`), 'utf8'), 'content-a');
  ok(!existsSync(join(notesRoot, 'a.md')));
  const e = trash.list().entries.find((x) => x.id === trashId)!;
  equal(e.originalPath, 'a.md');
  equal(typeof Date.parse(e.deletedAt), 'number');
  equal(e.sizeBytes, Buffer.byteLength('content-a'));
});

test('restore：rename 回原相对路径，内容原样；条目移除（T1-06）', () => {
  const { trash, notesRoot } = makeFixture();
  seed(notesRoot, 'sub/a.md', 'body');
  const { trashId } = trash.deleteFromNotes(notesRoot, 'sub/a.md');
  const { restoredPath } = trash.restore(trashId, notesRoot);
  equal(restoredPath, 'sub/a.md');
  equal(readFileSync(join(notesRoot, 'sub/a.md'), 'utf8'), 'body');
  equal(trash.list().entries.length, 0);
});

test('restore 冲突：目标被占用 → notes-restore-conflict 携 targetPath，不覆盖、条目保留（T2-04）', () => {
  const { trash, notesRoot } = makeFixture();
  seed(notesRoot, 'a.md', 'orig');
  const { trashId } = trash.deleteFromNotes(notesRoot, 'a.md');
  seed(notesRoot, 'a.md', 'occupied');
  try {
    trash.restore(trashId, notesRoot);
    ok(false, '应抛冲突');
  } catch (err) {
    const e = err as { code: string; targetPath?: string };
    equal(e.code, 'notes-restore-conflict');
    equal(e.targetPath, 'a.md');
  }
  equal(readFileSync(join(notesRoot, 'a.md'), 'utf8'), 'occupied', '占用文件零改动');
  equal(trash.list().entries.length, 1, '条目保留');
});

test('purge：实体删除 + manifest 移除；二次 purge → notes-not-found；实体丢失仍幂等收敛', () => {
  const { trash, notesRoot, trashDir } = makeFixture();
  seed(notesRoot, 'a.md', 'x');
  const { trashId } = trash.deleteFromNotes(notesRoot, 'a.md');
  equal(Object.keys(trash.purge(trashId)).length, 0);
  ok(!existsSync(join(trashDir, `${trashId}.md`)));
  throws(
    () => trash.purge(trashId),
    (e: unknown) => (e as { code: string }).code === 'notes-not-found'
  );
  // 实体丢失 → 仍移除 manifest
  seed(notesRoot, 'b.md', 'y');
  const r2 = trash.deleteFromNotes(notesRoot, 'b.md');
  rmSync(join(trashDir, `${r2.trashId}.md`));
  trash.purge(r2.trashId);
  equal(trash.list().entries.length, 0);
});

test('trashId 非法 → notes-not-found（白名单 ^tr_<uuid>$）', () => {
  const { trash } = makeFixture();
  throws(
    () => trash.restore('../evil', '/tmp'),
    (e: unknown) => (e as { code: string }).code === 'notes-not-found'
  );
  throws(
    () => trash.purge('tr_not-a-uuid'),
    (e: unknown) => (e as { code: string }).code === 'notes-not-found'
  );
});

test('TTL：恰好 30 天算过期被清；不足 30 天不清（T3-05）', () => {
  const { trash, notesRoot } = makeFixture();
  seed(notesRoot, 'expired.md', 'old');
  seed(notesRoot, 'fresh.md', 'new');
  const expired = trash.deleteFromNotes(notesRoot, 'expired.md');
  const fresh = trash.deleteFromNotes(notesRoot, 'fresh.md');
  patchEntry(trash, expired.trashId, { deletedAt: new Date(Date.now() - TTL_30D_MS).toISOString() });
  patchEntry(trash, fresh.trashId, { deletedAt: new Date(Date.now() - (TTL_30D_MS - 60_000)).toISOString() });
  trash.cleanup();
  const after = trash.list().entries.map((e) => e.id);
  ok(!after.includes(expired.trashId), '恰好 30 天应被清');
  ok(after.includes(fresh.trashId), '不足 30 天应保留');
});

test('容量：总容量 >500MB 循环删 deletedAt 最旧至 <500MB，manifest 同步（T3-06）', () => {
  const { trash, notesRoot } = makeFixture();
  seed(notesRoot, 'oldest.md', 'a');
  seed(notesRoot, 'middle.md', 'b');
  seed(notesRoot, 'newest.md', 'c');
  const ids = [
    trash.deleteFromNotes(notesRoot, 'oldest.md').trashId,
    trash.deleteFromNotes(notesRoot, 'middle.md').trashId,
    trash.deleteFromNotes(notesRoot, 'newest.md').trashId,
  ];
  patchEntry(trash, ids[0], { deletedAt: new Date(Date.now() - 3 * 24 * 3600 * 1000).toISOString(), sizeBytes: 300 * 1024 * 1024 });
  patchEntry(trash, ids[1], { deletedAt: new Date(Date.now() - 2 * 24 * 3600 * 1000).toISOString(), sizeBytes: 300 * 1024 * 1024 });
  patchEntry(trash, ids[2], { deletedAt: new Date(Date.now() - 1 * 24 * 3600 * 1000).toISOString(), sizeBytes: 300 * 1024 * 1024 });
  trash.cleanup(); // 900MB → 删最旧两条至 300MB < 500MB
  const after = trash.list();
  ok(after.totalSizeBytes < CAP);
  ok(!after.entries.some((e) => e.id === ids[0]), '最旧先删');
  ok(!after.entries.some((e) => e.id === ids[1]), '次旧删至阈值下');
  ok(after.entries.some((e) => e.id === ids[2]), '最新保留');
});

test('manifest 损坏 → 备份 corrupt-<ts> + 重建空清单，壳不崩（T2-07）', () => {
  const { userDataPath, notesRoot } = makeFixture();
  writeFileSync(join(userDataPath, 'notes', 'trash.json'), '{broken json', 'utf8');
  const trash2 = new NotesTrash({ userDataPath });
  equal(trash2.list().entries.length, 0);
  ok(
    readdirSync(join(userDataPath, 'notes')).some((f) => f.startsWith('trash.json.corrupt-')),
    '应存在 corrupt 备份'
  );
  // 损坏后可正常 delete/restore
  seed(notesRoot, 'c.md', 'ok');
  const { trashId } = trash2.deleteFromNotes(notesRoot, 'c.md');
  trash2.restore(trashId, notesRoot);
  ok(existsSync(join(notesRoot, 'c.md')));
});

test('trash.json 原子写：无 .tmp 残留', () => {
  const { userDataPath, notesRoot, trash } = makeFixture();
  seed(notesRoot, 'a.md', 'x');
  trash.deleteFromNotes(notesRoot, 'a.md');
  ok(!existsSync(join(userDataPath, 'notes', 'trash.json.tmp')));
});
