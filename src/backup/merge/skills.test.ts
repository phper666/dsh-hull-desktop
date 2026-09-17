import { test, after } from 'node:test';
import { deepEqual, equal, ok } from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { mergeSkillsState } from './skills';

const dirs: string[] = [];
after(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

function tmp(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value));
}

function readEntries(path: string): Array<Record<string, unknown>> {
  return (JSON.parse(readFileSync(path, 'utf8')) as { entries: Array<Record<string, unknown>> }).entries;
}

test('skills：disabled 按 skillName 并集 / trash 按 id 并集 / 实体缺失拷入 / missingPath 标注', () => {
  const userData = tmp('hull-merge-skills-');
  const backup = tmp('hull-merge-skills-bak-');
  const incoming = tmp('hull-merge-skills-inc-');

  const livePath = join(tmp('hull-merge-skills-live-'), 'skill-a');
  mkdirSync(livePath, { recursive: true });

  // 包内基线
  writeJson(join(userData, 'skills', 'disabled.json'), {
    version: 1,
    entries: [
      { id: 'd_1', skillName: 'A', originalPath: livePath, kind: 'dir', affectedPlatforms: [], disabledAt: '2026-09-01T00:00:00.000Z' },
      { id: 'd_2', skillName: 'B', originalPath: join(userData, 'gone-b'), kind: 'dir', affectedPlatforms: [], disabledAt: '2026-09-01T00:00:00.000Z' },
    ],
  });
  mkdirSync(join(userData, 'skills', 'disabled', 'd_2'), { recursive: true });
  writeFileSync(join(userData, 'skills', 'disabled', 'd_2', 'SKILL.md'), 'base-b');
  writeJson(join(userData, 'skills', 'trash.json'), {
    version: 1,
    entries: [
      { id: 'tr_1', skillName: 'T1', originalPath: livePath, deletedAt: '2026-09-01T00:00:00.000Z', sizeBytes: 1, affectedPlatforms: [] },
    ],
  });

  // 本地预备份
  writeJson(join(backup, 'skills', 'disabled.json'), {
    version: 1,
    entries: [
      { id: 'd_3', skillName: 'C', originalPath: join(backup, 'gone-c'), kind: 'dir', affectedPlatforms: [], disabledAt: '2026-09-02T00:00:00.000Z' },
      { id: 'd_4', skillName: 'A', originalPath: join(backup, 'gone-a4'), kind: 'dir', affectedPlatforms: [], disabledAt: '2026-09-02T00:00:00.000Z' },
    ],
  });
  mkdirSync(join(backup, 'skills', 'disabled', 'd_3'), { recursive: true });
  writeFileSync(join(backup, 'skills', 'disabled', 'd_3', 'SKILL.md'), 'local-c');
  writeJson(join(backup, 'skills', 'trash.json'), {
    version: 1,
    entries: [
      { id: 'tr_2', skillName: 'T2', originalPath: join(backup, 'gone-t2'), deletedAt: '2026-09-02T00:00:00.000Z', sizeBytes: 2, affectedPlatforms: [] },
    ],
  });
  mkdirSync(join(backup, 'skills', 'trash', 'tr_2'), { recursive: true });
  writeFileSync(join(backup, 'skills', 'trash', 'tr_2', 'SKILL.md'), 'local-t2');

  const { report } = mergeSkillsState({
    userDataPath: userData,
    backupSkillsRoot: join(backup, 'skills'),
    incomingSkillsRoot: join(incoming, 'skills'),
  });

  const disabled = readEntries(join(userData, 'skills', 'disabled.json'));
  deepEqual(disabled.map((e) => e.id), ['d_1', 'd_2', 'd_3']); // d_4 同 skillName A 去重
  equal(disabled.find((e) => e.id === 'd_1')!.missingPath, true); // 实体目录缺失（点启用会失败）→ 标注
  equal(disabled.find((e) => e.id === 'd_2')!.missingPath, true); // originalPath 不存在 → 标注
  equal(existsSync(join(userData, 'skills', 'disabled', 'd_3', 'SKILL.md')), true); // 本地实体拷入
  equal(existsSync(join(userData, 'skills', 'disabled', 'd_2', 'SKILL.md')), true); // 原实体不动

  const trash = readEntries(join(userData, 'skills', 'trash.json'));
  deepEqual(trash.map((e) => e.id), ['tr_1', 'tr_2']);
  equal(trash.find((e) => e.id === 'tr_1')!.missingPath, true); // 实体目录缺失 → 标注
  equal(trash.find((e) => e.id === 'tr_2')!.missingPath, true);
  equal(existsSync(join(userData, 'skills', 'trash', 'tr_2', 'SKILL.md')), true);

  ok(report.classes.skill.added >= 2);
  ok(report.conflicts.some((c) => c.resolution === 'missing-path' && c.id === 'd_1' && /实体/.test(c.detail ?? '')));
  ok(report.conflicts.some((c) => c.resolution === 'missing-path' && c.id === 'd_2'));
  ok(report.conflicts.some((c) => c.resolution === 'missing-path' && c.id === 'tr_2'));
  equal(report.conflicts.filter((c) => c.resolution === 'skipped-identical').length, 1); // d_4 同 skillName 去重
  equal(report.notices.length, 0);
});

test('skills：实体缺失标注（symlink 免判 / 实体在则免标）；incoming 实体兜底拷入', () => {
  const userData = tmp('hull-merge-skills3-');
  const backup = tmp('hull-merge-skills3-bak-');
  const incoming = tmp('hull-merge-skills3-inc-');
  const liveA = join(tmp('hull-merge-skills3-liveA-'), 'skill-a');
  const liveB = join(tmp('hull-merge-skills3-liveB-'), 'skill-b');
  mkdirSync(liveA, { recursive: true });
  mkdirSync(liveB, { recursive: true });

  writeJson(join(userData, 'skills', 'disabled.json'), {
    version: 1,
    entries: [
      { id: 'd_1', skillName: 'A', originalPath: liveA, kind: 'dir', affectedPlatforms: [], disabledAt: '2026-09-01T00:00:00.000Z' },
      { id: 'd_2', skillName: 'B', originalPath: liveB, kind: 'symlink', symlinkTarget: '/ssot/b', affectedPlatforms: [], disabledAt: '2026-09-01T00:00:00.000Z' },
      { id: 'd_3', skillName: 'C', originalPath: liveB, kind: 'dir', affectedPlatforms: [], disabledAt: '2026-09-01T00:00:00.000Z' },
    ],
  });
  mkdirSync(join(userData, 'skills', 'disabled', 'd_3'), { recursive: true });
  writeFileSync(join(userData, 'skills', 'disabled', 'd_3', 'SKILL.md'), 'base-c');
  // incoming 实体兜底（原路径已失效 → 拷入）
  writeJson(join(incoming, 'skills', 'disabled.json'), {
    version: 1,
    entries: [{ id: 'd_4', skillName: 'D', originalPath: join(incoming, 'gone-d'), kind: 'dir', affectedPlatforms: [], disabledAt: '2026-09-02T00:00:00.000Z' }],
  });
  mkdirSync(join(incoming, 'skills', 'disabled', 'd_4'), { recursive: true });
  writeFileSync(join(incoming, 'skills', 'disabled', 'd_4', 'SKILL.md'), 'inc-d');

  const { report } = mergeSkillsState({
    userDataPath: userData,
    backupSkillsRoot: join(backup, 'skills'),
    incomingSkillsRoot: join(incoming, 'skills'),
  });

  const disabled = readEntries(join(userData, 'skills', 'disabled.json'));
  equal(disabled.find((e) => e.id === 'd_1')!.missingPath, true); // 原路径在但实体缺 → 点启用会失败
  equal('missingPath' in disabled.find((e) => e.id === 'd_2')!, false); // symlink 无实体，不算缺
  equal('missingPath' in disabled.find((e) => e.id === 'd_3')!, false); // 实体在
  equal(existsSync(join(userData, 'skills', 'disabled', 'd_4', 'SKILL.md')), true); // incoming 实体拷入
  equal(disabled.find((e) => e.id === 'd_4')!.missingPath, true); // 原路径失效 → 仍标 path
  ok(report.conflicts.some((c) => c.id === 'd_1' && c.resolution === 'missing-path' && /实体/.test(c.detail ?? '')));
});

test('skills：索引缺失/损坏 → 空基线不崩，原文件不覆盖（无条目无写入）', () => {
  const userData = tmp('hull-merge-skills2-');
  const backup = tmp('hull-merge-skills-bak2-');
  const incoming = tmp('hull-merge-skills-inc2-');
  mkdirSync(join(userData, 'skills'), { recursive: true });
  writeFileSync(join(userData, 'skills', 'disabled.json'), '{broken');
  const { report } = mergeSkillsState({
    userDataPath: userData,
    backupSkillsRoot: join(backup, 'skills'),
    incomingSkillsRoot: join(incoming, 'skills'),
  });
  deepEqual(report.classes.skill, { added: 0, updated: 0, skipped: 0 });
  equal(readFileSync(join(userData, 'skills', 'disabled.json'), 'utf8'), '{broken'); // 损坏文件不覆盖
});
