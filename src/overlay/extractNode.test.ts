import { test, after } from 'node:test';
import { equal, ok, rejects } from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { extractBundledNode, isNodeExtracted } from './extractNode';

const tempDirs: string[] = [];
after(() => {
  for (const d of tempDirs) rmSync(d, { recursive: true, force: true });
});

function makeTmp(prefix: string): string {
  const d = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  tempDirs.push(d);
  return d;
}

test('PK2-① darwin/linux 布局：resources/node/bin/node → userData/node 整树复制', async () => {
  const resources = makeTmp('hull-res-');
  const nodeSrc = join(resources, 'node');
  mkdirSync(join(nodeSrc, 'bin'), { recursive: true });
  writeFileSync(join(nodeSrc, 'bin', 'node'), '#!/bin/sh\n');
  writeFileSync(join(nodeSrc, 'node-version.txt'), 'v24.10.0\n');
  const nodeDir = join(makeTmp('hull-dest-'), 'node');
  await extractBundledNode(resources, nodeDir);
  ok(existsSync(join(nodeDir, 'bin', 'node')), 'bin/node 复制');
  ok(existsSync(join(nodeDir, 'node-version.txt')), '版本文件复制');
  equal(isNodeExtracted(nodeDir), true);
});

test('PK2-② win 布局：resources/node/node.exe（根，无 bin/）→ 复制 + isNodeExtracted 识别', async () => {
  const resources = makeTmp('hull-res-');
  const nodeSrc = join(resources, 'node');
  mkdirSync(nodeSrc, { recursive: true });
  writeFileSync(join(nodeSrc, 'node.exe'), 'MZ fake\n');
  writeFileSync(join(nodeSrc, 'node-version.txt'), 'v24.10.0\n');
  const nodeDir = join(makeTmp('hull-dest-'), 'node');
  await extractBundledNode(resources, nodeDir);
  ok(existsSync(join(nodeDir, 'node.exe')), 'node.exe 复制');
  ok(!existsSync(join(nodeDir, 'bin')), 'win 布局无 bin/ 目录');
  equal(isNodeExtracted(nodeDir), true);
});

test('PK2-③ 资源缺失（dev 无捆绑）→ reject（InstallFlow dev 分支兜底）', async () => {
  const resources = makeTmp('hull-res-'); // 无 node/ 子目录
  await rejects(extractBundledNode(resources, join(makeTmp('hull-dest-'), 'node')), /node 资源缺失/);
});

test('PK2-④ 资源缺可执行文件 → reject', async () => {
  const resources = makeTmp('hull-res-');
  const nodeSrc = join(resources, 'node');
  mkdirSync(nodeSrc, { recursive: true });
  writeFileSync(join(nodeSrc, 'node-version.txt'), 'v24.10.0\n'); // 无 node 二进制
  await rejects(extractBundledNode(resources, join(makeTmp('hull-dest-'), 'node')), /缺少可执行/);
});

test('PK2-⑤ isNodeExtracted：缺二进制 / 缺版本文件 → false', async () => {
  const nodeDir = makeTmp('hull-part-');
  // 空目录
  equal(isNodeExtracted(nodeDir), false);
  // 只有版本文件
  writeFileSync(join(nodeDir, 'node-version.txt'), 'v24.10.0\n');
  equal(isNodeExtracted(nodeDir), false);
  // 只有二进制
  rmSync(join(nodeDir, 'node-version.txt'));
  writeFileSync(join(nodeDir, 'node.exe'), 'MZ\n');
  equal(isNodeExtracted(nodeDir), false);
});
