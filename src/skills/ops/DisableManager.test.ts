/**
 * S2 禁用/启用单测（CON-R-skills-008 + Q-031/Q-032，设计 D4）
 * symlink 移指针（SSOT 保留）/ 实目录 rename 入 disabled + 映射；启用恢复；冲突不覆盖
 */
import { test } from 'node:test';
import { deepEqual, equal, ok, rejects } from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { createNodeFsOps, type SkillFsOps } from '../SkillFsOps';
import { RestoreConflictError, SkillValidationError } from '../errors';
import { OperationLog } from './OperationLog';
import { DisableManager } from './DisableManager';

/** 注入 renameSync 抛 EXDEV 一次的 ops（原地变异——moveSync 经 api 自引用走到降级路径） */
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

const tempDirs: string[] = [];
function makeTemp(): string {
  const dir = mkdtempSync(join(tmpdir(), 'hull-skills-dis-'));
  tempDirs.push(dir);
  return dir;
}
test.after(() => {
  for (const d of tempDirs) rmSync(d, { recursive: true, force: true });
});

function makeSkill(dir: string): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'SKILL.md'), '---\nname: x\ndescription: d\n---\n');
}

test('实目录禁用：rename 入 disabled/d_uuid/，SKILL.md 完好，映射记录 kind=dir', async () => {
  const base = makeTemp();
  const dm = new DisableManager(createNodeFsOps(), base, new OperationLog(join(base, 'log.jsonl')));
  const skill = join(base, 'agent', 'real');
  makeSkill(skill);

  const entry = await dm.disable('real', skill, ['claude-code', 'opencode']);
  ok(entry.id.startsWith('d_'));
  equal(entry.kind, 'dir');
  equal(entry.originalPath, skill);
  deepEqual(entry.affectedPlatforms, ['claude-code', 'opencode']);
  ok(!existsSync(skill), '原位置已空（agent 真禁用）');
  ok(existsSync(join(base, 'disabled', entry.id, 'SKILL.md')), '实体入驻且内容完好');
  equal(dm.list().length, 1);
});

test('实目录启用：rename 回原位 + 映射清除', async () => {
  const base = makeTemp();
  const dm = new DisableManager(createNodeFsOps(), base, new OperationLog(join(base, 'log.jsonl')));
  const skill = join(base, 'agent', 'back');
  makeSkill(skill);
  await dm.disable('back', skill, ['cursor']);

  await dm.enable(skill);
  ok(existsSync(join(skill, 'SKILL.md')), '恢复原位');
  equal(dm.list().length, 0, '映射清除');
});

test('symlink 禁用：仅 unlink 指针，SSOT 源完好，映射记 symlinkTarget', async () => {
  const base = makeTemp();
  const dm = new DisableManager(createNodeFsOps(), base, new OperationLog(join(base, 'log.jsonl')));
  const ssot = join(base, 'ssot', 'linked'); // 原始仓库/SSOT（注册表域外）
  makeSkill(ssot);
  const link = join(base, 'agent', 'lnk');
  mkdirSync(join(base, 'agent'), { recursive: true });
  symlinkSync(ssot, link, 'dir');

  const entry = await dm.disable('lnk', link, ['claude-code']);
  equal(entry.kind, 'symlink');
  equal(entry.symlinkTarget, ssot);
  ok(!existsSync(link), '指针已移除（agent 真禁用）');
  ok(existsSync(join(ssot, 'SKILL.md')), 'SSOT 源完好不破坏');

  await dm.enable(link);
  ok(existsSync(join(link, 'SKILL.md')), 'symlink 重建可读');
  ok(readFileSync(join(link, 'SKILL.md'), 'utf8').includes('name: x'));
});

test('重复禁用 → validation-error；未禁用启用 → validation-error', async () => {
  const base = makeTemp();
  const dm = new DisableManager(createNodeFsOps(), base, new OperationLog(join(base, 'log.jsonl')));
  const skill = join(base, 'agent', 'dup');
  makeSkill(skill);
  await dm.disable('dup', skill, ['codex']);

  await rejects(
    () => dm.disable('dup', skill, ['codex']),
    (err: Error) => err instanceof SkillValidationError && err.code === 'validation-error'
  );
  await rejects(
    () => dm.enable(join(base, 'agent', 'never')),
    (err: Error) => err instanceof SkillValidationError
  );
});

test('启用冲突：原路径被占用 → restore-conflict 不覆盖、映射保留', async () => {
  const base = makeTemp();
  const dm = new DisableManager(createNodeFsOps(), base, new OperationLog(join(base, 'log.jsonl')));
  const skill = join(base, 'agent', 'occ');
  makeSkill(skill);
  await dm.disable('occ', skill, ['gemini-cli']);

  makeSkill(skill); // 外部重建占用
  await rejects(
    () => dm.enable(skill),
    (err: Error) => err instanceof RestoreConflictError && (err as RestoreConflictError).targetPath === skill
  );
  equal(dm.list().length, 1, '映射保留可重试');
});

test('跨卷 EXDEV：rename 失败降级 copy+delete，禁用成功（🟡6 moveSync）', async () => {
  const base = makeTemp();
  const dm = new DisableManager(exdevOnceOps(), base, new OperationLog(join(base, 'log.jsonl')));
  const skill = join(base, 'agent', 'xdev');
  makeSkill(skill);

  const entry = await dm.disable('xdev', skill, ['claude-code']);
  equal(entry.kind, 'dir');
  ok(!existsSync(skill), '源已移除（copy+delete 完成）');
  ok(existsSync(join(base, 'disabled', entry.id, 'SKILL.md')), '实体完好入驻 disabled/');
});
