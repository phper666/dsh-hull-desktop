import { join } from 'node:path';

/**
 * dsh CLI 契约收敛点（设计 §3 / §4.1）：
 * spawn 参数串、就绪行正则、命令行签名全部集中在本文件，单一修改点。
 */

/** dsh 可执行文件绝对路径（overlay 布局：<overlayDir>/bin/dsh，S2 首装按此落位） */
export function dshBinPath(overlayDir: string): string {
  return join(overlayDir, 'bin', 'dsh');
}

/**
 * 完整 spawn 参数串：node 自身 + node flags + dsh 入口 + web 子命令。
 * --expose-internals 为 node flag，必须在脚本名之前（契约 §接口详情 #1）。
 * ⚠️ dsh CLI：`web` 子命令即 `--profile web` 别名，--profile 是顶层选项，
 * 不能跟在 web 后（实测 dsh 0.1.0-rc.7 报 unknown option '--profile'）。
 * ⚠️ `--no-open`：dsh web 默认会用系统浏览器打开 UI（用户反馈「打开壳自动弹浏览器」）——
 * 壳内嵌官方 WebContentsView，不重复弹浏览器，必须显式 --no-open（dsh web --help 确认选项）。
 */
export function buildSpawnArgv(nodePath: string, overlayBin: string): string[] {
  return [nodePath, '--expose-internals', overlayBin, 'web', '--no-open', '--host', '127.0.0.1', '--port', '0'];
}

/** spawn(nodePath, buildDshArgv(...)) 用的参数（不含 node 自身） */
export function buildDshArgv(overlayBin: string): string[] {
  return ['--expose-internals', overlayBin, 'web', '--no-open', '--host', '127.0.0.1', '--port', '0'];
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
