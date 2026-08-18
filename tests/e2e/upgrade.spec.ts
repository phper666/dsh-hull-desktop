/**
 * E2E-03 升级全流程 / E2E-04 坏版本注入（S7 契约场景）。
 * 升级走本地假 registry（注入模拟，任务允许）：tiny tarball → npm install 秒级完成，
 * 全编排（check→confirm→install→swap→verify→rollback）真实执行，仅包内容为 fake。
 */
import { test, expect, type ElectronApplication } from '@playwright/test';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  launchApp,
  mainWindowUrl,
  makeTempUserData,
  openSettings,
  seedFakeDsh,
  seedSettings,
  startFakeRegistry,
  waitForDshVersion,
  waitForOkPage,
  waitForReady,
} from './helpers';

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
      // 设置页触发升级（DOM modal，非原生 dialog）
      const settings = await openSettings(app);
      await settings.click('#check-dsh');
      await settings.waitForSelector('#modal.show');
      await settings.click('#modal-actions .btn.primary');
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
      const settings = await openSettings(app);
      await settings.click('#check-dsh');
      await settings.waitForSelector('#modal.show');
      await settings.click('#modal-actions .btn.primary');
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