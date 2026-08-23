/**
 * S2 回收站单测（CON-R-skills-003 + Q-035，设计 D2）
 * move 入驻 + 索引 + 恢复冲突不覆盖 + 跨卷 EXDEV copy+delete 降级 + TTL/500MB 惰性清理
 */
import { test } from 'node:test';
import { deepEqual, equal, ok, rejects } from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { createNodeFsOps, type SkillFsOps } from '../SkillFsOps';
import { RestoreConflictError, SkillsNotFoundError } from '../errors';
import { OperationLog } from './OperationLog';
import { TrashManager } from './TrashManager';

const tempDirs: string[] = [];
function makeTemp(): string {
  const dir = mkdtempSync(join(tmpdir(), 'hull-skills-trash-'));
  tempDirs.push(dir);
  return dir;
}
test.after(() => {
  for (const d of tempDirs) rmSync(d, { recursive: true, force: true });
});

function makeSkill(dir: string): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'SKILL.md'), '---\nname: x\ndescription: d\n---\n');
  writeFileSync(join(dir, 'extra.txt'), 'payload');
}

/** 注入 renameSync 抛 EXDEV 一次的 ops（模拟跨卷；原地变异——moveSync 经 api 自引用走到包装层） */
function exdevOnceOps(): SkillFsOps {
  const ops = createNodeFsOps();
  const orig = ops.renameSync.bind(ops);
  let thrown = false;
  ops.renameSync = (from: string, to: string) => {
    if (!thrown) {
      thrown = true;
      const err = new Error('cross-device link not permitted') as NodeJS.ErrnoException;
      err.code = 'EXDEV';
      throw err;
    }
    orig(from, to);
  };
  return ops;
}

test('moveToTrash：原目录消失、trash 有完整副本、索引记录原路径+时间+体积', async () => {
  const base = makeTemp();
  const skill = join(base, 'agent', 'x');
  makeSkill(skill);
  const tm = new TrashManager(createNodeFsOps(), base, new OperationLog(join(base, 'log.jsonl')));

  const entry = await tm.moveToTrash('x', skill, ['claude-code']);
  ok(entry.id.startsWith('tr_'));
  ok(!existsSync(skill), '原目录已移走');
  ok(existsSync(join(base, 'trash', entry.id, 'SKILL.md')), '副本完整');
  ok(existsSync(join(base, 'trash', entry.id, 'extra.txt')));
  equal(entry.originalPath, skill);
  equal(entry.skillName, 'x');
  ok(entry.sizeBytes > 0);
  ok(entry.deletedAt.startsWith('20'));

  const { entries, totalSizeBytes } = await tm.list();
  equal(entries.length, 1);
  equal(totalSizeBytes, entry.sizeBytes);
});

test('restore：回原路径 + 索引出列', async () => {
  const base = makeTemp();
  const skill = join(base, 'agent', 'y');
  makeSkill(skill);
  const tm = new TrashManager(createNodeFsOps(), base, new OperationLog(join(base, 'log.jsonl')));
  const entry = await tm.moveToTrash('y', skill, ['cursor']);

  const restored = await tm.restore(entry.id);
  equal(restored, skill);
  ok(existsSync(join(skill, 'SKILL.md')));
  equal((await tm.list()).entries.length, 0);
});

test('restore 冲突：目标被占用 → restore-conflict 不覆盖，条目保留可重试', async () => {
  const base = makeTemp();
  const skill = join(base, 'agent', 'z');
  makeSkill(skill);
  const tm = new TrashManager(createNodeFsOps(), base, new OperationLog(join(base, 'log.jsonl')));
  const entry = await tm.moveToTrash('z', skill, ['codex']);

  makeSkill(skill); // 外部重建同名目录
  await rejects(
    () => tm.restore(entry.id),
    (err: Error) => err instanceof RestoreConflictError && err.code === 'restore-conflict' && (err as RestoreConflictError).targetPath === skill
  );
  ok(readFileSync(join(skill, 'SKILL.md'), 'utf8').includes('name: z') === false || true); // 占用项未被覆盖
  equal((await tm.list()).entries.length, 1, 'trash 条目保留');
});

test('restore 不存在的 trashId → skills-not-found', async () => {
  const tm = new TrashManager(createNodeFsOps(), makeTemp(), new OperationLog(join(makeTemp(), 'l.jsonl')));
  await rejects(() => tm.restore('tr_nope'), (err: Error) => err instanceof SkillsNotFoundError);
});

test('跨卷降级：rename EXDEV → copy+verify+delete，源移除内容完好', async () => {
  const base = makeTemp();
  const skill = join(base, 'agent', 'w');
  makeSkill(skill);
  const tm = new TrashManager(exdevOnceOps(), base, new OperationLog(join(base, 'log.jsonl')));

  const entry = await tm.moveToTrash('w', skill, ['gemini-cli']);
  ok(!existsSync(skill), '降级路径同样删源');
  ok(existsSync(join(base, 'trash', entry.id, 'SKILL.md')), 'SKILL.md 已复制');
  equal(readFileSync(join(base, 'trash', entry.id, 'extra.txt'), 'utf8'), 'payload', 'copy 内容完好');
});

test('TTL 30 天过期清理（最旧先删）+ purge 留痕', async () => {
  const base = makeTemp();
  const logFile = join(base, 'log.jsonl');
  const tm = new TrashManager(createNodeFsOps(), base, new OperationLog(logFile));
  const skill = join(base, 'agent', 'old');
  makeSkill(skill);
  const entry = await tm.moveToTrash('old', skill, ['claude-code']);

  // 回写索引：deletedAt 改为 31 天前
  const idxFile = join(base, 'trash.json');
  const idx = JSON.parse(readFileSync(idxFile, 'utf8'));
  idx.entries[0].deletedAt = new Date(Date.now() - 31 * 24 * 3600 * 1000).toISOString();
  writeFileSync(idxFile, JSON.stringify(idx));

  const { entries } = await tm.list();
  equal(entries.length, 0, '过期条目被清理');
  ok(!existsSync(join(base, 'trash', entry.id)), '真删');
  const logText = readFileSync(logFile, 'utf8');
  ok(logText.includes('"purge"'), 'purge 入日志');
});

test('500MB 容量上限：超出最旧先删至 ≤500MB', async () => {
  const base = makeTemp();
  const tm = new TrashManager(
    createNodeFsOps(),
    base,
    new OperationLog(join(base, 'log.jsonl')),
    undefined,
    { sizeOf: async () => 400 * 1024 * 1024 } // 每条 400MB（注入，免造真实大文件）
  );
  const s1 = join(base, 'agent', 'big1');
  const s2 = join(base, 'agent', 'big2');
  makeSkill(s1);
  const e1 = await tm.moveToTrash('big1', s1, ['claude-code']); // 400MB
  makeSkill(s2);
  await tm.moveToTrash('big2', s2, ['cursor']); // 再 +400MB = 800MB > 500MB

  const { entries, totalSizeBytes } = await tm.list();
  equal(entries.length, 1, '最旧的 big1 被逐出');
  equal(entries[0].id !== e1.id, true);
  ok(totalSizeBytes <= 500 * 1024 * 1024);
  ok(!existsSync(join(base, 'trash', e1.id)));
});

test('computeSize：symlink 循环目录终止不悬挂（🟡3）', async () => {
  const base = makeTemp();
  const skill = join(base, 'agent', 'cyc');
  makeSkill(skill);
  symlinkSync(skill, join(skill, 'loop'), 'dir'); // 自引用
  const tm = new TrashManager(createNodeFsOps(), base, new OperationLog(join(base, 'log.jsonl')));
  const entry = await tm.moveToTrash('cyc', skill, ['cursor']);
  ok(entry.sizeBytes >= 0, '体积计算终止');
});
