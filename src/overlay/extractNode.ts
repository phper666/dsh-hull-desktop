import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

/**
 * PK2：捆绑 node 解压（CON-R-packaging-003/008）。
 * 从打包资源 `<resourcesDir>/node`（electron-builder extraResources → to: node）复制到 `<nodeDir>`。
 * - dev/无捆绑 → 抛错（InstallFlow dev 分支告警跳过 → PATH 兜底）
 * - 完整性：node 可执行（bin/node 或 node.exe）+ node-version.txt 齐备才算成功
 */
export async function extractBundledNode(resourcesDir: string, nodeDir: string): Promise<void> {
  const src = join(resourcesDir, 'node');
  if (!existsSync(src)) throw new Error(`打包 node 资源缺失: ${src}`);
  const binOk =
    existsSync(join(src, 'bin', 'node')) || existsSync(join(src, 'node.exe')); // darwin/linux: bin/node；win: 根 node.exe
  if (!binOk) throw new Error(`打包 node 资源缺少可执行文件: ${src}`);
  rmSync(nodeDir, { recursive: true, force: true });
  mkdirSync(nodeDir, { recursive: true });
  cpSync(src, nodeDir, { recursive: true, force: true }); // 整树复制到 userData（资源只读共享）
}

/** 幂等判定：nodeDir 已有可执行 + 版本文件 → 无需重解压（InstallFlow 前检查） */
export function isNodeExtracted(nodeDir: string): boolean {
  const binOk = existsSync(join(nodeDir, 'bin', 'node')) || existsSync(join(nodeDir, 'node.exe'));
  return binOk && existsSync(join(nodeDir, 'node-version.txt'));
}
