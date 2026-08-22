/**
 * E2E-03 升级全流程 / E2E-04 坏版本注入（M1-重构：原生 dialog → 壳内 section#settings 升级区块确认/进度/失败）。
 * 升级走本地假 registry（注入模拟，任务允许）：tiny tarball → npm install 秒级完成，
 * 全编排（check→confirm→install→swap→verify→rollback）真实执行，仅包内容为 fake。
 * 确认流（§4.5 M1）：设置视图「检查更新」→ checkDshUpdate → phase=confirm → 确认卡片 → 立即升级。
 */
import { test, expect, type ElectronApplication } from '@playwright/test';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  launchApp,
  mainWindowUrl,
  makeTempUserData,
  seedFakeDsh,
  seedSettings,
  startFakeRegistry,
  waitForDshVersion,
  waitForMainWindow,
  waitForOkPage,
  waitForReady,
} from './helpers';

/** 经设置视图「检查更新」进入确认流（设置视图内升级区块确认卡片，非原生 dialog） */
async function confirmUpgrade(app: ElectronApplication): Promise<void> {
  const shell = await waitForMainWindow(app);
  await shell.click('#nav-settings');
  // 设置视图显示
  await shell.waitForSelector('#settings:not(.hidden)', { timeout: 15_000 });
  // 触发检查 → phase=confirm → 升级区块确认卡片（tick 轮询快照渲染）
  await shell.click('#check-dsh');
  await shell.waitForSelector('#up-dsh-yes', { timeout: 15_000 });
  await shell.click('#up-dsh-yes');
}

test.describe('E2E-03 升级全流程', () => {
  test('版本变化 + 数据无损', async () => {
    const tmp = makeTempUserData();
    const reg = await startFakeRegistry({ latest: '9.9.9' });
    let app: ElectronApplication | null = null;
    try {
      seedFakeDsh(tmp.dir, '0.1.0-rc.7');
      seedSettings(tmp.dir, { registry: reg.url }); // 升级走假 registry
      writeFileSync(join(tmp.dir, 'user-marker.txt'), 'keep-me'); // 数据无损标记
      app = await launchApp({ userData: tmp.dir, registry: reg.url });
      await waitForReady(app);
      await confirmUpgrade(app);
      // 等待升级完成：版本 0.1.0-rc.7 → 9.9.9 → 官方 UI 恢复可交互（新版本运行）
      await waitForDshVersion(tmp.dir, '9.9.9', 60_000);
      await waitForOkPage(app, 60_000);
      // 版本变化
      const pkg = JSON.parse(
        readFileSync(join(tmp.dir, 'dsh', 'node_modules', '@deepseek-ai', 'dsh', 'package.json'), 'utf8')
      ) as { version: string };
      expect(pkg.version).toBe('9.9.9');
      // 数据无损：marker + settings.json（registry 配置）跨升级保留
      expect(readFileSync(join(tmp.dir, 'user-marker.txt'), 'utf8')).toBe('keep-me');
      const settingsJson = JSON.parse(readFileSync(join(tmp.dir, 'settings.json'), 'utf8')) as { registry: string };
      expect(settingsJson.registry).toBe(reg.url);
      // 新版本 UI 可交互
      expect(await (await fetch(await mainWindowUrl(app))).text()).toBe('ok');
    } finally {
      if (app) await app.close().catch(() => {});
      await reg.close();
      tmp.cleanup();
    }
  });
});

test.describe('E2E-04 坏版本注入', () => {
  test('HULL_PROBE_TARGET 坏地址 → 自动回滚 → 可用（Q-010）', async () => {
    const tmp = makeTempUserData();
    const reg = await startFakeRegistry({ latest: '9.9.9' });
    let app: ElectronApplication | null = null;
    try {
      seedFakeDsh(tmp.dir, '0.1.0-rc.7');
      seedSettings(tmp.dir, { registry: reg.url });
      app = await launchApp({ userData: tmp.dir, registry: reg.url });
      await waitForReady(app);
      // 注入坏探测目标（仅作用升级 verify 段——ReadinessProbe 构造时读 env；初始启动已就绪不受影响）
      await app.evaluate(() => {
        process.env.HULL_PROBE_TARGET = 'http://127.0.0.1:1';
      });
      await confirmUpgrade(app);
      // 升级 → verify 失败（15s 探测窗口）→ 自动回滚：版本 9.9.9 → 0.1.0-rc.7 → 官方 UI 恢复
      await waitForDshVersion(tmp.dir, '9.9.9', 60_000);
      await waitForDshVersion(tmp.dir, '0.1.0-rc.7', 90_000);
      await waitForOkPage(app, 60_000);
      // 回滚后原版本可用
      const pkg = JSON.parse(
        readFileSync(join(tmp.dir, 'dsh', 'node_modules', '@deepseek-ai', 'dsh', 'package.json'), 'utf8')
      ) as { version: string };
      expect(pkg.version).toBe('0.1.0-rc.7');
      expect(await (await fetch(await mainWindowUrl(app))).text()).toBe('ok');
    } finally {
      if (app) await app.close().catch(() => {});
      await reg.close();
      tmp.cleanup();
    }
  });
});
