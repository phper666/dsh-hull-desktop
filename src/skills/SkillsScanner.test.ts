/**
 * S1 扫描器单测（CON-R-skills-001/002/005/009，设计 D2/D4/§4.1/§4.2）
 * 临时目录注入（Q-037）：注册表遍历聚合 / 全局-scoped 判定 / realpath 去重 /
 * 缺目录跳过 / 坏条目降级 / symlink 循环跳过 / 状态机幂等 / 快照原子替换
 */
import { test } from 'node:test';
import { deepEqual, equal, ok } from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { SkillsScanner } from './SkillsScanner';
import { computeGitBlobSignature, gitBlobSha1, type TreeEntry } from './gitTree';
import { createNodeFsOps } from './SkillFsOps';
import type { SkillEntry } from './types';

const tempDirs: string[] = [];
function makeHome(): string {
  const dir = mkdtempSync(join(tmpdir(), 'hull-skills-scan-'));
  tempDirs.push(dir);
  return dir;
}
test.after(() => {
  for (const d of tempDirs) rmSync(d, { recursive: true, force: true });
});

/** 在 home 下建 skill：<regDir>/<name>/SKILL.md */
function makeSkill(home: string, regDir: string, name: string, fm: Record<string, string> = {}): string {
  const dir = join(home, regDir, name);
  mkdirSync(dir, { recursive: true });
  const lines = ['---', `name: ${fm.name ?? name}`, `description: ${fm.description ?? `${name} 描述`}`];
  if (fm.source) lines.push('metadata:', `  source: ${fm.source}`);
  lines.push('---', `# ${name}`);
  writeFileSync(join(dir, 'SKILL.md'), lines.join('\n'));
  return dir;
}

function byName(entries: SkillEntry[], name: string): SkillEntry {
  const e = entries.find((x) => x.name === name);
  ok(e, `应存在 skill ${name}`);
  return e!;
}

test('六目录扫描聚合：全局判定 + scoped 判定 + 平台徽标（T1/T2/T3/T5）', async () => {
  const home = makeHome();
  makeSkill(home, '.agents/skills', 'alpha'); // universal
  makeSkill(home, '.claude/skills', 'beta');
  makeSkill(home, '.config/opencode/skills', 'gamma');

  const s = new SkillsScanner({ homeDir: home, userDataPath: join(home, 'ud') });
  await s.scan();
  const snap = s.snapshot();
  equal(snap.status, 'ready');
  equal(snap.entries.length, 3);

  const alpha = byName(snap.entries, 'alpha');
  equal(alpha.scope, 'global'); // ~/.agents = universal
  deepEqual([...alpha.platforms].sort(), [
    'cline',
    'codex',
    'cursor',
    'devin',
    'dsh',
    'gemini-cli',
    'opencode',
    'roo',
    'warp',
    'windsurf',
  ]);

  const beta = byName(snap.entries, 'beta');
  equal(beta.scope, 'scoped');
  deepEqual(beta.platforms, ['claude-code', 'cursor', 'opencode', 'warp']); // ~/.claude 被 opencode/cursor/warp 同时读取（排序）

  const gamma = byName(snap.entries, 'gamma');
  deepEqual(gamma.platforms, ['opencode']); // ~/.config/opencode 专属
});

test('realpath 同源去重：symlink 指向 shared 只计一条，paths 保留两物理位置（T4/Q-031 粒度）', async () => {
  const home = makeHome();
  const real = makeSkill(home, '.agents/skills', 'dup');
  mkdirSync(join(home, '.claude/skills'), { recursive: true });
  symlinkSync(real, join(home, '.claude/skills/dup'), 'dir');

  const s = new SkillsScanner({ homeDir: home, userDataPath: join(home, 'ud') });
  await s.scan();
  const snap = s.snapshot();
  equal(snap.entries.length, 1); // 不重复计数
  const dup = snap.entries[0];
  equal(dup.name, 'dup');
  equal(dup.scope, 'global'); // realpath 落于 ~/.agents
  equal(dup.paths.length, 2); // 两个物理位置各自独立（S2 按路径操作）
  deepEqual([...dup.platforms].sort(), [
    'claude-code',
    'cline',
    'codex',
    'cursor',
    'devin',
    'dsh',
    'gemini-cli',
    'opencode',
    'roo',
    'warp',
    'windsurf',
  ]);
  ok(dup.paths.every((p) => p.mtimeMs > 0));
  ok(dup.paths.some((p) => p.isSymlink));
  ok(dup.paths.some((p) => !p.isSymlink));
});

test('同名不同 realpath 跨目录合并：platforms 并集 + scope=global + 描述取全局路径优先', async () => {
  const home = makeHome();
  makeSkill(home, '.agents/skills', 'multi', { description: '全局版描述' });
  makeSkill(home, '.cursor/skills', 'multi', { description: 'cursor 版描述' });

  const s = new SkillsScanner({ homeDir: home, userDataPath: join(home, 'ud') });
  await s.scan();
  const snap = s.snapshot();
  equal(snap.entries.length, 1);
  const m = snap.entries[0];
  equal(m.scope, 'global');
  equal(m.paths.length, 2);
  ok(m.platforms.includes('cursor'));
  equal(m.description, '全局版描述'); // 全局（shared）优先
});

test('frontmatter.name 与目录名不一致 → 按 frontmatter name 聚合', async () => {
  const home = makeHome();
  makeSkill(home, '.claude/skills', 'dirname-x', { name: 'real-name' });
  const s = new SkillsScanner({ homeDir: home, userDataPath: join(home, 'ud') });
  await s.scan();
  equal(s.snapshot().entries.length, 1);
  equal(s.snapshot().entries[0].name, 'real-name');
});

test('缺目录跳过不报错；SKILL.md 缺失/坏 YAML → 目录名兜底 + 无描述占位（T1/T7）', async () => {
  const home = makeHome();
  makeSkill(home, '.claude/skills', 'good');
  mkdirSync(join(home, '.claude/skills/noskillmd'), { recursive: true }); // 无 SKILL.md
  mkdirSync(join(home, '.claude/skills/badyaml'), { recursive: true });
  writeFileSync(join(home, '.claude/skills/badyaml/SKILL.md'), '不是 frontmatter 的内容');
  // .codex 目录整个不存在

  const s = new SkillsScanner({ homeDir: home, userDataPath: join(home, 'ud') });
  await s.scan();
  const snap = s.snapshot();
  equal(snap.status, 'ready');
  equal(snap.entries.length, 3);
  equal(byName(snap.entries, 'noskillmd').description, null);
  equal(byName(snap.entries, 'badyaml').description, null);
  equal(byName(snap.entries, 'badyaml').source, null);
});

test('symlink 循环与悬空链接：跳过该项不阻塞整体（T18）', async () => {
  const home = makeHome();
  makeSkill(home, '.claude/skills', 'fine');
  mkdirSync(join(home, '.claude/skills'), { recursive: true });
  symlinkSync(join(home, '.claude/skills/loop-a'), join(home, '.claude/skills/loop-b'), 'dir');
  symlinkSync(join(home, '.claude/skills/loop-b'), join(home, '.claude/skills/loop-a'), 'dir'); // 循环
  symlinkSync(join(home, 'nowhere'), join(home, '.claude/skills/dangling'), 'dir'); // 悬空

  const s = new SkillsScanner({ homeDir: home, userDataPath: join(home, 'ud') });
  await s.scan();
  const snap = s.snapshot();
  equal(snap.status, 'ready');
  equal(snap.entries.length, 1);
  equal(snap.entries[0].name, 'fine');
});

test('来源三级降级：metadata.source 采用；无来源 source=null（T8/T10）', async () => {
  const home = makeHome();
  makeSkill(home, '.claude/skills', 'withsrc', { source: 'https://github.com/o/r' });
  makeSkill(home, '.claude/skills', 'nosrc');
  // withsrc 触发 P0-1 梯子 pending → 注入 stub fetchTree 保证测试离线封闭（不触真实网络）
  const s = new SkillsScanner({ homeDir: home, userDataPath: join(home, 'ud'), fetchTree: async () => [] });
  await s.scan();
  await s.waitForPrefetch();
  equal(byName(s.snapshot().entries, 'withsrc').source, 'https://github.com/o/r');
  equal(byName(s.snapshot().entries, 'nosrc').source, null);
});

test('lockProvider 注入远端哈希 → upgradable 判定；source 不再从 lock 推断（Q-034 变更）', async () => {
  const home = makeHome();
  makeSkill(home, '.claude/skills', 'locked');
  const ud = join(home, 'ud');
  mkdirSync(ud, { recursive: true });
  // lockProvider 注入远端哈希（生产不再读 skills-lock.json；来源仅 frontmatter metadata.source）
  const hashOfReal = 'a'.repeat(64);
  const s = new SkillsScanner({
    homeDir: home,
    userDataPath: ud,
    lockProvider: () => ({ locked: { source: 'https://github.com/o/r', skillPath: 'skills/locked', hash: hashOfReal } }),
  });
  await s.scan();
  const locked = byName(s.snapshot().entries, 'locked');
  // source 不参与来源推断（lock 二级降级已移除）→ null「来源未知」
  equal(locked.source, null);
  equal(locked.remoteHash, hashOfReal);
  // 本地哈希 ≠ 远端哈希 → upgradable
  equal(locked.upgradable, 'upgradable');
  ok(/^[0-9a-f]{64}$/.test(locked.localHash!));

  // 远端哈希一致 → latest；无注入 → unknown
  const s2 = new SkillsScanner({
    homeDir: home,
    userDataPath: ud,
    lockProvider: () => ({ locked: { hash: byName(s.snapshot().entries, 'locked').localHash! } }),
  });
  await s2.scan();
  equal(byName(s2.snapshot().entries, 'locked').upgradable, 'latest');

  makeSkill(home, '.claude/skills', 'nolockinfo');
  const s3 = new SkillsScanner({ homeDir: home, userDataPath: ud, lockProvider: () => ({}) });
  await s3.scan();
  equal(byName(s3.snapshot().entries, 'nolockinfo').upgradable, 'unknown');
});

test('远端哈希二级来源：lock 缺条目回退 .arkcli-managed-skills.json；坏文件不崩（Q-034 二级）', async () => {
  const home = makeHome();
  makeSkill(home, '.claude/skills', 'lockwin'); // ①② 都有 → 一级优先
  makeSkill(home, '.claude/skills', 'arkonly'); // 仅二级有
  makeSkill(home, '.claude/skills', 'nohash'); // 均无
  const arkcliPath = join(home, '.config/opencode/skills/.arkcli-managed-skills.json');
  mkdirSync(join(home, '.config/opencode/skills'), { recursive: true });
  const arkHash = 'b'.repeat(64);
  writeFileSync(
    arkcliPath,
    JSON.stringify({ schema: 1, owner: 'arkcli', product: 'arkcli-volc', skills: { lockwin: 'c'.repeat(64), arkonly: arkHash } })
  );

  const mk = (lock: Record<string, unknown>) =>
    new SkillsScanner({ homeDir: home, userDataPath: join(home, 'ud'), lockProvider: () => lock as never });

  // 一级优先：skills-lock 有条目时不看 arkcli
  const s1 = await mk({ lockwin: { hash: 'a'.repeat(64) } }).scan();
  equal(byName(s1.entries, 'lockwin').remoteHash, 'a'.repeat(64));

  // 二级回退：lock 无条目 → arkcli hash → upgradable
  const s2 = await mk({}).scan();
  const ark = byName(s2.entries, 'arkonly');
  equal(ark.remoteHash, arkHash);
  equal(ark.upgradable, 'upgradable');

  // 均无 → null + unknown
  const nohash = byName(s2.entries, 'nohash');
  equal(nohash.remoteHash, null);
  equal(nohash.upgradable, 'unknown');

  // 坏 JSON / 缺 skills 字段 → 防御性 {}，不崩不误判
  writeFileSync(arkcliPath, '{not json');
  const s3 = await mk({}).scan();
  equal(byName(s3.entries, 'arkonly').remoteHash, null);
  equal(s3.status, 'ready');
  writeFileSync(arkcliPath, JSON.stringify({ schema: 1 }));
  const s4 = await mk({}).scan();
  equal(byName(s4.entries, 'arkonly').remoteHash, null);
});

test('状态机：idle→scanning→ready；scanning 中重复 scan 幂等；旧快照持续可读（FR-10）', async () => {
  const home = makeHome();
  makeSkill(home, '.claude/skills', 'one');
  const s = new SkillsScanner({ homeDir: home, userDataPath: join(home, 'ud') });

  equal(s.snapshot().status, 'idle');
  equal(s.snapshot().entries.length, 0);

  const [r1, r2] = await Promise.all([s.scan(), s.scan()]); // 并发幂等
  equal(r1.status, 'ready');
  equal(r1.lastScanAt, r2.lastScanAt, '同一管线结果（未重启）');
  equal(r1.entries.length, 1);

  makeSkill(home, '.claude/skills', 'two');
  const p = s.scan(); // 不等待
  equal(s.snapshot().status, 'scanning');
  equal(s.snapshot().entries.length, 1, 'scanning 中返回上次 ready 快照');
  await p;
  equal(s.snapshot().entries.length, 2);
  ok(s.snapshot().lastScanAt!.startsWith('20'));
});

test('致命错误（userData 不可写）→ status=error + error 原因，可重试', async () => {
  const home = makeHome();
  makeSkill(home, '.claude/skills', 'x');
  // userDataPath 落在一个文件上 → 缓存目录创建失败 → 致命错误
  const filePathAsUd = join(home, 'udfile');
  writeFileSync(filePathAsUd, 'not a dir');
  const s = new SkillsScanner({ homeDir: home, userDataPath: filePathAsUd });
  const snap = await s.scan();
  equal(snap.status, 'error');
  ok(snap.error && snap.error.length > 0);
});

test('getStatus 计数派生（T15）：total/upgradable/disabled/global', async () => {
  const home = makeHome();
  makeSkill(home, '.agents/skills', 'g1');
  makeSkill(home, '.claude/skills', 's1');
  const s = new SkillsScanner({ homeDir: home, userDataPath: join(home, 'ud') });
  let counts = s.statusCounts();
  deepEqual(counts, { total: 0, upgradable: 0, disabled: 0, global: 0 }); // 未扫描全 0
  await s.scan();
  counts = s.statusCounts();
  equal(counts.total, 2);
  equal(counts.global, 1);
  equal(counts.disabled, 0); // S1 恒 enabled
});

// ─────────────────────────── P0-1 后台预取 + P0-2 lint（设计 SK-1） ───────────────────────────

/** P0-1 预取测试专用：可门控的 fetchTree（resolve 前断言同步态） */
function gatedFetch(entries: TreeEntry[]): { fetchTree: (o: string, r: string, b: string) => Promise<TreeEntry[]>; gate: (v: TreeEntry[]) => void } {
  let resolveGate: (v: TreeEntry[]) => void;
  const gate = new Promise<TreeEntry[]>((res) => {
    resolveGate = res;
  });
  return {
    fetchTree: async () => gate.then(() => entries),
    gate: (v) => resolveGate!(v),
  };
}

test('P0-1 后台预取：同步扫描不应用远端签名（unknown）→ 预取后本地==远端 → latest + 缓存落盘', async () => {
  const home = makeHome();
  const dir = makeSkill(home, '.claude/skills', 'ghskill', { source: 'https://github.com/o/r/tree/main' });
  writeFileSync(join(dir, 'extra.txt'), 'x\n');
  // 与 makeSkill 写入 SKILL.md 完全一致的字节 → 本地 blob sha == 远端 tree sha → latest
  const fmContent = ['---', 'name: ghskill', 'description: ghskill 描述', 'metadata:', '  source: https://github.com/o/r/tree/main', '---', '# ghskill'].join('\n');
  const entries: TreeEntry[] = [
    { path: 'SKILL.md', type: 'blob', sha: gitBlobSha1(fmContent) },
    { path: 'extra.txt', type: 'blob', sha: gitBlobSha1('x\n') },
  ];
  const g = gatedFetch(entries);
  const s = new SkillsScanner({ homeDir: home, userDataPath: join(home, 'ud'), fetchTree: g.fetchTree });
  await s.scan();
  equal(s.snapshot().status, 'ready');
  equal(byName(s.snapshot().entries, 'ghskill').upgradable, 'unknown', '同步未应用远端签名（<2s 不阻塞）');
  g.gate(entries); // 放行预取
  await s.waitForPrefetch();
  const after = byName(s.snapshot().entries, 'ghskill');
  equal(after.upgradable, 'latest', '两端签名一致 → latest');
  ok(after.remoteHash, '远端哈希已回填');
  ok(existsSync(join(home, 'ud', 'skills', 'remote-sig-cache.json')), '预取写缓存落盘');
});

test('P0-1 预取后本地≠远端 → upgradable（可升级）', async () => {
  const home = makeHome();
  makeSkill(home, '.claude/skills', 'gh2', { source: 'https://github.com/o/r/tree/main' });
  const s = new SkillsScanner({
    homeDir: home,
    userDataPath: join(home, 'ud'),
    fetchTree: async () => [{ path: 'SKILL.md', type: 'blob', sha: 'd'.repeat(40) }], // 远端内容不同
  });
  await s.scan();
  await s.waitForPrefetch();
  const e = byName(s.snapshot().entries, 'gh2');
  equal(e.upgradable, 'upgradable');
  ok(e.remoteHash && /^[0-9a-f]{64}$/.test(e.remoteHash), '远端签名为 64 位 hex（非原始 blob sha）');
});

test('P0-1 同 {owner,repo,branch} 合并一次 tree 请求（subPath 各自算签名）', async () => {
  const home = makeHome();
  makeSkill(home, '.claude/skills', 'ga', { source: 'https://github.com/o/r/tree/main/a' });
  makeSkill(home, '.claude/skills', 'gb', { source: 'https://github.com/o/r/tree/main/b' });
  let calls = 0;
  const s = new SkillsScanner({
    homeDir: home,
    userDataPath: join(home, 'ud'),
    fetchTree: async () => {
      calls++;
      return [];
    },
  });
  await s.scan();
  await s.waitForPrefetch();
  equal(calls, 1, '同 repo 共享一次 tree 请求');
});

test('P0-1 lock 命中 → 不进预取（② 跳过，避免重复网络请求）', async () => {
  const home = makeHome();
  makeSkill(home, '.claude/skills', 'locked2', { source: 'https://github.com/o/r/tree/main' });
  let fetched = 0;
  const s = new SkillsScanner({
    homeDir: home,
    userDataPath: join(home, 'ud'),
    lockProvider: () => ({ locked2: { hash: 'z'.repeat(64) } }),
    fetchTree: async () => {
      fetched++;
      return [];
    },
  });
  await s.scan();
  await s.waitForPrefetch();
  equal(fetched, 0);
  equal(byName(s.snapshot().entries, 'locked2').remoteHash, 'z'.repeat(64));
});

test('P0-1 预取失败 → 静默降级 unknown（下次扫描重试）', async () => {
  const home = makeHome();
  makeSkill(home, '.claude/skills', 'gh3', { source: 'https://github.com/o/r' });
  const s = new SkillsScanner({
    homeDir: home,
    userDataPath: join(home, 'ud'),
    fetchTree: async () => {
      throw new Error('boom');
    },
  });
  await s.scan();
  await s.waitForPrefetch();
  const e = byName(s.snapshot().entries, 'gh3');
  equal(e.upgradable, 'unknown');
  equal(e.remoteHash, null);
  equal(s.snapshot().refreshing, false);
});

test('P0-1 缓存命中（决策 4）：扫描即 latest，不触发预取', async () => {
  const home = makeHome();
  const dir = makeSkill(home, '.claude/skills', 'ghc', { source: 'https://github.com/o/r/tree/main' });
  writeFileSync(join(dir, 'extra.txt'), 'x\n');
  // 预热：先扫一次（pending→预取写缓存 + gitblob 签名），再手动把远端签名写成与本地 git 签名一致 → 二次扫描缓存命中即 latest
  const s1 = new SkillsScanner({ homeDir: home, userDataPath: join(home, 'ud'), fetchTree: async () => [] });
  await s1.scan();
  await s1.waitForPrefetch();
  const cacheFile = join(home, 'ud', 'skills', 'remote-sig-cache.json');
  const localGitSig = await computeGitBlobSignature(createNodeFsOps(), dir);
  writeFileSync(cacheFile, JSON.stringify({ version: 1, entries: { 'o/r#main#': { sig: localGitSig, at: Date.now() } } }));
  // 二次扫描：缓存命中 → 同步即 latest，无预取
  let fetched = 0;
  const s2 = new SkillsScanner({
    homeDir: home,
    userDataPath: join(home, 'ud'),
    fetchTree: async () => {
      fetched++;
      return [];
    },
  });
  await s2.scan();
  equal(byName(s2.snapshot().entries, 'ghc').upgradable, 'latest', '缓存命中同步即 latest');
  equal(fetched, 0, '缓存命中不触发预取');
  equal(s2.snapshot().refreshing, undefined, '无预取 → 无 refreshing 标志');
});

test('P0-2 lint 标注：健康条目无 lint 字段；缺 SKILL.md 条目带 warn lint', async () => {
  const home = makeHome();
  makeSkill(home, '.claude/skills', 'okskill', { source: 'https://github.com/o/r' }); // 健康（name+desc+https source）
  mkdirSync(join(home, '.claude/skills', 'nolintok'), { recursive: true }); // 无 SKILL.md → warn
  const s = new SkillsScanner({ homeDir: home, userDataPath: join(home, 'ud'), fetchTree: async () => [] });
  await s.scan();
  const okSkill = byName(s.snapshot().entries, 'okskill');
  equal(okSkill.lint, undefined, '健康条目不标注');
  const bad = byName(s.snapshot().entries, 'nolintok');
  equal(bad.lint?.level, 'warn');
  ok(bad.lint!.issues.length >= 2);
  ok(bad.lint!.issues.some((i) => i.includes('name')));
});
