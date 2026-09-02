import { test } from 'node:test';
import { equal, ok } from 'node:assert/strict';
import { mkdtempSync, mkdirSync, symlinkSync, readlinkSync, existsSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { relinkStaleJunctions } from './relinkJunctions';

/** 构造 pnpm Windows 布局模拟：junction 用真实 symlink 表示（lstat/readlink 行为同构）。
 *  旧根 <tmp>/dsh-staging 下：顶层包链接 + .pnpm/<pkg>/node_modules 依赖链接，全部绝对路径指向旧根。 */
function makeStaleTree(oldRoot: string): void {
  const pnpm = join(oldRoot, 'node_modules', '.pnpm');
  // 包1：内容目录（.pnpm/foo@1/node_modules/foo = 真实目录）
  const pkg1Real = join(pnpm, 'foo@1', 'node_modules', 'foo');
  mkdirSync(pkg1Real, { recursive: true });
  writeFileSync(join(pkg1Real, 'index.js'), 'x');
  // 顶层 node_modules/foo → junction 指向旧根 .pnpm（pnpm Windows 绝对路径语义）
  mkdirSync(join(oldRoot, 'node_modules'), { recursive: true });
  symlinkSync(join(pnpm, 'foo@1', 'node_modules', 'foo'), join(oldRoot, 'node_modules', 'foo'), 'junction');
  // 顶层 scoped：node_modules/@scope/bar → junction
  const barReal = join(pnpm, 'bar@1', 'node_modules', 'bar');
  mkdirSync(barReal, { recursive: true });
  mkdirSync(join(oldRoot, 'node_modules', '@scope'), { recursive: true });
  symlinkSync(barReal, join(oldRoot, 'node_modules', '@scope', 'bar'), 'junction');
  // .pnpm/foo@1/node_modules/bar → 依赖链接（junction）
  symlinkSync(barReal, join(pnpm, 'foo@1', 'node_modules', 'bar'), 'junction');
  // .pnpm/node_modules（pnpm 根级虚拟 store）：hoist 所有包 → junction（曾漏扫，client-ui 解析断链根因）
  mkdirSync(join(pnpm, 'node_modules', '@deepseek-ai'), { recursive: true });
  symlinkSync(barReal, join(pnpm, 'node_modules', '@deepseek-ai', 'bar'), 'junction');
  // 包内容里混一个 symlink（不应被触碰/遍历）
  symlinkSync(join(oldRoot, 'decoy'), join(pkg1Real, 'decoy-link'), 'junction');
  // 非 stale 链接（指向 oldRoot 之外）→ 不动
  const external = join(tmpdir(), `hull-relink-external-${process.pid}`);
  mkdirSync(external, { recursive: true });
  symlinkSync(external, join(oldRoot, 'node_modules', 'ext'), 'junction');
}

test('relink：swap 后悬空 junction 重建为前缀改写（dsh-staging → dsh）', async () => {
  const base = mkdtempSync(join(tmpdir(), 'hull-relink-'));
  const oldRoot = join(base, 'dsh-staging');
  const newRoot = join(base, 'dsh');
  makeStaleTree(oldRoot);
  // 模拟 swap：复制树到新根（junction 在新根下仍是悬空绝对路径——指向 oldRoot）
  rmSync(newRoot, { recursive: true, force: true });
  symlinkSync(oldRoot, join(base, 'copy-probe'), 'junction'); // 占位防误删
  // 简单 cp -R 等价：重建目录结构 + 链接（mac 无 cp junction 语义，用 fs 手动拷贝链接）
  copyTree(oldRoot, newRoot);

  const r = await relinkStaleJunctions(newRoot, oldRoot);

  equal(r.fixed, 4, '四个 stale 链接全部重建（含 .pnpm/node_modules 根级虚拟 store）');
  equal(r.seen, 5, '遍历到 5 个链接（4 stale + 1 外部）');
  equal(r.failed.length, 0, '零失败');
  // 顶层 foo：现指向 newRoot 下的 .pnpm
  const fooTarget = readlinkSync(join(newRoot, 'node_modules', 'foo'));
  ok(fooTarget.startsWith(newRoot), `顶层链接应指向新根，实际 ${fooTarget}`);
  ok(existsSync(join(newRoot, 'node_modules', 'foo')), '重建后链接可解析');
  // scoped bar
  const barTarget = readlinkSync(join(newRoot, 'node_modules', '@scope', 'bar'));
  ok(barTarget.startsWith(newRoot), `scoped 链接应指向新根，实际 ${barTarget}`);
  // .pnpm 内依赖链接
  const depTarget = readlinkSync(join(newRoot, 'node_modules', '.pnpm', 'foo@1', 'node_modules', 'bar'));
  ok(depTarget.startsWith(newRoot), `依赖链接应指向新根，实际 ${depTarget}`);
  // .pnpm/node_modules 根级虚拟 store 链接（client-ui bundle 解析链）
  const storeTarget = readlinkSync(join(newRoot, 'node_modules', '.pnpm', 'node_modules', '@deepseek-ai', 'bar'));
  ok(storeTarget.startsWith(newRoot), `虚拟 store 链接应指向新根，实际 ${storeTarget}`);
  ok(existsSync(join(newRoot, 'node_modules', '.pnpm', 'node_modules', '@deepseek-ai', 'bar')), '虚拟 store 链接可解析');
  // 包内容 decoy 未触碰（仍指 oldRoot）
  const decoy = readlinkSync(join(newRoot, 'node_modules', '.pnpm', 'foo@1', 'node_modules', 'foo', 'decoy-link'));
  ok(decoy.startsWith(oldRoot), '包内容内 symlink 不应被遍历/触碰');
  // 外部链接不动
  const ext = readlinkSync(join(newRoot, 'node_modules', 'ext'));
  ok(!ext.startsWith(oldRoot) && !ext.startsWith(newRoot), '非 stale 链接不动');
});

test('relink：无 stale 链接 → 返回 0，无副作用', async () => {
  const base = mkdtempSync(join(tmpdir(), 'hull-relink-'));
  const root = join(base, 'dsh');
  mkdirSync(join(root, 'node_modules', 'pkg'), { recursive: true });
  writeFileSync(join(root, 'node_modules', 'pkg', 'i.js'), 'x');
  equal((await relinkStaleJunctions(root, join(base, 'dsh-staging'))).fixed, 0);
});

/** 测试辅助：递归拷贝（symlink 保留为链接） */
function copyTree(src: string, dest: string): void {
  const { readdirSync, lstatSync, mkdirSync, copyFileSync, symlinkSync } = require('node:fs') as typeof import('node:fs');
  mkdirSync(dest, { recursive: true });
  for (const name of readdirSync(src)) {
    const s = join(src, name);
    const d = join(dest, name);
    const st = lstatSync(s);
    if (st.isSymbolicLink()) symlinkSync(readlinkSync(s), d, 'junction');
    else if (st.isDirectory()) copyTree(s, d);
    else copyFileSync(s, d);
  }
}
