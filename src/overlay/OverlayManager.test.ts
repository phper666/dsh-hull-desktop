import { test, after } from 'node:test';
import { equal, deepEqual, ok, rejects } from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { OverlayManager, type OverlayFs } from './OverlayManager';
import { InstallPhase } from '../shared/types';

const tempDirs: string[] = [];
after(() => {
  for (const d of tempDirs) rmSync(d, { recursive: true, force: true });
});

/** 真实 fs 门面（默认行为副本，测试可覆盖个别操作） */
function realFs(): OverlayFs {
  return {
    exists: (p) => existsSync(p),
    mkdir: (p) => mkdirSync(p, { recursive: true }),
    rm: (p) => rmSync(p, { recursive: true, force: true }),
    rename: (a, b) => renameSync(a, b),
    symlink: (t, p) => symlinkSync(t, p),
    readText: (p) => {
      try {
        return readFileSync(p, 'utf8');
      } catch {
        return null;
      }
    },
  };
}

interface MakeOpts {
  version?: string;
  withBin?: boolean;
  pendingNpm?: boolean;
  fs?: OverlayFs;
}

function makeManager(opts: MakeOpts = {}) {
  const userDataPath = mkdtempSync(join(tmpdir(), 'hull-overlay-'));
  tempDirs.push(userDataPath);
  const events: Array<{ type: string; payload?: unknown }> = [];
  const npmRuns: string[] = [];
  let npmControl: { resolve: () => void; reject: (e: Error) => void } | undefined;
  const mgr = new OverlayManager({
    userDataPath,
    ...(opts.fs ? { fs: opts.fs } : {}),
    runNpmInstall: async (stagingDir) => {
      npmRuns.push(stagingDir);
      if (opts.pendingNpm) {
        return new Promise<void>((resolve, reject) => {
          npmControl = { resolve, reject };
        });
      }
      populateStaging(userDataPath, opts.version ?? '1.0.0', opts.withBin ?? true);
    },
  });
  mgr.on('progress', (p) => events.push({ type: 'progress', payload: p }));
  mgr.on('success', (v) => events.push({ type: 'success', payload: v }));
  mgr.on('cancelled', () => events.push({ type: 'cancelled' }));
  mgr.on('failed', (f) => events.push({ type: 'failed', payload: f }));
  return { mgr, userDataPath, events, npmRuns, getNpmControl: () => npmControl };
}

/** 构造完整 staging（门禁通过）：package.json{version,bin} + node_modules/.bin/dsh */
function populateStaging(userDataPath: string, version: string, withBin: boolean): void {
  const staging = join(userDataPath, 'dsh-staging');
  mkdirSync(join(staging, 'node_modules', '@deepseek-ai', 'dsh'), { recursive: true });
  writeFileSync(
    join(staging, 'node_modules', '@deepseek-ai', 'dsh', 'package.json'),
    JSON.stringify({ name: '@deepseek-ai/dsh', version, bin: { dsh: 'cli.js' } })
  );
  if (withBin) {
    mkdirSync(join(staging, 'node_modules', '.bin'), { recursive: true });
    writeFileSync(join(staging, 'node_modules', '.bin', 'dsh'), '#!/usr/bin/env node\n');
  }
}

/** 构造当前 dsh（旧版） */
function makeOldDsh(userDataPath: string, version: string): void {
  const dsh = join(userDataPath, 'dsh');
  mkdirSync(join(dsh, 'node_modules', '@deepseek-ai', 'dsh'), { recursive: true });
  writeFileSync(
    join(dsh, 'node_modules', '@deepseek-ai', 'dsh', 'package.json'),
    JSON.stringify({ name: '@deepseek-ai/dsh', version, bin: { dsh: 'cli.js' } })
  );
}

test('① 状态机：not-installed→installing→ready + 事件序列', async () => {
  const { mgr, events } = makeManager({ version: '1.0.0' });
  equal(mgr.installStatus().phase, 'not-installed');
  await mgr.install('1.0.0');
  equal(mgr.installStatus().phase, 'installing');
  await mgr.swap();
  equal(mgr.installStatus().phase, 'ready');
  deepEqual(events.map((e) => e.type), ['progress', 'progress', 'progress', 'success']);
  deepEqual(events[0].payload, { phase: 'npm-install', pct: 20 });
  deepEqual(events[1].payload, { phase: 'npm-install', pct: 90 });
  deepEqual(events[2].payload, { phase: 'swap', pct: 100 });
  deepEqual(events[3].payload, { version: '1.0.0' });
});

test('② installing 中重复 install 忽略（npm 只跑 1 次）', async () => {
  const { mgr, npmRuns } = makeManager({ pendingNpm: true });
  void mgr.install('latest'); // 永不 resolve（pendingNpm），不 await
  const s = await mgr.install('latest');
  equal(s.phase, 'installing');
  equal(npmRuns.length, 1);
  await mgr.cancelInstall(); // 清理
});

test('③ swap 序列：staging→dsh 就位 + previous=旧版 + staging 消失', async () => {
  const { mgr, userDataPath } = makeManager({ version: '2.0.0' });
  makeOldDsh(userDataPath, '0.9.0');
  await mgr.install('2.0.0');
  await mgr.swap();
  equal(mgr.currentVersion(), '2.0.0');
  ok(existsSync(join(userDataPath, 'dsh', 'node_modules', '@deepseek-ai', 'dsh', 'package.json')));
  ok(!existsSync(join(userDataPath, 'dsh-staging')), 'staging 已消失');
  const prevPkg = JSON.parse(
    readFileSync(join(userDataPath, 'dsh-previous', 'node_modules', '@deepseek-ai', 'dsh', 'package.json'), 'utf8')
  ) as { version: string };
  equal(prevPkg.version, '0.9.0', 'previous = 旧版');
});

test('④ 首装 swap（无 dsh）：直接就位，不建 previous', async () => {
  const { mgr, userDataPath } = makeManager({ version: '1.0.0' });
  await mgr.install('1.0.0');
  await mgr.swap();
  ok(existsSync(join(userDataPath, 'dsh')));
  ok(!existsSync(join(userDataPath, 'dsh-previous')));
  equal(mgr.currentVersion(), '1.0.0');
});
test('⑤ swap 失败回滚：③ 失败 → dsh 恢复旧版', async () => {
  const { mgr, userDataPath, events } = makeManager({ version: '1.0.0' });
  makeOldDsh(userDataPath, '0.9.0');
  await mgr.install('1.0.0');
  const dshPath = join(userDataPath, 'dsh');
  const base = realFs();
  let failNextDshRename = true;
  const fs: OverlayFs = {
    ...base,
    rename: (a, b) => {
      if (b === dshPath && failNextDshRename) {
        failNextDshRename = false; // 只让 ③（staging→dsh）失败，回滚（previous→dsh）放行
        throw new Error('ENOTDIR: rename staging→dsh 失败');
      }
      base.rename(a, b);
    },
  };
  (mgr as unknown as { fs: OverlayFs }).fs = fs;
  await rejects(mgr.swap(), (e: unknown) => (e as { code: string }).code === 'npm-install-failed');
  equal(mgr.currentVersion(), '0.9.0', 'dsh 恢复旧版');
  equal(mgr.installStatus().phase, 'ready', '旧版可继续使用');
  ok(events.some((e) => e.type === 'failed'), 'failed 事件已发');
});

test('⑥ post-swap symlink：<dsh>/bin/dsh → node_modules/.bin/dsh', async () => {
  const { mgr, userDataPath } = makeManager({ version: '1.0.0' });
  await mgr.install('1.0.0');
  await mgr.swap();
  const link = join(userDataPath, 'dsh', 'bin', 'dsh');
  ok(existsSync(link), 'bin/dsh symlink 存在');
  equal(readlinkSync(link), '../node_modules/.bin/dsh');
});

test('⑦ 版本校验：匹配 targetVersion → ready；不匹配 → failed(version-invalid)', async () => {
  // 匹配
  const a = makeManager({ version: '1.0.0' });
  await a.mgr.install('1.0.0');
  await a.mgr.swap();
  equal(a.mgr.installStatus().phase, 'ready');
  equal(a.mgr.currentVersion(), '1.0.0');
  // 不匹配：staging 2.0.0 vs 目标 1.0.0
  const b = makeManager({ version: '2.0.0' });
  await b.mgr.install('1.0.0');
  await rejects(b.mgr.swap(), (e: unknown) => (e as { code: string }).code === 'version-invalid');
  equal(b.mgr.installStatus().phase, 'not-installed');
  ok(!existsSync(join(b.userDataPath, 'dsh')), '未执行替换');
  ok(!existsSync(join(b.userDataPath, 'dsh-staging')), '失败清 staging');
  ok(b.events.some((e) => e.type === 'failed' && (e.payload as { code: string }).code === 'version-invalid'));
});

test('⑧ pre-swap 门禁：staging 缺 .bin/dsh → 拒绝 swap', async () => {
  const { mgr, userDataPath, events } = makeManager();
  populateStaging(userDataPath, '1.0.0', false); // 不完整 staging（无 .bin/dsh）
  await rejects(mgr.swap(), (e: unknown) => (e as { code: string }).code === 'version-invalid');
  equal(mgr.installStatus().phase, 'not-installed');
  ok(!existsSync(join(userDataPath, 'dsh')));
  ok(!existsSync(join(userDataPath, 'dsh-staging')), '门禁失败清 staging');
  ok(events.some((e) => e.type === 'failed' && (e.payload as { code: string }).code === 'version-invalid'));
});

test('⑨ cancelInstall：installing 中取消 → 清 staging + not-installed + cancelled 事件', async () => {
  const { mgr, userDataPath, events } = makeManager({ pendingNpm: true });
  const p = mgr.install('latest');
  equal(mgr.installStatus().phase, 'installing');
  ok(existsSync(join(userDataPath, 'dsh-staging')));
  const s = await mgr.cancelInstall();
  equal(s.phase, 'not-installed');
  ok(!existsSync(join(userDataPath, 'dsh-staging')));
  ok(events.some((e) => e.type === 'cancelled'));
});

test('⑩ swap 起始后 cancel 忽略', async () => {
  const { mgr, events } = makeManager({ version: '1.0.0' });
  await mgr.install('1.0.0');
  const p = mgr.swap(); // swapping=true 在首个 await 前同步置位
  const s = await mgr.cancelInstall(); // 拦截：swapping → 忽略
  equal(s.phase, 'installing');
  await p;
  equal(mgr.installStatus().phase, 'ready');
  ok(!events.some((e) => e.type === 'cancelled'));
});

test('⑪ installStatus 返回当前 phase + 进度', async () => {
  const { mgr } = makeManager();
  equal(mgr.installStatus().phase, 'not-installed');
  const p = mgr.install('latest');
  equal(mgr.installStatus().phase, 'installing');
  equal(mgr.installStatus().progress?.pct, 20);
  await p;
  equal(mgr.installStatus().progress?.pct, 90);
  await mgr.swap();
  equal(mgr.installStatus().phase, 'ready');
  equal(mgr.installStatus().progress?.pct, 100);
});

test('⑪b pnpm Progress 行解析 → pct 按 added/resolved 渐进（修复恒 20%）', () => {
  const { mgr } = makeManager();
  void mgr.install('latest');
  equal(mgr.installStatus().progress?.pct, 20, '起始 20');
  mgr.onPkgMgrLine('Progress: resolved 100, reused 0, downloaded 10, added 5');
  equal(mgr.installStatus().progress?.pct, 22, '20 + floor(40*5/100)');
  mgr.onPkgMgrLine('Progress: resolved 504, reused 0, downloaded 447, added 442');
  equal(mgr.installStatus().progress?.pct, 55, '20 + floor(40*442/504)，封顶 60 内');
  mgr.onPkgMgrLine('Progress: resolved 504, reused 0, downloaded 447, added 445, done');
  equal(mgr.installStatus().progress?.pct, 60, 'done → 60（installing 段顶格）');
});

test('⑪c npm http fetch 行计数仍生效（npm 路径回归守卫）', () => {
  const { mgr } = makeManager();
  void mgr.install('latest');
  for (let i = 0; i < 25; i++) mgr.onPkgMgrLine('npm http fetch GET https://x');
  equal(mgr.installStatus().progress?.pct, 21, '20 + 25/25 = 21');
});

test('⑫ currentVersion：无 dsh → null；swap 后读 package.json', async () => {
  const { mgr } = makeManager({ version: '2.1.0' });
  equal(mgr.currentVersion(), null);
  await mgr.install('2.1.0');
  await mgr.swap();
  equal(mgr.currentVersion(), '2.1.0');
});

test('⑬ ensure 态1：dsh 存在 → 清 stale staging → ready', async () => {
  const { mgr, userDataPath } = makeManager();
  makeOldDsh(userDataPath, '0.9.0');
  mkdirSync(join(userDataPath, 'dsh-staging'), { recursive: true });
  const phase = await mgr.ensure();
  equal(phase, 'ready');
  equal(mgr.currentVersion(), '0.9.0');
  ok(!existsSync(join(userDataPath, 'dsh-staging')), 'stale staging 已清');
});

test('⑭ ensure 态2：dsh 缺 + staging 在 → 续替完成', async () => {
  const { mgr, userDataPath, events } = makeManager();
  populateStaging(userDataPath, '1.0.0', true);
  const phase = await mgr.ensure();
  equal(phase, 'ready');
  equal(mgr.currentVersion(), '1.0.0');
  ok(!existsSync(join(userDataPath, 'dsh-staging')));
  ok(events.some((e) => e.type === 'success'), '续替成功事件');
});

test('⑮ ensure 态3：dsh 缺 + previous 在 → 回滚', async () => {
  const { mgr, userDataPath } = makeManager();
  const prev = join(userDataPath, 'dsh-previous');
  mkdirSync(join(prev, 'node_modules', '@deepseek-ai', 'dsh'), { recursive: true });
  writeFileSync(
    join(prev, 'node_modules', '@deepseek-ai', 'dsh', 'package.json'),
    JSON.stringify({ name: '@deepseek-ai/dsh', version: '0.5.0', bin: { dsh: 'cli.js' } })
  );
  const phase = await mgr.ensure();
  equal(phase, 'ready');
  equal(mgr.currentVersion(), '0.5.0');
  ok(!existsSync(join(userDataPath, 'dsh-previous')));
});

test('⑯ snapshot 深拷贝：改返回对象不影响内部状态', async () => {
  const { mgr } = makeManager();
  await mgr.install('1.0.0'); // 完成后进度 = npm-install 90%
  const s = mgr.snapshot();
  s.progress = { phase: 'download', pct: 1 }; // 整体替换
  equal(mgr.installStatus().progress?.pct, 90);
  const s2 = mgr.snapshot();
  if (s2.progress) s2.progress.pct = 99; // 嵌套对象修改
  equal(mgr.installStatus().progress?.pct, 90);
  s2.phase = 'ready' as InstallPhase;
  equal(mgr.installStatus().phase, 'installing');
});

test('⑰ ensure 首装（全缺）→ not-installed', async () => {
  const { mgr } = makeManager();
  const phase = await mgr.ensure();
  equal(phase, 'not-installed');
});

test('🟡-1 install 完成→取消→swap：cancelled 语义非 version-invalid', async () => {
  const { mgr, events } = makeManager({ version: '1.0.0' });
  await mgr.install('1.0.0'); // 门禁通过
  await mgr.cancelInstall(); // 取消：rm staging + not-installed + cancelled
  const s = await mgr.swap(); // 修复前：gate 失败 → version-invalid throw；修复后：返回快照
  equal(s.phase, 'not-installed');
  ok(events.some((e) => e.type === 'cancelled'));
  ok(!events.some((e) => e.type === 'failed' && (e.payload as { code: string }).code === 'version-invalid'));
});

test('🟡-2 首装 swap ③ 失败（无 previous）：throw cancelled 语义', async () => {
  const { mgr, userDataPath } = makeManager({ version: '1.0.0' });
  await mgr.install('1.0.0');
  const dshPath = join(userDataPath, 'dsh');
  const base = realFs();
  let failNextDshRename = true;
  const fs: OverlayFs = {
    ...base,
    rename: (a, b) => {
      if (b === dshPath && failNextDshRename) {
        failNextDshRename = false;
        throw new Error('ENOTDIR');
      }
      base.rename(a, b);
    },
  };
  (mgr as unknown as { fs: OverlayFs }).fs = fs;
  await rejects(mgr.swap(), (e: unknown) => (e as { code: string }).code === 'cancelled');
  equal(mgr.installStatus().phase, 'not-installed');
});

test('🟡-3 symlink 失败降级：重试一次 → 仍败走回滚 + swapping 复位', async () => {
  const { mgr, userDataPath } = makeManager({ version: '1.0.0' });
  makeOldDsh(userDataPath, '0.9.0');
  await mgr.install('1.0.0');
  const base = realFs();
  let symlinkFails = 2; // 首次 + 重试均失败
  const badFs: OverlayFs = {
    ...base,
    symlink: (t, p) => {
      if (symlinkFails > 0) {
        symlinkFails -= 1;
        throw new Error('EACCES');
      }
      base.symlink(t, p);
    },
  };
  (mgr as unknown as { fs: OverlayFs }).fs = badFs;
  await rejects(mgr.swap(), (e: unknown) => (e as { code: string }).code === 'npm-install-failed');
  equal(mgr.currentVersion(), '0.9.0', '回滚至旧版');
  // swapping 已复位：修复 fs 后二次安装正常（若 swapping 卡死，二次 swap 会直接返回快照）
  (mgr as unknown as { fs: OverlayFs }).fs = base;
  await mgr.install('1.0.0');
  await mgr.swap();
  equal(mgr.currentVersion(), '1.0.0');
});

test('🟡-3b symlink 失败一次 → 重试成功 → swap 正常完成', async () => {
  const { mgr, userDataPath } = makeManager({ version: '1.0.0' });
  await mgr.install('1.0.0');
  const base = realFs();
  let symlinkFails = 1;
  const fs: OverlayFs = {
    ...base,
    symlink: (t, p) => {
      if (symlinkFails > 0) {
        symlinkFails -= 1;
        throw new Error('EACCES');
      }
      base.symlink(t, p);
    },
  };
  (mgr as unknown as { fs: OverlayFs }).fs = fs;
  await mgr.swap();
  equal(mgr.installStatus().phase, 'ready');
  equal(mgr.currentVersion(), '1.0.0');
});

test('🟡-4 ensure 态3：回滚 rename 失败 → not-installed（自动重装路径）', async () => {
  const { mgr, userDataPath } = makeManager();
  mkdirSync(join(userDataPath, 'dsh-previous'), { recursive: true });
  const base = realFs();
  const fs: OverlayFs = {
    ...base,
    rename: () => {
      throw new Error('EACCES');
    },
  };
  (mgr as unknown as { fs: OverlayFs }).fs = fs;
  const phase = await mgr.ensure();
  equal(phase, 'not-installed');
});

test('🟢-1 install catch：取消后 npm 抛错 → 不发 failed（防双事件）', async () => {
  const { mgr, events, getNpmControl } = makeManager({ pendingNpm: true });
  const p = mgr.install('latest');
  await mgr.cancelInstall();
  getNpmControl()!.reject(new Error('npm ENOENT'));
  const s = await p;
  equal(s.phase, 'not-installed');
  ok(events.some((e) => e.type === 'cancelled'));
  ok(!events.some((e) => e.type === 'failed'), '不应再有 failed 事件');
});

test('S3-① swapBack 正常回滚：dsh→staging 保留现场 + previous→dsh + currentVersion 回写', async () => {
  const { mgr, userDataPath } = makeManager({ version: '1.0.0' });
  makeOldDsh(userDataPath, '0.9.0');
  await mgr.install('1.0.0');
  await mgr.swap(); // dsh=1.0.0, previous=0.9.0
  const s = await mgr.swapBack();
  equal(s.phase, 'ready');
  equal(mgr.currentVersion(), '0.9.0', '版本回读为 previous 版本');
  ok(!existsSync(join(userDataPath, 'dsh-previous')), 'previous 已消耗');
  const stagingPkg = JSON.parse(
    readFileSync(join(userDataPath, 'dsh-staging', 'node_modules', '@deepseek-ai', 'dsh', 'package.json'), 'utf8')
  ) as { version: string };
  equal(stagingPkg.version, '1.0.0', '新版本保留在 staging（现场）');
});

test('S3-② swapBack 无 previous → 错误语义 rollback-unavailable', async () => {
  const { mgr, userDataPath } = makeManager({ version: '1.0.0' });
  makeOldDsh(userDataPath, '0.9.0');
  await mgr.install('1.0.0');
  await mgr.swap();
  const base = realFs();
  (mgr as unknown as { fs: OverlayFs }).fs = base;
  // 模拟 previous 缺失（直接删除 previous 目录）
  rmSync(join(userDataPath, 'dsh-previous'), { recursive: true, force: true });
  await rejects(mgr.swapBack(), (e: unknown) => (e as { code: string }).code === 'rollback-unavailable');
});

test('S3-③ swapBack ① 失败（dsh→staging）→ 原状保留可重试', async () => {
  const { mgr, userDataPath } = makeManager({ version: '1.0.0' });
  makeOldDsh(userDataPath, '0.9.0');
  await mgr.install('1.0.0');
  await mgr.swap();
  const dshPath = join(userDataPath, 'dsh');
  const stagingPath = join(userDataPath, 'dsh-staging');
  const base = realFs();
  let failDshToStaging = true;
  const fs: OverlayFs = {
    ...base,
    rename: (a, b) => {
      if (a === dshPath && b === stagingPath && failDshToStaging) {
        failDshToStaging = false;
        throw new Error('EACCES');
      }
      base.rename(a, b);
    },
  };
  (mgr as unknown as { fs: OverlayFs }).fs = fs;
  await rejects(mgr.swapBack(), (e: unknown) => (e as { code: string }).code === 'npm-install-failed');
  equal(mgr.currentVersion(), '1.0.0', 'dsh 未动');
  ok(existsSync(join(userDataPath, 'dsh-previous')), 'previous 保留');
  // 修复 fs 后重试成功
  (mgr as unknown as { fs: OverlayFs }).fs = base;
  await mgr.swapBack();
  equal(mgr.currentVersion(), '0.9.0');
});

test('S3-④ swapBack ② 失败（previous→dsh）→ staging 现场还原', async () => {
  const { mgr, userDataPath, events } = makeManager({ version: '1.0.0' });
  makeOldDsh(userDataPath, '0.9.0');
  await mgr.install('1.0.0');
  await mgr.swap();
  const dshPath = join(userDataPath, 'dsh');
  const base = realFs();
  let failNextToDsh = true;
  const fs: OverlayFs = {
    ...base,
    rename: (a, b) => {
      if (b === dshPath && failNextToDsh) {
        failNextToDsh = false; // 只让 ②（previous→dsh）失败，现场还原（staging→dsh）放行
        throw new Error('ENOTDIR');
      }
      base.rename(a, b);
    },
  };
  (mgr as unknown as { fs: OverlayFs }).fs = fs;
  await rejects(mgr.swapBack(), (e: unknown) => (e as { code: string }).code === 'npm-install-failed');
  equal(mgr.currentVersion(), '1.0.0', 'dsh 还原为新版（现场还原）');
  ok(!existsSync(join(userDataPath, 'dsh-staging')), 'staging 已还原消耗');
  ok(existsSync(join(userDataPath, 'dsh-previous')), 'previous 保留待重试');
  ok(events.some((e) => e.type === 'failed'));
});

test('S3-⑤ swapBack 幂等：回滚后再回滚 → rollback-unavailable', async () => {
  const { mgr, userDataPath } = makeManager({ version: '1.0.0' });
  makeOldDsh(userDataPath, '0.9.0');
  await mgr.install('1.0.0');
  await mgr.swap();
  await mgr.swapBack();
  equal(mgr.currentVersion(), '0.9.0');
  await rejects(mgr.swapBack(), (e: unknown) => (e as { code: string }).code === 'rollback-unavailable');
});

test('S3-⑥ swapBack 后 bin symlink 状态：恢复目录上重建', async () => {
  const { mgr, userDataPath } = makeManager({ version: '1.0.0' });
  makeOldDsh(userDataPath, '0.9.0'); // 旧版无 bin/（重建核对点）
  await mgr.install('1.0.0');
  await mgr.swap();
  await mgr.swapBack();
  const link = join(userDataPath, 'dsh', 'bin', 'dsh');
  ok(readlinkSync(link) === '../node_modules/.bin/dsh', '恢复目录上 bin symlink 已重建');
});
