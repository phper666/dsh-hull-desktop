#!/usr/bin/env node
/**
 * 构建期脚本：下载 Node 24 LTS 锁定小版本（darwin-arm64）并做 SHA256 校验（设计 S2 D6 / 评审 Tier 2）。
 *
 * 用法：node scripts/fetch-node.mjs [--version <ver>]
 *   - 默认锁定版常量 DEFAULT_NODE_VERSION（S2 交付时核对官方 dist index 更新）
 *   - 镜像：NODE_MIRROR env（默认 https://nodejs.org/dist）
 * 产物：vendor/node-<version>-darwin-arm64/（解压后含 bin/node、lib/node_modules/npm；vendor/ 已 gitignore）
 *
 * 行为：
 *   - 目标版本目录已存在 → 直接复用（先前的解压必经 checksum 校验），离线可用
 *   - 目录缺失 → 下载 tarball → 拉取 SHASUMS256.txt 校验 SHA256（不匹配 → 非零退出，防供应链污染）
 *     → tar 解压 → 删除 tarball → 输出 node 路径与版本
 *   - 网络失败/校验失败 → 报错退出非零（构建期失败即可见）
 */

import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const PLATFORM = 'darwin-arm64'; // CON-R006：仅 macOS Apple Silicon
/** 锁定小版本常量（契约：Node 24 LTS，构建锁定小版本；S2 交付时核对官方 dist index 更新） */
const DEFAULT_NODE_VERSION = '24.10.0';
const MIRROR = (process.env.NODE_MIRROR ?? 'https://nodejs.org/dist').replace(/\/+$/, '');
const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const VENDOR_DIR = join(ROOT, 'vendor');

/** 严格版本校验（防路径穿越/注入——版本号进入 URL 与文件路径） */
function parseVersion(argv) {
  const i = argv.indexOf('--version');
  const ver = i !== -1 && argv[i + 1] ? argv[i + 1] : DEFAULT_NODE_VERSION;
  if (!/^\d+\.\d+\.\d+$/.test(ver)) {
    throw new Error(`非法版本号: ${ver}（须为 x.y.z）`);
  }
  return ver;
}

function sha256Hex(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

/** 从 SHASUMS256.txt 提取目标 tarball 的 sha256（行格式：<sha>  node-v<ver>-darwin-arm64.tar.gz） */
function findChecksum(shasums, fileName) {
  const line = shasums.split('\n').find((l) => l.trim().endsWith(`  ${fileName}`) || l.trim().endsWith(` ${fileName}`));
  if (!line) throw new Error(`SHASUMS256.txt 中未找到 ${fileName}`);
  return line.trim().split(/\s+/)[0].toLowerCase();
}

async function main() {
  const version = parseVersion(process.argv.slice(2));
  const targetDir = join(VENDOR_DIR, `node-${version}-${PLATFORM}`);
  const tarballName = `node-v${version}-${PLATFORM}.tar.gz`;
  const tarballPath = join(VENDOR_DIR, tarballName);
  const nodeBin = join(targetDir, 'bin', 'node');

  mkdirSync(VENDOR_DIR, { recursive: true });

  // 幂等：目标版本目录已存在 → 直接复用（先前解压必经 checksum 校验）
  if (existsSync(targetDir) && existsSync(nodeBin)) {
    console.log(`[fetch-node] 复用已存在产物: ${targetDir}`);
    printResult(nodeBin, version);
    return;
  }

  // 目录缺失（或残缺）→ 清场后下载
  rmSync(targetDir, { recursive: true, force: true });

  // 下载 tarball（已有缓存则跳过下载，仍做 checksum 校验——评审裁决：已存在产物校验通过才复用）
  let tarballBuf = null;
  if (existsSync(tarballPath)) {
    tarballBuf = await import('node:fs/promises').then((m) => m.readFile(tarballPath));
    console.log(`[fetch-node] 复用缓存 tarball: ${tarballPath}`);
  } else {
    const url = `${MIRROR}/v${version}/${tarballName}`;
    console.log(`[fetch-node] 下载 ${url}`);
    const res = await fetch(url);
    if (!res.ok) throw new Error(`下载失败: ${url} → HTTP ${res.status}`);
    tarballBuf = Buffer.from(await res.arrayBuffer());
  }

  // SHA256 校验（防供应链污染；不匹配 → 抛错非零退出）
  const shasumsUrl = `${MIRROR}/v${version}/SHASUMS256.txt`;
  console.log(`[fetch-node] 拉取校验和 ${shasumsUrl}`);
  const shasumsRes = await fetch(shasumsUrl);
  if (!shasumsRes.ok) throw new Error(`SHASUMS256.txt 拉取失败: ${shasumsUrl} → HTTP ${shasumsRes.status}`);
  const expected = findChecksum(await shasumsRes.text(), tarballName);
  const actual = sha256Hex(tarballBuf);
  if (actual !== expected) {
    throw new Error(`SHA256 校验失败: ${tarballName}\n  expected ${expected}\n  actual   ${actual}`);
  }
  console.log(`[fetch-node] SHA256 校验通过: ${actual.slice(0, 16)}…`);

  // 落盘 + 解压（系统 tar，darwin-arm64 tarball 布局：node-v<ver>-darwin-arm64/ → 重命名为目标目录）
  writeFileSync(tarballPath, tarballBuf);
  const extractTmp = join(tmpdir(), `hull-node-extract-${version}-${process.pid}`);
  rmSync(extractTmp, { recursive: true, force: true });
  mkdirSync(extractTmp, { recursive: true });
  const tar = spawnSync('tar', ['-xzf', tarballPath, '-C', extractTmp], { stdio: 'inherit' });
  rmSync(tarballPath, { force: true }); // 校验通过后清理 tarball，目录即产物
  if (tar.status !== 0) {
    rmSync(extractTmp, { recursive: true, force: true });
    throw new Error(`tar 解压失败（exit ${tar.status ?? tar.error?.message}）`);
  }
  const extracted = join(extractTmp, `node-v${version}-${PLATFORM}`);
  if (!existsSync(join(extracted, 'bin', 'node'))) {
    rmSync(extractTmp, { recursive: true, force: true });
    throw new Error(`解压产物缺少 bin/node: ${extracted}`);
  }
  rmSync(targetDir, { recursive: true, force: true });
  spawnSync('mv', [extracted, targetDir], { stdio: 'inherit' });
  rmSync(extractTmp, { recursive: true, force: true });
  chmodSync(nodeBin, 0o755);

  console.log(`[fetch-node] 完成: ${targetDir}`);
  printResult(nodeBin, version);
}

function printResult(nodeBin, version) {
  console.log(`[fetch-node] node 路径: ${nodeBin}`);
  console.log(`[fetch-node] 版本: v${version}`);
}

main().catch((err) => {
  console.error(`[fetch-node] 失败: ${err.message}`);
  process.exitCode = 1;
});
