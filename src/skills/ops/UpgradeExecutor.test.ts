/**
 * S2 升级执行器单测（CON-R-skills-004 + Q-033/Q-034，设计 D3）
 * undetectable 拒绝 / latest 拒绝 / npx 优先失败降级 git-staging /
 * staging 原子替换 / 失败回滚 / 完整性校验
 */
import { test } from 'node:test';
import { equal, ok, rejects } from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { createNodeFsOps } from '../SkillFsOps';
import {
  SkillValidationError,
  SkillsUpgradeFailedError,
  SkillsUpgradeUndetectableError,
} from '../errors';
import { OperationLog } from './OperationLog';
import { UpgradeExecutor, type UpgradeRunners } from './UpgradeExecutor';
import { SkillsScanner } from '../SkillsScanner';

const tempDirs: string[] = [];
function makeTemp(): string {
  const dir = mkdtempSync(join(tmpdir(), 'hull-skills-upg-'));
  tempDirs.push(dir);
  return dir;
}
test.after(() => {
  for (const d of tempDirs) rmSync(d, { recursive: true, force: true });
});

interface Fixture {
  home: string;
  base: string;
  skillDir: string;
  scanner: SkillsScanner;
  exec: (runners?: UpgradeRunners) => UpgradeExecutor;
}

/** 建 home + skill + 扫描就绪；lockHash=null → 无远端哈希（undetectable）；'local' → latest；其余值 → upgradable */
async function makeFixture(lockMode: 'none' | 'local' | 'remote'): Promise<Fixture> {
  const home = makeTemp();
  const skillDir = join(home, '.claude/skills/up1');
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(
    join(skillDir, 'SKILL.md'),
    '---\nname: up1\ndescription: old\nmetadata:\n  source: https://github.com/o/r\n---\n'
  );

  // 先无 lock 扫一次拿 localHash（供 'local' 模式）
  const probe = new SkillsScanner({ homeDir: home, userDataPath: join(home, 'ud'), lockProvider: () => ({}) });
  await probe.scan();
  const localHash = probe.snapshot().entries[0]!.localHash!;

  const lockValue = lockMode === 'none' ? undefined : lockMode === 'local' ? localHash : 'a'.repeat(64);
  const lock: Record<string, { hash: string }> = lockValue ? { up1: { hash: lockValue } } : {};
  const scanner = new SkillsScanner({
    homeDir: home,
    userDataPath: join(home, 'ud'),
    lockProvider: () => lock,
  });
  await scanner.scan();

  const base = join(home, 's2base');
  const log = new OperationLog(join(base, 'log', 'operations.jsonl'));
  const exec = (runners?: UpgradeRunners) =>
    new UpgradeExecutor({ ops: createNodeFsOps(), base, scanner, log }, runners);
  return { home, base, skillDir, scanner, exec };
}

const gitClonerWriting = (desc: string) => async (_url: string, dest: string): Promise<void> => {
  mkdirSync(dest, { recursive: true });
  writeFileSync(join(dest, 'SKILL.md'), `---\nname: up1\ndescription: ${desc}\n---\n`);
};

test('remoteHash=unknown（无来源）→ skills-upgrade-undetectable，零盘上变更', async () => {
  const fx = await makeFixture('none');
  const before = readFileSync(join(fx.skillDir, 'SKILL.md'), 'utf8');
  await rejects(
    () => fx.exec().upgrade(fx.skillDir),
    (err: Error) => err instanceof SkillsUpgradeUndetectableError && err.code === 'skills-upgrade-undetectable'
  );
  equal(readFileSync(join(fx.skillDir, 'SKILL.md'), 'utf8'), before);
});

test('latest（哈希一致）→ validation-error 拒绝重复升级', async () => {
  const fx = await makeFixture('local');
  equal(fx.scanner.snapshot().entries[0]!.upgradable, 'latest');
  await rejects(
    () => fx.exec().upgrade(fx.skillDir),
    (err: Error) => err instanceof SkillValidationError && err.code === 'validation-error'
  );
});

test('git-staging 成功：原子替换 + newHash 更新 + staging 清理干净', async () => {
  const fx = await makeFixture('remote');
  const oldHash = fx.scanner.snapshot().entries[0]!.localHash!;
  const res = await fx.exec({ gitClone: gitClonerWriting('new-from-git') }).upgrade(fx.skillDir);

  equal(res.method, 'git-staging');
  equal(res.path, fx.skillDir);
  ok(res.newHash && res.newHash !== oldHash, 'newHash 已变化');
  ok(readFileSync(join(fx.skillDir, 'SKILL.md'), 'utf8').includes('new-from-git'), '内容已替换');
  const stagingFiles = existsSync(join(fx.base, 'staging')) ? readdirSync(join(fx.base, 'staging')) : [];
  equal(
    stagingFiles.filter((f) => f !== 'backups.json').length,
    0,
    'staging 清理干净（backup/workdir 均删；仅留 backups.json 清单）'
  );
});

test('npx 成功 → method=npx-skills-update（原地更新即成功，无需 staging）', async () => {
  const fx = await makeFixture('remote');
  const exec = fx.exec({
    npxUpdate: async (_cwd, name) => {
      equal(name, 'up1');
      writeFileSync(join(fx.skillDir, 'SKILL.md'), '---\nname: up1\ndescription: new-from-npx\n---\n');
    },
  });
  const res = await exec.upgrade(fx.skillDir);
  equal(res.method, 'npx-skills-update');
  ok(readFileSync(join(fx.skillDir, 'SKILL.md'), 'utf8').includes('new-from-npx'));
});

test('npx 失败 → 降级 git-staging（O23）；npx 无效果（hash 不变）同样降级', async () => {
  const fx = await makeFixture('remote');
  let gitCalled = false;
  const res = await fx
    .exec({
      npxUpdate: async () => {
        throw new Error('npx not supported');
      },
      gitClone: async (_url, dest) => {
        gitCalled = true;
        await gitClonerWriting('fallback-git')(_url, dest);
      },
    })
    .upgrade(fx.skillDir);
  ok(gitCalled, '降级到 git');
  equal(res.method, 'git-staging');

  const fx2 = await makeFixture('remote');
  const res2 = await fx2
    .exec({
      npxUpdate: async () => undefined, // 跑了但无效果
      gitClone: gitClonerWriting('v2'),
    })
    .upgrade(fx2.skillDir);
  equal(res2.method, 'git-staging');
});

test('clone 失败 → skills-upgrade-failed + rolledBack=true，原版本完好', async () => {
  const fx = await makeFixture('remote');
  const before = readFileSync(join(fx.skillDir, 'SKILL.md'), 'utf8');
  await rejects(
    () => fx.exec({ gitClone: async () => { throw new Error('network down'); } }).upgrade(fx.skillDir),
    (err: Error) => err instanceof SkillsUpgradeFailedError && (err as SkillsUpgradeFailedError).rolledBack === true
  );
  equal(readFileSync(join(fx.skillDir, 'SKILL.md'), 'utf8'), before, '回滚保留原版本');
});

test('完整性校验：新版本 name 不一致 → 失败回滚不落地', async () => {
  const fx = await makeFixture('remote');
  const before = readFileSync(join(fx.skillDir, 'SKILL.md'), 'utf8');
  await rejects(
    () =>
      fx
        .exec({
          gitClone: async (_url, dest) => {
            mkdirSync(dest, { recursive: true });
            writeFileSync(join(dest, 'SKILL.md'), '---\nname: OTHER\ndescription: x\n---\n');
          },
        })
        .upgrade(fx.skillDir),
    (err: Error) => err instanceof SkillsUpgradeFailedError
  );
  equal(readFileSync(join(fx.skillDir, 'SKILL.md'), 'utf8'), before);
});
