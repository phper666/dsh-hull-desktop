#!/usr/bin/env node
/**
 * 构建期脚本：下载 Node 24 LTS 锁定小版本（按平台参数化）并做 SHA256 校验（设计 S2 D6 / 评审 Tier 2 / PK2 CON-R-packaging-003）。
 *
 * 用法：node scripts/fetch-node.mjs [--version <ver>] [--platform <name>]
 *   - 默认锁定版常量 DEFAULT_NODE_VERSION（S2 交付时核对官方 dist index 更新）
 *   - 平台：darwin-arm64（默认，向后兼容）/ win32-x64 / linux-x64
 *   - 镜像：NODE_MIRROR env（默认 https://nodejs.org/dist）
 * 产物：
 *   - darwin-arm64 → vendor/node-<version>-darwin-arm64/（bin/node + lib/node_modules/npm）
 *   - linux-x64     → vendor/node-<version>-linux-x64/（bin/node + lib/node_modules/npm）
 *   - win32-x64     → vendor/node-<version>-win32-x64/（node.exe 在目录根，无 bin/）
 *   （vendor/ 已 gitignore）
 *
 * 行为：
 *   - 目标版本目录已存在 → 直接复用（先前的解压必经 checksum 校验），离线可用
 *   - 目录缺失 → 下载归档 → 拉取 SHASUMS256.txt 校验 SHA256（不匹配 → 非零退出，防供应链污染）
 *     → 按平台解压（tar.gz/tar.xz 用 tar；win zip 用 tar/bsdtar 兜底 unzip）→ 删除归档 → 输出 node 路径与版本
 *   - 网络失败/校验失败 → 报错退出非零（构建期失败即可见）
 *   - CON-R-packaging-008：下载失败不阻塞壳本身（壳仍可装；只是无捆绑 node → PATH 兜底）
 */

import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** 平台注册表（PK2：各平台归档格式/布局/二进制路径不同——BE 扫描发现） */
const PLATFORMS = {
  'darwin-arm64': { ext: 'tar.gz', tarFlags: '-xzf', bin: join('bin', 'node') },
  'linux-x64': { ext: 'tar.xz', tarFlags: '-xJf', bin: join('bin', 'node') },
  'win32-x64': { ext: 'zip', tarFlags: null, bin: 'node.exe' }, // win zip 根为 node.exe（无 bin/）
};

const DEFAULT_PLATFORM = 'darwin-arm64'; // 向后兼容：不带 --platform 行为不变
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

/** 平台参数解析（白名单——防注入；未知平台 → 报错） */
function parsePlatform(argv) {
  const i = argv.indexOf('--platform');
  const name = i !== -1 && argv[i + 1] ? argv[i + 1] : DEFAULT_PLATFORM;
  if (!PLATFORMS[name]) {
    throw new Error(`未知平台: ${name}（支持 ${Object.keys(PLATFORMS).join(' / ')}）`);
  }
  return { name, spec: PLATFORMS[name] };
}

function sha256Hex(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

/** 从 SHASUMS256.txt 提取目标归档的 sha256（行格式：<sha>  node-v<ver>-<platform>.<ext>） */
function findChecksum(shasums, fileName) {
  const line = shasums.split('\n').find((l) => l.trim().endsWith(`  ${fileName}`) || l.trim().endsWith(` ${fileName}`));
  if (!line) throw new Error(`SHASUMS256.txt 中未找到 ${fileName}`);
  return line.trim().split(/\s+/)[0].toLowerCase();
}

/** 解压归档（按平台分支；返回解压到的临时目录） */
function extractArchive(archivePath, destDir, spec, platformLabel) {
  if (spec.tarFlags) {
    const r = spawnSync('tar', [spec.tarFlags, archivePath, '-C', destDir], { stdio: 'inherit' });
    if (r.status !== 0) throw new Error(`tar 解压失败（exit ${r.status ?? r.error?.message}）`);
    return;
  }
  // win zip：mac/linux/win10+ 的 bsdtar 都能解 zip（CON-R-packaging-007：win 在 win 机器上打）
  let r = spawnSync('tar', ['-xf', archivePath, '-C', destDir], { stdio: 'inherit' });
  if (r.status !== 0) {
    // 兜底：unzip（POSIX）或 PowerShell Expand-Archive（win 无 bsdtar 时）
    const unzip = spawnSync('unzip', ['-q', archivePath, '-d', destDir], { stdio: 'inherit' });
    if (unzip.status !== 0) throw new Error(`zip 解压失败（tar exit ${r.status}, unzip exit ${unzip.status}）`);
  }
  void platformLabel;
}

async function main() {
  const version = parseVersion(process.argv.slice(2));
  const { name: platform, spec } = parsePlatform(process.argv.slice(2));
  const targetDir = join(VENDOR_DIR, `node-${version}-${platform}`);
  const archiveName = `node-v${version}-${platform}.${spec.ext}`;
  const archivePath = join(VENDOR_DIR, archiveName);
  const nodeBin = join(targetDir, spec.bin);

  mkdirSync(VENDOR_DIR, { recursive: true });

  // 幂等：目标版本目录已存在 → 直接复用（先前解压必经 checksum 校验）
  if (existsSync(targetDir) && existsSync(nodeBin)) {
    console.log(`[fetch-node] 复用已存在产物: ${targetDir}`);
    printResult(nodeBin, version, platform);
    return;
  }

  // 目录缺失（或残缺）→ 清场后下载
  rmSync(targetDir, { recursive: true, force: true });

  // 下载归档（已有缓存则跳过下载，仍做 checksum 校验——评审裁决：已存在产物校验通过才复用）
  let archiveBuf = null;
  if (existsSync(archivePath)) {
    archiveBuf = await import('node:fs/promises').then((m) => m.readFile(archivePath));
    console.log(`[fetch-node] 复用缓存归档: ${archivePath}`);
  } else {
    const url = `${MIRROR}/v${version}/${archiveName}`;
    console.log(`[fetch-node] 下载 ${url}`);
    const res = await fetch(url);
    if (!res.ok) throw new Error(`下载失败: ${url} → HTTP ${res.status}`);
    archiveBuf = Buffer.from(await res.arrayBuffer());
  }

  // SHA256 校验（防供应链污染；不匹配 → 抛错非零退出）
  const shasumsUrl = `${MIRROR}/v${version}/SHASUMS256.txt`;
  console.log(`[fetch-node] 拉取校验和 ${shasumsUrl}`);
  const shasumsRes = await fetch(shasumsUrl);
  if (!shasumsRes.ok) throw new Error(`SHASUMS256.txt 拉取失败: ${shasumsUrl} → HTTP ${shasumsRes.status}`);
  const expected = findChecksum(await shasumsRes.text(), archiveName);
  const actual = sha256Hex(archiveBuf);
  if (actual !== expected) {
    throw new Error(`SHA256 校验失败: ${archiveName}\n  expected ${expected}\n  actual   ${actual}`);
  }
  console.log(`[fetch-node] SHA256 校验通过: ${actual.slice(0, 16)}…`);

  // 落盘 + 解压（归档布局：node-v<ver>-<platform>/ → 重命名为目标目录）
  writeFileSync(archivePath, archiveBuf);
  const extractTmp = join(tmpdir(), `hull-node-extract-${version}-${platform}-${process.pid}`);
  rmSync(extractTmp, { recursive: true, force: true });
  mkdirSync(extractTmp, { recursive: true });
  extractArchive(archivePath, extractTmp, spec, platform);
  rmSync(archivePath, { force: true }); // 校验通过后清理归档，目录即产物

  const extracted = join(extractTmp, `node-v${version}-${platform}`);
  if (!existsSync(join(extracted, spec.bin))) {
    rmSync(extractTmp, { recursive: true, force: true });
    throw new Error(`解压产物缺少 ${spec.bin}: ${extracted}`);
  }
  rmSync(targetDir, { recursive: true, force: true });
  spawnSync('mv', [extracted, targetDir], { stdio: 'inherit' });
  rmSync(extractTmp, { recursive: true, force: true });
  chmodSync(nodeBin, 0o755);
  // 版本文件（PK2 extractNode 完整性校验依据：node-version.txt 随树复制到 userData/node）
  writeFileSync(join(targetDir, 'node-version.txt'), `v${version}\n`, 'utf8');

  console.log(`[fetch-node] 完成: ${targetDir}`);
  printResult(nodeBin, version, platform);
}

function printResult(nodeBin, version, platform) {
  console.log(`[fetch-node] node 路径: ${nodeBin}`);
  console.log(`[fetch-node] 版本: v${version} (${platform})`);
}

main().catch((err) => {
  console.error(`[fetch-node] 失败: ${err.message}`);
  process.exitCode = 1;
});
