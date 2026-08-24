import { createRequire } from 'node:module';
import { dirname, isAbsolute, join } from 'node:path';
import { readFileSync } from 'node:fs';

/**
 * dsh CLI 契约收敛点（设计 §3 / §4.1 / P2 §4.3）：
 * spawn 参数串、就绪行正则、命令行签名全部集中在本文件，单一修改点。
 */

/** dsh 可执行文件绝对路径（overlay 布局：<overlayDir>/bin/dsh，S2 首装按此落位）。
 *  ⚠️ P2：spawn 已改用 dshEntryPath（真实 JS 入口，不依赖 .bin shim）；
 *  本函数保留兼容（OverlayManager 的 bin symlink 落点仍在用）。 */
export function dshBinPath(overlayDir: string): string {
  return join(overlayDir, 'bin', 'dsh');
}

/**
 * 解析 @deepseek-ai/dsh 包真实 JS 入口（P2 CON-R-pkgmgr-004：不依赖 .bin shim）。
 * - createRequire.resolve('@deepseek-ai/dsh/package.json') → 包 package.json 绝对路径
 *   （沿 node_modules 解析，兼容 npm hoisted / pnpm symlink → .pnpm 真实目录布局）
 * - 读 bin.dsh 字段（相对包目录，如 lib/bin.js 或 ./lib/bin.js）→ join 得真实入口
 * - 兜底链：bin 字段缺失 → <pkgDir>/lib/bin.js（dsh 已知入口）；包不存在 → <overlay>/lib/bin.js
 */
export function dshEntryPath(overlayDir: string): string {
  const fallback = join(overlayDir, 'lib', 'bin.js');
  let pkgJsonPath: string;
  try {
    const req = createRequire(join(overlayDir, 'package.json'));
    pkgJsonPath = req.resolve('@deepseek-ai/dsh/package.json');
  } catch {
    return fallback; // 包未安装 → 最外层兜底
  }
  const pkgDir = dirname(pkgJsonPath);
  let bin: unknown;
  try {
    bin = (JSON.parse(readFileSync(pkgJsonPath, 'utf8')) as { bin?: unknown }).bin;
  } catch {
    return join(pkgDir, 'lib', 'bin.js'); // package.json 读/解析失败 → 包内兜底
  }
  if (bin && typeof bin === 'object' && typeof (bin as Record<string, unknown>).dsh === 'string') {
    const rel = (bin as Record<string, string>).dsh;
    return isAbsolute(rel) ? rel : join(pkgDir, rel);
  }
  return join(pkgDir, 'lib', 'bin.js'); // bin 字段缺失 → dsh 已知入口兜底
}

/**
 * 完整 spawn 参数串：node 自身 + node flags + dsh 入口 + web 子命令。
 * @param nodePath node 可执行路径（RuntimeManager.resolveNodePath——捆绑 node 优先）
 * @param entryPath dsh 真实 JS 入口（dshEntryPath(overlayDir) 解析，非 .bin shim）
 * --expose-internals 为 node flag，必须在脚本名之前（契约 §接口详情 #1）。
 * ⚠️ dsh CLI：`web` 子命令即 `--profile web` 别名，--profile 是顶层选项，
 * 不能跟在 web 后（实测 dsh 0.1.0-rc.7 报 unknown option '--profile'）。
 * ⚠️ `--no-open`：dsh web 默认会用系统浏览器打开 UI（用户反馈「打开壳自动弹浏览器」）——
 * 壳内嵌官方 WebContentsView，不重复弹浏览器，必须显式 --no-open（dsh web --help 确认选项）。
 */
export function buildSpawnArgv(nodePath: string, entryPath: string): string[] {
  return [nodePath, '--expose-internals', entryPath, 'web', '--no-open', '--host', '127.0.0.1', '--port', '0'];
}

/** spawn(nodePath, buildDshArgv(...)) 用的参数（不含 node 自身） */
export function buildDshArgv(entryPath: string): string[] {
  return ['--expose-internals', entryPath, 'web', '--no-open', '--host', '127.0.0.1', '--port', '0'];
}

/** 就绪行正则（契约 §就绪行协议；匹配前须 strip ANSI CSI + trim） */
export const READY_LINE_RE = /^dsh web: (http:\/\/127\.0\.0\.1:[0-9]+)/;

/** ANSI CSI 序列（设计 D5：\x1b\[[0-9;]*[a-zA-Z]） */
export const ANSI_CSI_RE = /\x1b\[[0-9;]*[a-zA-Z]/g;

/** 就绪行解析前清洗：strip ANSI CSI + trim（容 \r\n） */
export function cleanLine(line: string): string {
  return line.replace(ANSI_CSI_RE, '').trim();
}

/** 命令行签名（兜底清理校验，防误杀用户手动跑的 dsh——其命令行不含该签名组合，设计 D3/§4.5） */
export const DSH_CLI_SIGNATURE = 'web --no-open --host 127.0.0.1 --port 0';

/** 命令行是否含 dsh 签名（`ps -p <pid> -o command=` 输出校验用） */
export function matchesDshSignature(commandLine: string): boolean {
  return commandLine.includes(DSH_CLI_SIGNATURE);
}
