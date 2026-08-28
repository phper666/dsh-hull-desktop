#!/usr/bin/env node
/**
 * electron-builder afterPack 钩子：对打包后的 mac .app 做 ad-hoc 代码签名。
 *
 * 背景（CON-R-packaging-005 修订 2026-08-28）：
 * Squirrel.Mac（electron-updater mac 安装器）要求运行中的应用有代码签名才能安装更新，
 * 未签名 app 报 "Could not get code signature for running application"。
 * 无开发者证书的自分发方案 → ad-hoc 签名（codesign --sign -，Signature=adhoc），
 * Squirrel 可识别，解锁 mac 自动更新安装。
 *
 * afterPack 在打包后、生成 zip/dmg 前调用（afterSign 仅在发生签名时调用——未签名会被跳过，故用 afterPack）。
 * 仅在 mac 平台执行；win/linux 无此需求。
 */
import { execFileSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';

export default async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return;
  const appOutDir = context.appOutDir;
  const apps = readdirSync(appOutDir).filter((f) => f.endsWith('.app'));
  if (apps.length === 0) {
    console.warn('[adhoc-sign] 无 .app 产物，跳过');
    return;
  }
  for (const app of apps) {
    const p = join(appOutDir, app);
    execFileSync('codesign', ['--force', '--deep', '--sign', '-', p], { stdio: 'inherit' });
    console.log(`[adhoc-sign] 已 ad-hoc 签名: ${app}`);
  }
}
