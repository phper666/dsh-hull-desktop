#!/usr/bin/env node
/**
 * semver 三档 bump（C2 版本 bump 策略，CON-R-cicd-003）。
 * 读 package.json version → 按档位递增 → 写回 → 打印新版本。
 * 纯函数可单测（bump-version.test.mjs）；CLI 由 workflow bump job 调用。
 *
 * 用法：node scripts/bump-version.mjs [--bump patch|minor|major] [--file package.json]
 * 输出：新版本号（stdout 一行）
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const VALID_BUMPS = ['patch', 'minor', 'major'];
const VERSION_RE = /^(\d+)\.(\d+)\.(\d+)$/;

/** 校验档位合法（patch/minor/major） */
export function isValidBump(bump) {
  return VALID_BUMPS.includes(bump);
}

/** semver 递增：patch 末位+1 / minor 中位+1 末位归零 / major 首位+1 后位归零 */
export function bumpVersion(version, bump) {
  if (!isValidBump(bump)) {
    throw new Error(`invalid bump: ${bump} (expected patch|minor|major)`);
  }
  const m = VERSION_RE.exec(version);
  if (!m) {
    throw new Error(`invalid version: ${version} (expected x.y.z)`);
  }
  const [major, minor, patch] = [Number(m[1]), Number(m[2]), Number(m[3])];
  switch (bump) {
    case 'patch':
      return `${major}.${minor}.${patch + 1}`;
    case 'minor':
      return `${major}.${minor + 1}.0`;
    case 'major':
      return `${major + 1}.0.0`;
  }
}

/** CLI 入口：读 package.json → bump → 写回 → 打印新版本 */
export function main(argv = process.argv.slice(2), cwd = process.cwd()) {
  const bumpIdx = argv.indexOf('--bump');
  const bump = bumpIdx !== -1 ? argv[bumpIdx + 1] : undefined;
  if (!bump) {
    throw new Error('usage: node scripts/bump-version.mjs --bump patch|minor|major [--file package.json]');
  }
  const fileIdx = argv.indexOf('--file');
  const file = fileIdx !== -1 ? argv[fileIdx + 1] : 'package.json';
  const pkgPath = join(cwd, file);

  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
  const next = bumpVersion(pkg.version, bump);
  pkg.version = next;
  writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);
  return next;
}

// 直接执行（被 import 时不跑，供测试）
if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    const next = main();
    console.log(next);
  } catch (err) {
    console.error(`[bump-version] ${err.message}`);
    process.exit(1);
  }
}
