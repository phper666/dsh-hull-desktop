import { test, after } from 'node:test';
import { deepEqual, equal } from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { mergeNotes } from './notes';

const dirs: string[] = [];
after(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

function tmp(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}

function writeTree(root: string, files: Record<string, string>): void {
  for (const [rel, content] of Object.entries(files)) {
    const p = join(root, rel);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, content);
  }
}

const NOW = () => new Date(2026, 8, 18, 12, 30, 45); // 本地时间 → 20260918-123045
const STAMP = '20260918-123045';

test('notes：不存在拷入 / 同 hash 跳过 / 不同内容包内落冲突名（本地保留原名）', () => {
  const userData = tmp('hull-merge-notes-');
  const backup = tmp('hull-merge-bak-');
  const incoming = tmp('hull-merge-inc-');
  writeTree(join(userData, 'notes'), {
    'keep.md': 'K',
    'same.md': 'S',
    'conflict.md': 'PACK',
    'sub/deep.md': 'PACK-DEEP',
  });
  writeTree(join(backup, 'notes'), {
    'same.md': 'S',
    'conflict.md': 'LOCAL',
    'sub/deep.md': 'LOCAL-DEEP',
    'added.md': 'LOCAL-ADDED',
  });
  writeTree(join(incoming, 'notes'), { 'conflict.md': 'PACK', 'sub/deep.md': 'PACK-DEEP' });

  const { report } = mergeNotes({
    userDataPath: userData,
    backupNotesRoot: join(backup, 'notes'),
    incomingNotesRoot: join(incoming, 'notes'),
    now: NOW,
  });

  const notes = join(userData, 'notes');
  equal(readFileSync(join(notes, 'keep.md'), 'utf8'), 'K');
  equal(readFileSync(join(notes, 'same.md'), 'utf8'), 'S');
  equal(readFileSync(join(notes, 'conflict.md'), 'utf8'), 'LOCAL');
  equal(readFileSync(join(notes, `conflict (恢复冲突 ${STAMP}).md`), 'utf8'), 'PACK');
  equal(readFileSync(join(notes, 'sub/deep.md'), 'utf8'), 'LOCAL-DEEP');
  equal(readFileSync(join(notes, `sub/deep (恢复冲突 ${STAMP}).md`), 'utf8'), 'PACK-DEEP');
  equal(readFileSync(join(notes, 'added.md'), 'utf8'), 'LOCAL-ADDED');

  deepEqual(report.classes.note, { added: 1, updated: 2, skipped: 1 });
  equal(report.conflicts.filter((c) => c.resolution === 'renamed').length, 2);
  equal(report.conflicts.filter((c) => c.resolution === 'skipped-identical').length, 1);
  equal(report.conflicts.find((c) => c.resolution === 'renamed')!.kind, 'note');
});

test('notes：冲突名重名递增 -2（首份冲突文件不动）', () => {
  const userData = tmp('hull-merge-notes2-');
  const backup = tmp('hull-merge-bak2-');
  const incoming = tmp('hull-merge-inc2-');
  writeTree(join(userData, 'notes'), {
    'a.md': 'PACK2',
    [`a (恢复冲突 ${STAMP}).md`]: 'OLDER',
  });
  writeTree(join(backup, 'notes'), { 'a.md': 'LOCAL2' });
  writeTree(join(incoming, 'notes'), { 'a.md': 'PACK2' });

  mergeNotes({ userDataPath: userData, backupNotesRoot: join(backup, 'notes'), incomingNotesRoot: join(incoming, 'notes'), now: NOW });

  const notes = join(userData, 'notes');
  equal(readFileSync(join(notes, 'a.md'), 'utf8'), 'LOCAL2');
  equal(readFileSync(join(notes, `a (恢复冲突 ${STAMP}).md`), 'utf8'), 'OLDER');
  equal(readFileSync(join(notes, `a (恢复冲突 ${STAMP})-2.md`), 'utf8'), 'PACK2');
});

test('notes 回收站：按 id 并集 + 实体缺失拷入 + deletedAt 顺序保留', () => {
  const userData = tmp('hull-merge-notes3-');
  const backup = tmp('hull-merge-bak3-');
  const incoming = tmp('hull-merge-inc3-');
  const t1 = { id: 'tr_1', originalPath: 'one.md', deletedAt: '2026-09-01T00:00:00.000Z', sizeBytes: 1 };
  const t2 = { id: 'tr_2', originalPath: 'two.md', deletedAt: '2026-09-02T00:00:00.000Z', sizeBytes: 2 };
  writeTree(join(userData, 'notes'), {
    'trash.json': JSON.stringify({ version: 1, entries: [t1] }),
    '.trash/tr_1.md': 'E1',
  });
  writeTree(join(backup, 'notes'), {
    'trash.json': JSON.stringify({ version: 1, entries: [t2] }),
    '.trash/tr_2.md': 'E2',
  });
  writeTree(join(incoming, 'notes'), { 'trash.json': JSON.stringify({ version: 1, entries: [t1] }) });

  const { report } = mergeNotes({
    userDataPath: userData,
    backupNotesRoot: join(backup, 'notes'),
    incomingNotesRoot: join(incoming, 'notes'),
    now: NOW,
  });

  const trash = JSON.parse(readFileSync(join(userData, 'notes', 'trash.json'), 'utf8')) as { entries: Array<{ id: string }> };
  deepEqual(trash.entries.map((e) => e.id), ['tr_1', 'tr_2']);
  equal(readFileSync(join(userData, 'notes', '.trash', 'tr_2.md'), 'utf8'), 'E2');
  equal(readFileSync(join(userData, 'notes', '.trash', 'tr_1.md'), 'utf8'), 'E1');
  equal(report.conflicts.filter((c) => c.resolution === 'appended').length, 1);
});

test('notes 回收站：缺 sizeBytes 的条目丢弃（对齐 NotesTrash 加载器口径，产出必可被下游加载）', () => {
  const userData = tmp('hull-merge-notes5-');
  const backup = tmp('hull-merge-bak5-');
  const incoming = tmp('hull-merge-inc5-');
  const t1 = { id: 'tr_1', originalPath: 'one.md', deletedAt: '2026-09-01T00:00:00.000Z', sizeBytes: 1 };
  const t2 = { id: 'tr_2', originalPath: 'two.md', deletedAt: '2026-09-02T00:00:00.000Z', sizeBytes: 2 };
  writeTree(join(userData, 'notes'), {
    'trash.json': JSON.stringify({ entries: [t1] }),
    '.trash/tr_1.md': 'E1',
  });
  writeTree(join(backup, 'notes'), {
    // t2 合法 + 缺 sizeBytes 的坏条目混在同一清单
    'trash.json': JSON.stringify({ entries: [t2, { id: 'tr_bad', originalPath: 'bad.md', deletedAt: '2026-09-03T00:00:00.000Z' }] }),
    '.trash/tr_2.md': 'E2',
  });
  writeTree(join(incoming, 'notes'), {
    'trash.json': JSON.stringify({ entries: [{ id: 'tr_bad2', originalPath: 'bad2.md', deletedAt: '2026-09-04T00:00:00.000Z' }] }),
  });

  mergeNotes({
    userDataPath: userData,
    backupNotesRoot: join(backup, 'notes'),
    incomingNotesRoot: join(incoming, 'notes'),
    now: NOW,
  });

  const trash = JSON.parse(readFileSync(join(userData, 'notes', 'trash.json'), 'utf8')) as {
    entries: Array<Record<string, unknown>>;
  };
  deepEqual(trash.entries.map((e) => e.id), ['tr_1', 'tr_2']); // tr_bad / tr_bad2 丢弃
  for (const e of trash.entries) {
    equal(typeof e.id, 'string');
    equal(typeof e.originalPath, 'string');
    equal(typeof e.deletedAt, 'string');
    equal(typeof e.sizeBytes, 'number');
  }
});

test('notes：backup 根不存在 → 无动作不崩', () => {
  const userData = tmp('hull-merge-notes4-');
  const backup = tmp('hull-merge-bak4-');
  const incoming = tmp('hull-merge-inc4-');
  writeTree(join(userData, 'notes'), { 'a.md': 'PACK' });
  const { report } = mergeNotes({
    userDataPath: userData,
    backupNotesRoot: join(backup, 'missing'),
    incomingNotesRoot: join(incoming, 'missing'),
    now: NOW,
  });
  deepEqual(report.classes.note, { added: 0, updated: 0, skipped: 0 });
  equal(existsSync(join(userData, 'notes', 'a.md')), true);
});

test('notes：冲突名重名递增 -3（既有冲突文件均不动）', () => {
  const userData = tmp('hull-merge-notes6-');
  const backup = tmp('hull-merge-bak6-');
  const incoming = tmp('hull-merge-inc6-');
  writeTree(join(userData, 'notes'), {
    'c.md': 'PACK',
    [`c (恢复冲突 ${STAMP}).md`]: 'OLD1',
    [`c (恢复冲突 ${STAMP})-2.md`]: 'OLD2',
  });
  writeTree(join(backup, 'notes'), { 'c.md': 'LOCAL' });
  writeTree(join(incoming, 'notes'), { 'c.md': 'PACK' });

  mergeNotes({ userDataPath: userData, backupNotesRoot: join(backup, 'notes'), incomingNotesRoot: join(incoming, 'notes'), now: NOW });

  const notes = join(userData, 'notes');
  equal(readFileSync(join(notes, 'c.md'), 'utf8'), 'LOCAL');
  equal(readFileSync(join(notes, `c (恢复冲突 ${STAMP}).md`), 'utf8'), 'OLD1');
  equal(readFileSync(join(notes, `c (恢复冲突 ${STAMP})-2.md`), 'utf8'), 'OLD2');
  equal(readFileSync(join(notes, `c (恢复冲突 ${STAMP})-3.md`), 'utf8'), 'PACK');
});

test('notes：incoming 与两侧均不同 → 包内版本另存冲突名；incoming 缺失 → 保留现内容', () => {
  const userData = tmp('hull-merge-notes7-');
  const backup = tmp('hull-merge-bak7-');
  const incoming = tmp('hull-merge-inc7-');
  writeTree(join(userData, 'notes'), { 'x.md': 'USER-X', 'y.md': 'USER-Y' });
  writeTree(join(backup, 'notes'), { 'x.md': 'LOCAL-X', 'y.md': 'LOCAL-Y' });
  writeTree(join(incoming, 'notes'), { 'x.md': 'PACK-X' }); // y.md 包内无对应版本

  const { report } = mergeNotes({
    userDataPath: userData,
    backupNotesRoot: join(backup, 'notes'),
    incomingNotesRoot: join(incoming, 'notes'),
    now: NOW,
  });

  const notes = join(userData, 'notes');
  equal(readFileSync(join(notes, 'x.md'), 'utf8'), 'USER-X'); // 目标内容保留原名
  equal(readFileSync(join(notes, `x (恢复冲突 ${STAMP}).md`), 'utf8'), 'PACK-X'); // 包内版本落冲突名
  equal(readFileSync(join(notes, 'y.md'), 'utf8'), 'USER-Y'); // 包内无对应版本 → 现状不动
  equal(existsSync(join(notes, `y (恢复冲突 ${STAMP}).md`)), false);
  deepEqual(report.classes.note, { added: 0, updated: 1, skipped: 1 });
  equal(report.conflicts.filter((c) => c.resolution === 'renamed' && c.path === 'x.md').length, 1);
  const kept = report.conflicts.find((c) => c.resolution === 'kept-local')!;
  equal(kept.path, 'y.md');
  equal(kept.kind, 'note');
});

test('notes：非 md 忽略 / .trash 不进文件级合并 / 空目录与深路径遍历', () => {
  const userData = tmp('hull-merge-notes8-');
  const backup = tmp('hull-merge-bak8-');
  writeTree(join(backup, 'notes'), {
    'readme.txt': 'TXT',
    'pic.png': 'PNG',
    '.trash/ghost.md': 'GHOST',
    'a/b/c/deep.md': 'DEEP',
  });
  mkdirSync(join(backup, 'notes', 'empty'), { recursive: true });
  mkdirSync(join(userData, 'notes'), { recursive: true });

  const { report } = mergeNotes({
    userDataPath: userData,
    backupNotesRoot: join(backup, 'notes'),
    incomingNotesRoot: join(backup, 'notes', 'none'),
    now: NOW,
  });

  const notes = join(userData, 'notes');
  equal(readFileSync(join(notes, 'a/b/c/deep.md'), 'utf8'), 'DEEP');
  equal(existsSync(join(notes, 'readme.txt')), false);
  equal(existsSync(join(notes, 'pic.png')), false);
  equal(existsSync(join(notes, '.trash/ghost.md')), false);
  deepEqual(report.classes.note, { added: 1, updated: 0, skipped: 0 });
});

test('notes 回收站：incoming 实体兜底拷入', () => {
  const userData = tmp('hull-merge-notes9-');
  const backup = tmp('hull-merge-bak9-');
  const incoming = tmp('hull-merge-inc9-');
  const t1 = { id: 'tr_1', originalPath: 'one.md', deletedAt: '2026-09-01T00:00:00.000Z', sizeBytes: 1 };
  writeTree(join(userData, 'notes'), { 'trash.json': JSON.stringify({ entries: [t1] }) }); // 实体缺失
  writeTree(join(incoming, 'notes'), {
    'trash.json': JSON.stringify({ entries: [t1] }), // 同 id → 不重复并入
    '.trash/tr_1.md': 'INC-ENTITY',
  });

  mergeNotes({ userDataPath: userData, backupNotesRoot: join(backup, 'notes'), incomingNotesRoot: join(incoming, 'notes'), now: NOW });

  equal(readFileSync(join(userData, 'notes', '.trash', 'tr_1.md'), 'utf8'), 'INC-ENTITY');
  const trash = JSON.parse(readFileSync(join(userData, 'notes', 'trash.json'), 'utf8')) as { entries: Array<{ id: string }> };
  deepEqual(trash.entries.map((e) => e.id), ['tr_1']);
});

test('notes 回收站：trash.json 损坏 → 按空处理不崩，backup 条目与实体照常并入', () => {
  const userData = tmp('hull-merge-notes10-');
  const backup = tmp('hull-merge-bak10-');
  const incoming = tmp('hull-merge-inc10-');
  const t2 = { id: 'tr_2', originalPath: 'two.md', deletedAt: '2026-09-02T00:00:00.000Z', sizeBytes: 2 };
  writeTree(join(userData, 'notes'), { 'trash.json': '{broken' });
  writeTree(join(backup, 'notes'), {
    'trash.json': JSON.stringify({ entries: [t2] }),
    '.trash/tr_2.md': 'E2',
  });

  mergeNotes({ userDataPath: userData, backupNotesRoot: join(backup, 'notes'), incomingNotesRoot: join(incoming, 'notes'), now: NOW });

  const trash = JSON.parse(readFileSync(join(userData, 'notes', 'trash.json'), 'utf8')) as { entries: Array<{ id: string }> };
  deepEqual(trash.entries.map((e) => e.id), ['tr_2']);
  equal(readFileSync(join(userData, 'notes', '.trash', 'tr_2.md'), 'utf8'), 'E2');
});
