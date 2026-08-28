/**
 * P0-1 git tree 签名单测（设计决策 1/4，docs/design/SK-1-升级检测增强-skills-upgrade-design.md）
 * gitBlobSha1 对照 git 真实 blob SHA-1 固定样例（git hash-object 实测）；
 * computeGitBlobSignature（本地）与模拟远端 tree 数据签名必须相等（两端同源一致，否则恒误报可升级）；
 * RemoteSigCache TTL / 持久化 / 损坏容错；parseGithubSourceForTree / repoKey。
 */
import { test } from 'node:test';
import { deepEqual, equal, ok, rejects } from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { createNodeFsOps } from './SkillFsOps';
import {
  REMOTE_SIG_TTL_MS,
  RemoteSigCache,
  computeGitBlobSignature,
  fetchTreeSignature,
  gitBlobSha1,
  parseGithubSourceForTree,
  repoKey,
  signatureFromFiles,
  signatureFromTreeEntries,
  type TreeEntry,
} from './gitTree';

const ops = createNodeFsOps();
const tempDirs: string[] = [];
function makeDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'hull-gittree-'));
  tempDirs.push(dir);
  return dir;
}
test.after(() => {
  for (const d of tempDirs) rmSync(d, { recursive: true, force: true });
});

test('gitBlobSha1：对照 git 真实 blob SHA-1 固定样例', () => {
  // 固定样例由 git hash-object 实测（canonical git blob 对象哈希）
  equal(gitBlobSha1('hello world\n'), '3b18e512dba79e4c8300dd08aeb37f8e728b8dad');
  equal(gitBlobSha1('line1\nline2\n'), 'c0d0fb45c382919737f8d0c20aaf57cf89b74af8');
  // Buffer 与 string 同结果
  equal(gitBlobSha1(Buffer.from('hello world\n', 'utf8')), '3b18e512dba79e4c8300dd08aeb37f8e728b8dad');
});

test('signatureFromFiles：排序稳定（输入顺序无关）+ 同 relpath 不同 sha 签名不同', () => {
  const a = signatureFromFiles([
    ['b.txt', 'sha2'],
    ['a.txt', 'sha1'],
  ]);
  const b = signatureFromFiles([
    ['a.txt', 'sha1'],
    ['b.txt', 'sha2'],
  ]);
  equal(a, b, '输入顺序无关');
  const c = signatureFromFiles([
    ['a.txt', 'sha1'],
    ['a.txt', 'sha2'],
  ]);
  ok(a !== c, '内容不同签名不同');
});

test('computeGitBlobSignature：确定 + symlink 跳过 + 内容变化响应', async () => {
  const dir = makeDir();
  writeFileSync(join(dir, 'a.txt'), 'hello world\n');
  mkdirSync(join(dir, 'sub'));
  writeFileSync(join(dir, 'sub', 'b.md'), 'line1\nline2\n');
  const s1 = await computeGitBlobSignature(ops, dir);
  const s2 = await computeGitBlobSignature(ops, dir);
  equal(s1, s2, '同一目录两次计算相等');
  symlinkSync(join(dir, 'a.txt'), join(dir, 'link.txt')); // symlink 不跟随
  equal(await computeGitBlobSignature(ops, dir), s1, 'symlink 不参与签名');
  writeFileSync(join(dir, 'a.txt'), 'changed\n');
  ok((await computeGitBlobSignature(ops, dir)) !== s1, '内容变化 → 签名变化');
});

test('两端签名一致：本地 computeGitBlobSignature == 模拟远端 tree 签名（同内容）', async () => {
  const dir = makeDir();
  writeFileSync(join(dir, 'a.txt'), 'hello world\n');
  mkdirSync(join(dir, 'sub'));
  writeFileSync(join(dir, 'sub', 'b.md'), 'line1\nline2\n');
  const localSig = await computeGitBlobSignature(ops, dir);
  const remoteEntries: TreeEntry[] = [
    { path: 'a.txt', type: 'blob', sha: gitBlobSha1('hello world\n') }, // GitHub tree sha 即 git blob SHA-1
    { path: 'sub/b.md', type: 'blob', sha: gitBlobSha1('line1\nline2\n') },
    { path: 'sub', type: 'tree', sha: 'x'.repeat(40) }, // 非 blob 忽略
  ];
  const remoteSig = signatureFromTreeEntries(remoteEntries, '');
  equal(localSig, remoteSig, '同一目录内容两端签名必须相等（否则恒误报可升级）');
});

test('subPath 场景两端一致：本地目录 vs 远端树前缀过滤', async () => {
  const dir = makeDir();
  writeFileSync(join(dir, 'SKILL.md'), '# x\n');
  writeFileSync(join(dir, 'lib.js'), '// c\n');
  const localSig = await computeGitBlobSignature(ops, dir);
  const remoteEntries: TreeEntry[] = [
    { path: 'skills/foo/SKILL.md', type: 'blob', sha: gitBlobSha1('# x\n') },
    { path: 'skills/foo/lib.js', type: 'blob', sha: gitBlobSha1('// c\n') },
    { path: 'skills/other/SKILL.md', type: 'blob', sha: gitBlobSha1('# y\n') }, // 前缀外排除
  ];
  equal(signatureFromTreeEntries(remoteEntries, 'skills/foo'), localSig);
});

test('fetchTreeSignature：注入 mock 拉取解析 + 失败抛错', async () => {
  const entries: TreeEntry[] = [{ path: 'SKILL.md', type: 'blob', sha: gitBlobSha1('# x\n') }];
  let calls = 0;
  const sig = await fetchTreeSignature('o', 'r', 'main', '', async (owner, repo, branch) => {
    calls++;
    equal(owner, 'o');
    equal(repo, 'r');
    equal(branch, 'main');
    return entries;
  });
  equal(calls, 1);
  equal(sig, signatureFromFiles([['SKILL.md', gitBlobSha1('# x\n')]]));
  await rejects(() => fetchTreeSignature('o', 'r', 'main', '', async () => { throw new Error('boom'); }), /boom/);
});

test('parseGithubSourceForTree：分支/子路径/.git/非 GitHub', () => {
  deepEqual(parseGithubSourceForTree('https://github.com/o/r'), { owner: 'o', repo: 'r', branch: 'HEAD', subPath: '' });
  deepEqual(parseGithubSourceForTree('https://github.com/o/r.git'), { owner: 'o', repo: 'r', branch: 'HEAD', subPath: '' });
  deepEqual(parseGithubSourceForTree('https://github.com/o/r/tree/main'), { owner: 'o', repo: 'r', branch: 'main', subPath: '' });
  deepEqual(parseGithubSourceForTree('https://github.com/o/r/tree/main/skills/foo/'), {
    owner: 'o',
    repo: 'r',
    branch: 'main',
    subPath: 'skills/foo',
  });
  equal(parseGithubSourceForTree('https://gitlab.com/o/r'), null);
  equal(parseGithubSourceForTree('ftp://github.com/o/r'), null);
  equal(parseGithubSourceForTree(null), null);
  equal(parseGithubSourceForTree(''), null);
});

test('repoKey：owner/repo 消歧 + branch + subPath', () => {
  equal(repoKey({ owner: 'o', repo: 'r', branch: 'main', subPath: 'skills/foo' }), 'o/r#main#skills/foo');
  equal(repoKey({ owner: 'o2', repo: 'r', branch: 'main', subPath: 'skills/foo' }), 'o2/r#main#skills/foo');
});

test('RemoteSigCache：TTL 命中 / 过期 / 缺失', () => {
  const c = new RemoteSigCache();
  c.set('o/r#main#sub', 'sig1', 1000);
  equal(c.get('o/r#main#sub', 2000), 'sig1');
  equal(c.get('o/r#main#sub', 1000 + REMOTE_SIG_TTL_MS + 1), null, 'TTL 过期 → null');
  equal(c.get('missing', 2000), null);
});

test('RemoteSigCache：持久化 roundtrip + 损坏容错', async () => {
  const file = join(makeDir(), 'remote-sig-cache.json');
  const c1 = new RemoteSigCache(file);
  await c1.load();
  c1.set('a/b#main#', 'sigA', 5000);
  await c1.save();
  const c2 = new RemoteSigCache(file);
  await c2.load();
  equal(c2.get('a/b#main#', 6000), 'sigA');
  writeFileSync(file, '{not json');
  const c3 = new RemoteSigCache(file);
  await c3.load();
  equal(c3.get('a/b#main#', 6000), null, '损坏 → 空缓存重建');
});
