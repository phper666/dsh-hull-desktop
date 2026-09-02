import { lstatSync, readlinkSync, readdirSync, rmSync, symlinkSync } from 'node:fs';
import { join, sep } from 'node:path';

/** 路径归一化：剥 \\?\ 前缀 + 分隔符统一为 `\`。
 *  ⚠️ 必须在前后缀比较前做——实测 readlink 返回 `\` 分隔而调用方传入 `/` 分隔路径时
 *  startsWith 永远失配 → seen=2027 / fixed=0（2026-08-31 Windows 实测真凶）。 */
function canonPath(p: string): string {
  return p.replace(/^\\\\\?\\/, '').replace(/\/+/g, '\\');
}

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
function walkNm(dir: string, oldRoot: string, newRoot: string, res: RelinkResult): void {
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
      res.seen += 1;
      relink(p, oldRoot, newRoot, res);
      continue; // 链接不深入
    }
    if (!st.isDirectory()) continue;
    if (name === '.pnpm') walkPnpm(p, oldRoot, newRoot, res);
    else if (name.startsWith('@')) walkNm(p, oldRoot, newRoot, res); // @scope 层（子项仍可能是真实包或 .pnpm 不在此层）
    // 其余真实目录 = 顶层真实包（npm hoisted 布局无链接）→ 不深入
  }
}

function walkPnpm(dir: string, oldRoot: string, newRoot: string, res: RelinkResult): void {
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
    // .pnpm/node_modules = pnpm 根级虚拟 store（hoist 所有包，junction 链 client-ui bundle 解析依赖）——
    //   Windows 实测曾漏扫 → 全部 client-ui 链接悬空 → dsh 插件加载 ERR_MODULE_NOT_FOUND
    if (name === 'node_modules') {
      walkNm(pkgDir, oldRoot, newRoot, res);
      continue;
    }
    const nm = join(pkgDir, 'node_modules');
    try {
      if (!lstatSync(nm).isDirectory()) continue;
    } catch {
      continue;
    }
    walkPkgNm(nm, oldRoot, newRoot, res);
  }
}

/** .pnpm/<pkg>/node_modules 层：子项为依赖链接（修复）或包自身真实目录（不深入） */
function walkPkgNm(dir: string, oldRoot: string, newRoot: string, res: RelinkResult): void {
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
      res.seen += 1;
      relink(p, oldRoot, newRoot, res);
      continue;
    }
    // 真实目录：@scope 聚合层再进一层找链接，包内容不深入
    if (st.isDirectory() && name.startsWith('@')) walkPkgNm(p, oldRoot, newRoot, res);
  }
}

export interface RelinkResult {
  /** 成功重建数 */
  fixed: number;
  /** 重建失败数（含错误信息——rmSync/symlinkSync 失败绝不能静默，Windows 实测 0 个+悬空并存时真凶在此） */
  failed: Array<{ path: string; error: string }>;
  /** 遍历到的链接数（诊断用：>0 而 fixed=0 → 匹配逻辑问题；=0 → 遍历层问题） */
  seen: number;
}

function relink(linkPath: string, oldRoot: string, newRoot: string, res: RelinkResult): void {
  let target: string;
  try {
    target = readlinkSync(linkPath);
  } catch (err) {
    res.failed.push({ path: linkPath, error: `readlink: ${(err as Error).message}` });
    return;
  }
  const norm = canonPath(target);
  const oldNorm = canonPath(oldRoot);
  if (!norm.startsWith(oldNorm + '\\') && norm !== oldNorm) return; // 非 stale，不动
  // canonPath 已把分隔符统一为 '\'——重组时转回平台分隔符（posix join 不归一化 '\'，实测 mac 链接断）
  const rel = norm.slice(oldNorm.length).replace(/^[/\\]/, '');
  const newTarget = join(newRoot, rel.split(/[/\\]+/).join(sep));
  try {
    rmSync(linkPath); // 删链接本身（不递归进 target）
    symlinkSync(newTarget, linkPath, 'junction');
    res.fixed += 1;
  } catch (err) {
    res.failed.push({ path: linkPath, error: `rebuild(${(err as NodeJS.ErrnoException).code}): ${(err as Error).message}` });
  }
}

/** 扫描 rootDir 的 node_modules 链，重建 target 指向 oldRoot 的悬空链接。
 *  swap 后修复用：newRoot = rootDir（target 前缀 oldRoot → rootDir）。
 *  ⚠️ 异步 + 失败重试退避：swap 后立即调用时，Windows Defender 对 rename 后的
 *  dsh 目录扫描可能锁住删/建 junction（EISDIR/EPERM 窗口，2026-09-01 冷装实测，
 *  userData 下几分钟后消失；Temp 下不触发）。重试间隔 500ms*2^n 封顶 10s。
 *  仍失败 → 返回剩余 failed（调用方记录，走启动轮询兜底）。 */
export async function relinkStaleJunctions(
  rootDir: string,
  oldRoot: string,
  retries = 10
): Promise<RelinkResult> {
  return relinkJunctionsToTarget(rootDir, oldRoot, rootDir, retries);
}

/** 通用 junction target 前缀改写（方案4，2026-09-01）：把 rootDir 内 target 前缀为
 *  oldRoot 的 junction 重建为 newRoot 前缀。
 *  - swap 前预改写：relinkJunctionsToTarget(stagingDir, stagingDir, dshDir) ——
 *    junction target 指向未来的 dsh（swap 后 dsh 出现即有效），无需 swap 后重建，
 *    避开 Defender 对新路径 dsh 的扫描窗口；junction 创建本身无需提权（普通用户可用）。
 *  - swap 后修复：relinkStaleJunctions(dshDir, stagingDir)（newRoot = rootDir）。 */
export async function relinkJunctionsToTarget(
  rootDir: string,
  oldRoot: string,
  newRoot: string,
  retries = 10
): Promise<RelinkResult> {
  let res = relinkOnce(rootDir, oldRoot, newRoot);
  let attempt = 0;
  while (res.failed.length > 0 && attempt < retries) {
    await sleep(Math.min(500 * 2 ** attempt, 10_000));
    res = relinkOnce(rootDir, oldRoot, newRoot);
    attempt += 1;
  }
  return res;
}

/** 单次全扫重建（同步；重试循环的原子单元） */
function relinkOnce(rootDir: string, oldRoot: string, newRoot: string): RelinkResult {
  const res: RelinkResult = { fixed: 0, failed: [], seen: 0 };
  const nm = join(rootDir, 'node_modules');
  try {
    if (!lstatSync(nm).isDirectory()) return res;
  } catch {
    return res;
  }
  walkNm(nm, oldRoot, newRoot, res);
  return res;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
