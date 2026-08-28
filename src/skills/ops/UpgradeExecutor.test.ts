/**
 * S2 升级执行器单测（CON-R-skills-004 + Q-033/Q-034，设计 D3）
 * undetectable 拒绝 / latest 拒绝 / npx 优先失败降级 git-staging /
 * staging 原子替换 / 失败回滚 / 完整性校验
 */
import { test } from 'node:test';
import { equal, ok, rejects } from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { createNodeFsOps } from '../SkillFsOps';
import {
  SkillValidationError,
  SkillsIoError,
  SkillsUpgradeFailedError,
  SkillsUpgradeUndetectableError,
} from '../errors';
import { OperationLog } from './OperationLog';
import { defaultNpxUpdate, spawnChecked, UpgradeExecutor, type UpgradeRunners } from './UpgradeExecutor';
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
  const probe = new SkillsScanner({
    homeDir: home,
    userDataPath: join(home, 'ud'),
    lockProvider: () => ({}),
    fetchTree: async () => {
      throw new Error('offline');
    },
  });
  await probe.scan();
  const localHash = probe.snapshot().entries[0]!.localHash!;

  const lockValue = lockMode === 'none' ? undefined : lockMode === 'local' ? localHash : 'a'.repeat(64);
  const lock: Record<string, { hash: string }> = lockValue ? { up1: { hash: lockValue } } : {};
  const scanner = new SkillsScanner({
    homeDir: home,
    userDataPath: join(home, 'ud'),
    lockProvider: () => lock,
    // up1 带 GitHub source：无 lockHash 时触发 P0-1 预取 → 离线 stub（throw）保持 unknown/undetectable 语义
    fetchTree: async () => {
      throw new Error('offline');
    },
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

// ─────────────── 评审修复回归（🔴2 staging 穿越 / 🟡5 回滚失败语义） ───────────────

test('来源 URL subPath 含 .. → validation-error，clone 不发起（🔴2 Q-038）', async () => {
  const home = makeTemp();
  const skillDir = join(home, '.claude/skills/up1');
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(
    join(skillDir, 'SKILL.md'),
    '---\nname: up1\ndescription: old\nmetadata:\n  source: https://github.com/o/r/tree/main/../../evil\n---\n'
  );
  const scanner = new SkillsScanner({ homeDir: home, userDataPath: join(home, 'ud'), lockProvider: () => ({ up1: { hash: 'a'.repeat(64) } }) });
  await scanner.scan();
  const base = join(home, 's2base');
  let cloneCalled = false;
  const exec = new UpgradeExecutor(
    { ops: createNodeFsOps(), base, scanner, log: new OperationLog(join(base, 'log', 'operations.jsonl')) },
    { gitClone: async () => { cloneCalled = true; } }
  );
  await rejects(
    () => exec.upgrade(skillDir),
    (err: Error) => err instanceof SkillValidationError && err.code === 'validation-error'
  );
  equal(cloneCalled, false, 'clone 未发起');
});

test('回滚自身失败 → skills-io-error（不虚报 rolledBack）+ manifest 保留可自愈（🟡5）', async () => {
  const fx = await makeFixture('remote');
  const ops = createNodeFsOps();
  const origRename = ops.renameSync.bind(ops);
  ops.renameSync = (from: string, to: string) => {
    if (/\.backup$/.test(from)) throw new Error('rollback blocked'); // 回滚 rename 拦截
    if (to === fx.skillDir) throw new Error('replace blocked'); // ② 新版就位失败（触发回滚路径）
    return origRename(from, to); // ① 原版让位放行
  };
  const exec = new UpgradeExecutor(
    { ops, base: fx.base, scanner: fx.scanner, log: new OperationLog(join(fx.base, 'log', 'operations.jsonl')) },
    { gitClone: gitClonerWriting('v2') }
  );
  await rejects(
    () => exec.upgrade(fx.skillDir),
    (err: Error) => err instanceof SkillsIoError && err.code === 'skills-io-error'
  );
  ok(!existsSync(fx.skillDir), '原路径仍空缺（回滚未成功，不虚报已回滚）');
  const manifest = JSON.parse(readFileSync(join(fx.base, 'staging', 'backups.json'), 'utf8'));
  equal(manifest.entries.length, 1, 'manifest 条目保留供自愈');
  // 自愈用干净 ops（被 mock 的 renameSync 会拦截 backup 还原）
  new UpgradeExecutor({
    ops: createNodeFsOps(),
    base: fx.base,
    scanner: fx.scanner,
    log: new OperationLog(join(fx.base, 'log', 'operations.jsonl')),
  }).selfHeal();
  ok(existsSync(join(fx.skillDir, 'SKILL.md')), 'selfHeal 还原原版本');
});

// ─────────────── 生产 npx runner（O-2 接线：spawnChecked / defaultNpxUpdate） ───────────────

test('spawnChecked：零退出 resolve / 非零退出 reject（含 stderr 尾部）', async () => {
  await spawnChecked('true', []);
  await rejects(() => spawnChecked('false', []), (err: Error) => /退出码/.test(err.message));
});

test('spawnChecked：命令不存在（npx 缺失同型）→ reject（ENOENT）', async () => {
  await rejects(() => spawnChecked('hull-no-such-cmd-xyz', []), (err: Error) => /hull-no-such-cmd-xyz/.test(err.message));
});

test('spawnChecked：超时 → reject（120s 预算内 abort，契约上限）', async () => {
  const t0 = Date.now();
  await rejects(() => spawnChecked('sleep', ['5'], { timeoutMs: 100 }), (err: Error) => err instanceof Error);
  ok(Date.now() - t0 < 5000, '超时快速返回而非等满子进程');
});

test('defaultNpxUpdate：数组参数 --no-install skills update <name> + cwd=skill 目录（fake npx 验证，不触网络）', async () => {
  const bin = makeTemp();
  mkdirSync(bin, { recursive: true });
  const fake = join(bin, 'npx');
  writeFileSync(
    fake,
    '#!/bin/sh\n[ "$1" = "--no-install" ] && [ "$2" = "skills" ] && [ "$3" = "update" ] && [ "$4" = "up1" ] || exit 9\npwd\n'
  );
  chmodSync(fake, 0o755);
  const cwdDir = makeTemp();
  const savedPath = process.env.PATH ?? '';
  process.env.PATH = `${bin}:/usr/bin:/bin`;
  try {
    await defaultNpxUpdate(cwdDir, 'up1'); // 参数形状错 → fake exit 9 → reject
    await rejects(() => defaultNpxUpdate(cwdDir, 'wrong-name'), /退出码 9/);
  } finally {
    process.env.PATH = savedPath;
  }
});
