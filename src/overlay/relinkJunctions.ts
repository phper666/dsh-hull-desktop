import { lstatSync, readlinkSync, readdirSync, rmSync, symlinkSync } from 'node:fs';
import { join, sep } from 'node:path';

/**
 * Windows pnpm junction 悬空重建（#8，2026-08-31 Windows 实测）：
 * pnpm 在 Windows 用 **绝对路径 junction** 链接依赖（`<root>\node_modules\@scope\pkg` →
 * `<root>\node_modules\.pnpm\...`）——swap 的 rename（dsh-staging → dsh）后全部悬空
 * （macOS/POSIX pnpm 用相对 symlink 不受影响）。dsh 启动时 dshEntryPath 沿链接解析
 * 直接 MODULE_NOT_FOUND。
 *
 * 修复：swap 完成后扫描 node_modules 链，把 target 前缀为旧根（dsh-staging）的链接
 * 重建为前缀改写后的新根。只走 node_modules 结构层（node_modules → 顶层包/@scope/.pnpm
 * → .pnpm/<pkg> → node_modules），**不进包内容目录**——真实文件万级，全树 lstat 不可接受。
 */

/** 从根开始的受控遍历：
 *  - nm(dir)：node_modules 目录——子项为链接（修复）或真实目录（top 层）
 *  - top(dir)：node_modules 直接子层——.pnpm → pnpm 层；@scope → 再一层 top；其余真实包 → 不深入 */
function walkNm(dir: string, oldRoot: string, newRoot: string, fixed: { n: number }): void {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return; // 目录缺失/权限 → 尽力而为
  }
  for (const name of entries) {
    const p = join(dir, name);
    let st;
    try {
      st = lstatSync(p);
    } catch {
      continue;
    }
    if (st.isSymbolicLink()) {
      relink(p, oldRoot, newRoot, fixed);
      continue; // 链接不深入
    }
    if (!st.isDirectory()) continue;
    if (name === '.pnpm') walkPnpm(p, oldRoot, newRoot, fixed);
    else if (name.startsWith('@')) walkNm(p, oldRoot, newRoot, fixed); // @scope 层（子项仍可能是真实包或 .pnpm 不在此层）
    // 其余真实目录 = 顶层真实包（npm hoisted 布局无链接）→ 不深入
  }
}

function walkPnpm(dir: string, oldRoot: string, newRoot: string, fixed: { n: number }): void {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of entries) {
    const pkgDir = join(dir, name);
    let st;
    try {
      st = lstatSync(pkgDir);
    } catch {
      continue;
    }
    if (!st.isDirectory() || st.isSymbolicLink()) continue;
    const nm = join(pkgDir, 'node_modules');
    try {
      if (!lstatSync(nm).isDirectory()) continue;
    } catch {
      continue;
    }
    walkPkgNm(nm, oldRoot, newRoot, fixed);
  }
}

/** .pnpm/<pkg>/node_modules 层：子项为依赖链接（修复）或包自身真实目录（不深入） */
function walkPkgNm(dir: string, oldRoot: string, newRoot: string, fixed: { n: number }): void {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of entries) {
    const p = join(dir, name);
    let st;
    try {
      st = lstatSync(p);
    } catch {
      continue;
    }
    if (st.isSymbolicLink()) {
      relink(p, oldRoot, newRoot, fixed);
      continue;
    }
    // 真实目录：@scope 聚合层再进一层找链接，包内容不深入
    if (st.isDirectory() && name.startsWith('@')) walkPkgNm(p, oldRoot, newRoot, fixed);
  }
}

function relink(linkPath: string, oldRoot: string, newRoot: string, fixed: { n: number }): void {
  let target: string;
  try {
    target = readlinkSync(linkPath);
  } catch {
    return;
  }
  // Windows junction target 可能带 \\?\ 前缀（fs.symlinkSync junction 自动加）——归一化后比较
  const norm = target.replace(/^\\\\\?\\/, '');
  const oldNorm = oldRoot.replace(/^\\\\\?\\/, '');
  if (!norm.startsWith(oldNorm + sep) && norm !== oldNorm) return; // 非 stale，不动
  const newTarget = join(newRoot, norm.slice(oldNorm.length).replace(/^[/\\]/, ''));
  try {
    rmSync(linkPath); // 删链接本身（不递归进 target）
    symlinkSync(newTarget, linkPath, 'junction');
    fixed.n += 1;
  } catch {
    /* 单个重建失败尽力而为（调用方告警计数） */
  }
}

/** 扫描 rootDir 的 node_modules 链，重建 target 指向 oldRoot 的悬空链接。返回重建数。 */
export function relinkStaleJunctions(rootDir: string, oldRoot: string): number {
  const fixed = { n: 0 };
  const nm = join(rootDir, 'node_modules');
  try {
    if (!lstatSync(nm).isDirectory()) return 0;
  } catch {
    return 0;
  }
  walkNm(nm, oldRoot, rootDir, fixed);
  return fixed.n;
}
