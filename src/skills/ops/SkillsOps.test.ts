/**
 * S2 门面单测（契约 §行为契约：守卫链/批量部分失败/白名单+穿越拒绝/自愈）
 * remove 链 / mtime 冲突 / 单飞互斥 / setEnabled 往返 / restore / selfHeal
 */
import { test } from 'node:test';
import { deepEqual, equal, ok, rejects } from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { createNodeFsOps, type SkillFsOps } from '../SkillFsOps';
import {
  RestoreConflictError,
  SkillValidationError,
  SkillsOpInProgressError,
} from '../errors';
import { SkillsOps, type RemoveResult } from './SkillsOps';
import type { UpgradeRunners } from './UpgradeExecutor';
import { SkillsScanner } from '../SkillsScanner';

const tempDirs: string[] = [];
function makeTemp(): string {
  const dir = mkdtempSync(join(tmpdir(), 'hull-skills-ops-'));
  tempDirs.push(dir);
  return dir;
}
test.after(() => {
  for (const d of tempDirs) rmSync(d, { recursive: true, force: true });
});

interface Fixture {
  home: string;
  ops: SkillsOps;
  scanner: SkillsScanner;
  setRunners: (r: UpgradeRunners | undefined) => void;
}

async function makeFixture(lockHash?: string, opsOverride?: SkillFsOps): Promise<Fixture> {
  const home = makeTemp();
  const skillDir = join(home, '.claude/skills/app1');
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(
    join(skillDir, 'SKILL.md'),
    '---\nname: app1\ndescription: d\nmetadata:\n  source: https://github.com/o/r\n---\n'
  );
  const lock: Record<string, { hash: string }> = lockHash ? { app1: { hash: lockHash } } : {};
  const scanner = new SkillsScanner({
    homeDir: home,
    userDataPath: join(home, 'ud'),
    lockProvider: () => lock,
  });
  await scanner.scan();
  let runners: UpgradeRunners | undefined;
  const opsFacade = new SkillsOps({
    ops: opsOverride ?? createNodeFsOps(),
    homeDir: home,
    userDataPath: join(home, 'ud'),
    scanner,
    runnersRef: () => runners,
  });
  return { home, ops: opsFacade, scanner, setRunners: (r) => (runners = r) };
}

test('remove 成功链：备份回收站 → 原目录消失 → 日志留痕 → 快照刷新', async () => {
  const fx = await makeFixture();
  const p = join(fx.home, '.claude/skills/app1');
  const results = await fx.ops.remove([p]);
  equal(results.length, 1);
  equal(results[0]!.status, 'removed');
  ok(results[0]!.trashId!.startsWith('tr_'));
  ok(!existsSync(p), '原目录已删');

  const trash = await fx.ops.getTrashList();
  equal(trash.entries.length, 1);
  equal(trash.entries[0]!.originalPath, p);
  ok(trash.totalSizeBytes > 0);

  const logEntries = fx.ops.getOperationLog();
  ok(logEntries[0]!.action === 'remove' && logEntries[0]!.result === 'success');

  // 快照已刷新（await 重扫）：条目消失
  equal(fx.scanner.snapshot().entries.some((e) => e.name === 'app1'), false);
});

test('setSource：替换已有 metadata.source + 重扫后来源生效', async () => {
  const fx = await makeFixture();
  const p = join(fx.home, '.claude/skills/app1');
  const res = await fx.ops.setSource(p, 'https://github.com/new/place');
  equal(res.path, p);
  equal(res.source, 'https://github.com/new/place');
  // 盘上 SKILL.md metadata.source 已更新
  const md = readFileSync(join(p, 'SKILL.md'), 'utf8');
  equal(md.includes('source: https://github.com/new/place'), true);
  equal(md.includes('https://github.com/o/r'), false);
  // 重扫后 entry.source 生效
  const entry = fx.scanner.snapshot().entries.find((e) => e.name === 'app1');
  equal(entry?.source, 'https://github.com/new/place');
  // 日志留痕
  ok(fx.ops.getOperationLog().some((l) => l.action === 'setSource' && l.result === 'success'));
});

test('setSource：无 metadata 块的 SKILL.md 新增 metadata.source（写入 metadata 块）', async () => {
  const fx = await makeFixture();
  const p = join(fx.home, '.claude/skills/app1');
  // 先去掉 source（模拟无 metadata.source 的 skill）
  const mdPath = join(p, 'SKILL.md');
  writeFileSync(mdPath, '---\nname: app1\ndescription: d\nmetadata:\n  requires:\n    bins: ["x"]\n---\n');
  await fx.scanner.scan();
  await fx.ops.setSource(p, 'https://github.com/new/place');
  const md = readFileSync(mdPath, 'utf8');
  equal(md.includes('source: https://github.com/new/place'), true);
  equal(md.includes('requires:'), true); // 其它字段保留
});

test('setSource：非法 source（非 http）→ validation-error；空/白名单外路径 → validation-error', async () => {
  const fx = await makeFixture();
  const p = join(fx.home, '.claude/skills/app1');
  await rejects(() => fx.ops.setSource(p, 'not-a-url'), (e: Error) => e instanceof SkillValidationError);
  await rejects(() => fx.ops.setSource(p, ''), (e: Error) => e instanceof SkillValidationError);
  await rejects(
    () => fx.ops.setSource(join(fx.home, '.claude/skills/../../etc/passwd'), 'https://x/y'),
    (e: Error) => e instanceof SkillValidationError
  );
});

test('remove 批量部分失败：有效 removed + 失效 failed(skills-not-found)，不回滚已成功项', async () => {
  const fx = await makeFixture();
  const good = join(fx.home, '.claude/skills/app1');
  const results = await fx.ops.remove([good, join(fx.home, '.claude/skills/ghost')]);
  equal(results[0]!.status, 'removed');
  equal(results[1]!.status, 'failed');
  equal((results[1] as { code?: string }).code, 'skills-not-found');
});

test('白名单外路径与穿越路径 → validation-error，零盘上变更', async () => {
  const fx = await makeFixture();
  const before = existsSync(join(fx.home, '.claude/skills/app1'));

  const r1 = await fx.ops.remove(['/etc']);
  equal(r1[0]!.status, 'failed');
  equal((r1[0] as { code?: string }).code, 'validation-error');

  const escape = join(fx.home, '.claude/skills', '..', '..');
  const r2 = await fx.ops.remove([escape]);
  equal(r2[0]!.status, 'failed');
  equal((r2[0] as { code?: string }).code, 'validation-error');

  equal(existsSync(join(fx.home, '.claude/skills/app1')), before, '零变更');
});

test('mtime 冲突：外部修改后写操作 → skills-conflict「已被外部修改」', async () => {
  const fx = await makeFixture();
  const p = join(fx.home, '.claude/skills/app1');
  // 外部（agent 侧）改动目录 → mtime ≠ 快照
  await new Promise((r) => setTimeout(r, 20));
  writeFileSync(join(p, 'newfile.txt'), 'agent wrote');

  const results = await fx.ops.remove([p]);
  equal(results[0]!.status, 'failed');
  equal((results[0] as { code?: string }).code, 'skills-conflict');
  ok(existsSync(p), '冲突拒做原目录保留');
});

test('单飞互斥：同 path 升级进行中再触发写操作 → skills-op-in-progress', async () => {
  const fx = await makeFixture('a'.repeat(64)); // upgradable
  const p = join(fx.home, '.claude/skills/app1');
  let releaseClone!: () => void;
  const gate = new Promise<void>((r) => (releaseClone = r));
  fx.setRunners({ gitClone: async () => gate });

  const upgrading = fx.ops.upgrade(p).catch(() => 'failed');
  await new Promise((r) => setTimeout(r, 30)); // 让升级先拿到锁

  const rmResults = await fx.ops.remove([p]);
  equal((rmResults[0] as { code?: string }).code, 'skills-op-in-progress');

  await rejects(
    () => fx.ops.upgrade(p),
    (err: Error) => err instanceof SkillsOpInProgressError && err.code === 'skills-op-in-progress'
  );

  releaseClone();
  equal(await upgrading, 'failed'); // clone 无内容完整性不过 → 回滚失败态（可接受终态）
  // 锁已释放：再次操作不再 op-in-progress
  const retry = await fx.ops.remove([p]);
  ok(retry[0]!.status !== 'failed' || (retry[0] as { code?: string }).code !== 'skills-op-in-progress');
});

test('setEnabled 实目录往返：禁用真移出 + 启用恢复；双路径禁其一名 enabled=false（Q-031 聚合）', async () => {
  const fx = await makeFixture();
  const p = join(fx.home, '.claude/skills/app1');

  const dis = await fx.ops.setEnabled(p, false);
  ok(dis.entryId!.startsWith('d_'));
  ok(!existsSync(p), 'agent 平台真不可加载');
  equal((await fx.ops.getDisabledList()).length, 1);
  // 单路径 skill 整体禁用后物理消失——扫描列表不再出现（UI 经 getDisabledList 合并展示）
  equal(fx.scanner.snapshot().entries.some((e) => e.name === 'app1'), false);

  const en = await fx.ops.setEnabled(p, true);
  equal(en.enabled, true);
  ok(existsSync(join(p, 'SKILL.md')));
  equal((await fx.ops.getDisabledList()).length, 0);

  // 双路径聚合：shared + claude 各一份，仅禁 claude 副本 → 条目仍在且 enabled=false
  const sharedDir = join(fx.home, '.agents/skills/app1');
  mkdirSync(sharedDir, { recursive: true });
  writeFileSync(join(sharedDir, 'SKILL.md'), '---\nname: app1\ndescription: shared\n---\n');
  await fx.scanner.scan();
  const claudePath = join(fx.home, '.claude/skills/app1');
  await fx.ops.setEnabled(claudePath, false);
  const entry = fx.scanner.snapshot().entries.find((e) => e.name === 'app1');
  ok(entry, '仍有 shared 路径生效，条目保留');
  equal(entry!.enabled, false, '任一路径禁用 → 聚合 enabled=false');
  equal(entry!.paths.length, 1, '仅剩 shared 物理路径');

  await fx.ops.setEnabled(claudePath, true);
  equal(fx.scanner.snapshot().entries.find((e) => e.name === 'app1')!.enabled, true);
});

test('setEnabled symlink 往返：unlink 指针 SSOT 保留 / 启用重建链接', async () => {
  const fx = await makeFixture();
  const ssot = join(fx.home, 'ssot-src');
  mkdirSync(ssot, { recursive: true });
  writeFileSync(join(ssot, 'SKILL.md'), '---\nname: lnk\ndescription: d\n---\n');
  const link = join(fx.home, '.claude/skills/lnk');
  symlinkSync(ssot, link, 'dir');
  await fx.scanner.scan(); // 纳入快照

  await fx.ops.setEnabled(link, false);
  ok(!existsSync(link), '指针移除');
  ok(existsSync(join(ssot, 'SKILL.md')), 'SSOT 完好');

  await fx.ops.setEnabled(link, true);
  ok(existsSync(join(link, 'SKILL.md')), 'symlink 重建');
});

test('restoreFromTrash：移除后恢复回原位 + 日志 restore', async () => {
  const fx = await makeFixture();
  const p = join(fx.home, '.claude/skills/app1');
  const [r] = await fx.ops.remove([p]);
  const restored = await fx.ops.restoreFromTrash(r!.trashId!);
  equal(restored.restoredPath, p);
  ok(existsSync(join(p, 'SKILL.md')));
  ok(fx.ops.getOperationLog()[0]!.action === 'restore');
});

test('restore 冲突经门面：目标占用 → restore-conflict 不覆盖', async () => {
  const fx = await makeFixture();
  const p = join(fx.home, '.claude/skills/app1');
  const [r] = await fx.ops.remove([p]);
  mkdirSync(p, { recursive: true }); // 外部占用
  await rejects(
    () => fx.ops.restoreFromTrash(r!.trashId!),
    (err: Error) => err instanceof RestoreConflictError
  );
});

test('selfHeal：staging backup 残留 + 原路径空缺 → 启动自动还原', async () => {
  const fx = await makeFixture();
  const p = join(fx.home, '.claude/skills/app1');
  const stagingDir = join(fx.home, 'ud', 'skills', 'staging'); // 门面 skillsBase = <userData>/skills
  const backupDir = join(stagingDir, 'u.backup');
  mkdirSync(backupDir, { recursive: true });
  writeFileSync(join(backupDir, 'SKILL.md'), '---\nname: app1\ndescription: original\n---\n');
  writeFileSync(
    join(stagingDir, 'backups.json'),
    JSON.stringify({ version: 1, entries: [{ backupDir, originalPath: p, at: new Date().toISOString() }] })
  );
  rmSync(p, { recursive: true, force: true }); // 模拟两段 rename 窗口崩溃

  fx.ops.selfHeal();
  ok(existsSync(join(p, 'SKILL.md')), '原版本自动还原');
  ok(fx.ops.getOperationLog().some((e) => e.action === 'restore' && e.detail?.selfHeal === true));
});

// ─────────────── 评审修复回归（🔴1 单飞+白名单 / 🟡4 symlink 升级拒绝 / 🟡7 收敛） ───────────────

test('restoreFromTrash 单飞：restore 进行中同 originalPath 再 restore → skills-op-in-progress（🔴1）', async () => {
  const home = makeTemp();
  const skillDir = join(home, '.claude/skills/app1');
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(join(skillDir, 'SKILL.md'), '---\nname: app1\ndescription: d\n---\n');
  const scanner = new SkillsScanner({ homeDir: home, userDataPath: join(home, 'ud') });
  await scanner.scan();

  // 门控 moveSync：从 trash 搬出的恢复搬移挂起，模拟 restore 的 rename 窗口
  // （按 from 判定——remove 的搬移是 into-trash（to），restore 才是 out-of-trash（from））
  const ops = createNodeFsOps();
  const origMove = ops.moveSync.bind(ops);
  let gatedUsed = false;
  let releaseMove!: () => void;
  const gate = new Promise<void>((r) => (releaseMove = r));
  ops.moveSync = (from: string, to: string): void | Promise<void> => {
    if (!gatedUsed && /[/\\]trash[/\\]/.test(from)) {
      gatedUsed = true;
      return gate.then(() => origMove(from, to));
    }
    return origMove(from, to);
  };
  const facade = new SkillsOps({ ops, homeDir: home, userDataPath: join(home, 'ud'), scanner });

  const [r] = await facade.remove([skillDir]);
  ok(r!.trashId);

  const first = facade.restoreFromTrash(r!.trashId!); // 持锁进入 move 窗口
  await new Promise((res) => setTimeout(res, 30));
  await rejects(
    () => facade.restoreFromTrash(r!.trashId!),
    (err: Error) => err instanceof SkillsOpInProgressError && err.code === 'skills-op-in-progress'
  );
  releaseMove();
  const done = await first;
  equal(done.restoredPath, skillDir);
});

test('restoreFromTrash：originalPath 不在注册表白名单 → validation-error（🔴1 parser 不可信）', async () => {
  const fx = await makeFixture();
  const base = join(fx.home, 'ud', 'skills');
  const trashId = 'tr_evil';
  mkdirSync(join(base, 'trash', trashId), { recursive: true });
  writeFileSync(join(base, 'trash', trashId, 'SKILL.md'), '---\nname: evil\n---\n');
  writeFileSync(
    join(base, 'trash.json'),
    JSON.stringify({
      version: 1,
      entries: [
        { id: trashId, skillName: 'evil', originalPath: '/etc/evil', deletedAt: new Date().toISOString(), sizeBytes: 1, affectedPlatforms: ['codex'] },
      ],
    })
  );

  await rejects(
    () => fx.ops.restoreFromTrash(trashId),
    (err: Error) => err instanceof SkillValidationError && err.code === 'validation-error'
  );
});

test('symlink 路径升级 → validation-error 拒绝（🟡4：SSOT 语义，经原路径升级）', async () => {
  const home = makeTemp();
  const ssot = join(home, 'ssot-src', 'lnk');
  mkdirSync(ssot, { recursive: true });
  writeFileSync(join(ssot, 'SKILL.md'), '---\nname: lnk\ndescription: d\nmetadata:\n  source: https://github.com/o/r\n---\n');
  const link = join(home, '.claude/skills/lnk');
  mkdirSync(join(home, '.claude/skills'), { recursive: true });
  symlinkSync(ssot, link, 'dir');
  const lock = { lnk: { hash: 'a'.repeat(64) } };
  const scanner = new SkillsScanner({ homeDir: home, userDataPath: join(home, 'ud'), lockProvider: () => lock });
  await scanner.scan();

  const facade = new SkillsOps({ homeDir: home, userDataPath: join(home, 'ud'), scanner });
  await rejects(
    () => facade.upgrade(link),
    (err: Error) => err instanceof SkillValidationError && err.code === 'validation-error'
  );
  // SSOT 未被破坏、链接仍在
  ok(existsSync(link), 'symlink 未被移走');
  ok(existsSync(join(ssot, 'SKILL.md')));
});

test('升级成功后重扫收敛 latest（🟡7：不再无限可升级提示）', async () => {
  const fx = await makeFixture('a'.repeat(64)); // upgradable
  equal(fx.scanner.snapshot().entries.find((e) => e.name === 'app1')!.upgradable, 'upgradable');

  fx.setRunners({
    gitClone: async (_url, dest) => {
      mkdirSync(dest, { recursive: true });
      writeFileSync(join(dest, 'SKILL.md'), '---\nname: app1\ndescription: v2\nmetadata:\n  source: https://github.com/o/r\n---\n');
    },
  });
  await fx.ops.upgrade(join(fx.home, '.claude/skills/app1'));

  const entry = fx.scanner.snapshot().entries.find((e) => e.name === 'app1')!;
  equal(entry.upgradable, 'latest', '重扫后 localHash=override remoteHash → latest');
});
