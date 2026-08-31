import { test } from 'node:test';
import { equal } from 'node:assert/strict';
import { join } from 'node:path';

import { corepackBinFor, npmCliPathFor, resolveExecutablePath } from './npmRunner';

// ---------- corepackBinFor：平台布局差异 ----------

test('win32 布局：corepack JS 入口 = <dir>/node_modules/corepack/dist/corepack.js（node.exe 同级）', () => {
  const nodePath = join('C:', 'Program Files', 'nodejs', 'node.exe');
  equal(corepackBinFor(nodePath, 'win32'), join('C:', 'Program Files', 'nodejs', 'node_modules', 'corepack', 'dist', 'corepack.js'));
});

test('win32 捆绑 node 布局同构：userData/node/node.exe → userData/node/node_modules/corepack/dist/...', () => {
  const nodePath = join('C:', 'Users', 'u', 'AppData', 'Roaming', 'dsh-hull-desktop', 'node', 'node.exe');
  equal(corepackBinFor(nodePath, 'win32'), join('C:', 'Users', 'u', 'AppData', 'Roaming', 'dsh-hull-desktop', 'node', 'node_modules', 'corepack', 'dist', 'corepack.js'));
});

test('POSIX 布局：bin/corepack（symlink→JS）——现状不变（回归守卫）', () => {
  equal(corepackBinFor('/usr/local/fake-node/bin/node', 'darwin'), '/usr/local/fake-node/bin/corepack');
});

// ---------- npmCliPathFor：平台布局差异 ----------

test('win32 布局：npm-cli.js = <dir>/node_modules/npm/bin/npm-cli.js', () => {
  const nodePath = join('C:', 'Program Files', 'nodejs', 'node.exe');
  equal(npmCliPathFor(nodePath, 'win32'), join('C:', 'Program Files', 'nodejs', 'node_modules', 'npm', 'bin', 'npm-cli.js'));
});

test('POSIX 布局：<dir>/../lib/node_modules/npm/bin/npm-cli.js——现状不变（回归守卫）', () => {
  equal(npmCliPathFor('/usr/local/fake-node/bin/node', 'linux'), '/usr/local/fake-node/lib/node_modules/npm/bin/npm-cli.js');
});

// ---------- resolveExecutablePath：Windows PATH 分隔符 + .exe 后缀 ----------

test('win32：PATH 按 ; 切分 + 补 .exe 匹配 node.exe', () => {
  const dirA = join('C:', 'Program Files', 'nodejs');
  const dirB = join('C:', 'Windows', 'System32');
  const found = resolveExecutablePath('node', {
    platform: 'win32',
    pathEnv: `${dirB};${dirA}`,
    exists: (p) => p === join(dirA, 'node.exe'),
  });
  equal(found, join(dirA, 'node.exe'));
});

test('win32：无后缀文件也匹配（先裸名后 .exe）', () => {
  const dirA = join('C:', 'tools');
  const found = resolveExecutablePath('foo', {
    platform: 'win32',
    pathEnv: `${dirA}`,
    exists: (p) => p === join(dirA, 'foo'),
  });
  equal(found, join(dirA, 'foo'));
});

test('win32：找不到 → 原样返回（spawn 报错更清晰）', () => {
  const out = resolveExecutablePath('nope', { platform: 'win32', pathEnv: 'C:\\x', exists: () => false });
  equal(out, 'nope');
});

test('POSIX：PATH 按 : 切分（回归守卫）', () => {
  const found = resolveExecutablePath('node', {
    platform: 'darwin',
    pathEnv: '/usr/bin:/usr/local/fake-node/bin',
    exists: (p) => p === '/usr/local/fake-node/bin/node',
  });
  equal(found, '/usr/local/fake-node/bin/node');
});

test('绝对路径原样返回（两平台一致）', () => {
  const p = join('C:', 'x', 'node.exe');
  equal(resolveExecutablePath(p, { platform: 'win32', pathEnv: '', exists: () => false }), p);
  equal(resolveExecutablePath('/abs/node', { platform: 'darwin', pathEnv: '', exists: () => false }), '/abs/node');
});
