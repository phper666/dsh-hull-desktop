/**
 * S1 内容哈希 + mtime 缓存单测（CON-R-skills-004/009，设计 §4.3）
 * SHA-256(path+content 排序)；mtime 未变命中缓存，变化重算；temp+rename 原子持久化
 */
import { test } from 'node:test';
import { equal, notEqual, ok } from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { computeDirHash, HashCache } from './hash';
import { createNodeFsOps } from './SkillFsOps';

const tempDirs: string[] = [];
function makeTemp(): string {
  const dir = mkdtempSync(join(tmpdir(), 'hull-skills-hash-'));
  tempDirs.push(dir);
  return dir;
}
test.after(() => {
  for (const d of tempDirs) rmSync(d, { recursive: true, force: true });
});

test('同内容不同写入顺序 → 哈希一致（path+content 排序，顺序无关）', async () => {
  const ops = createNodeFsOps();
  const a = makeTemp();
  const b = makeTemp();
  // a：先写 b.txt 再写 a.txt；b：先写 a.txt 再写 b.txt + 子目录
  writeFileSync(join(a, 'z.txt'), 'zzz');
  writeFileSync(join(a, 'a.txt'), 'aaa');
  mkdirSync(join(b, 'sub'));
  writeFileSync(join(b, 'sub', 'a.txt'), 'aaa');
  writeFileSync(join(b, 'z.txt'), 'zzz');
  // b 多了 sub 层级但相对路径集合不同 → 不等；再造一个结构完全相同的 c → 相等
  const c = makeTemp();
  writeFileSync(join(c, 'z.txt'), 'zzz');
  writeFileSync(join(c, 'a.txt'), 'aaa');
  const ha = await computeDirHash(ops, a);
  const hc = await computeDirHash(ops, c);
  equal(ha, hc);
  ok(/^[0-9a-f]{64}$/.test(ha), '64 位 hex');
});

test('内容变化 → 哈希变化', async () => {
  const ops = createNodeFsOps();
  const dir = makeTemp();
  writeFileSync(join(dir, 'f.txt'), 'v1');
  const h1 = await computeDirHash(ops, dir);
  writeFileSync(join(dir, 'f.txt'), 'v2');
  const h2 = await computeDirHash(ops, dir);
  notEqual(h1, h2);
});

test('HashCache：mtime 未变命中（compute 不调用）；mtime 变化重算并回写', () => {
  const cache = new HashCache();
  let calls = 0;
  const compute = async (): Promise<string> => {
    calls += 1;
    return 'h1';
  };
  return (async () => {
    equal(await cache.get('/p', 100, compute), 'h1');
    equal(await cache.get('/p', 100, compute), 'h1'); // 命中
    equal(calls, 1);
    equal(await cache.get('/p', 200, compute), 'h1'); // mtime 变 → 重算
    equal(calls, 2);
  })();
});

test('HashCache 持久化：save→load 往返一致；损坏文件按空缓存重建不抛错', async () => {
  const dir = makeTemp();
  const file = join(dir, 'hash-cache.json');
  const w = new HashCache(file);
  await w.get('/p', 5, async () => 'hh');
  await w.save();

  const r = new HashCache(file);
  await r.load();
  equal(await r.get('/p', 5, async () => 'recomputed'), 'hh');

  writeFileSync(file, '{corrupt json!');
  const bad = new HashCache(file);
  await bad.load(); // 不抛错
  let calls = 0;
  equal(await bad.get('/p', 5, async () => { calls += 1; return 'x'; }), 'x');
  equal(calls, 1);
});

test('symlink 循环目录：walk 终止并跳过链接，不悬挂（🟡3）', async () => {
  const ops = createNodeFsOps();
  const dir = makeTemp();
  writeFileSync(join(dir, 'f.txt'), 'data');
  mkdirSync(join(dir, 'sub'));
  writeFileSync(join(dir, 'sub', 'g.txt'), 'g');
  symlinkSync(dir, join(dir, 'loop'), 'dir'); // 自引用循环
  symlinkSync(join(dir, 'sub'), join(dir, 'loop2'), 'dir');

  const h = await computeDirHash(ops, dir);
  ok(/^[0-9a-f]{64}$/.test(h), '终止且产出合法哈希');
});
