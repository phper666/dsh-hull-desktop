/**
 * E2E-07 设置页场景组（S7 契约）：T6-01 registry 持久化 / T6-03 关闭即退出 / T6-05 校验提示。
 */
import { test, expect, type ElectronApplication } from '@playwright/test';

import {
  closeMainWindow,
  launchApp,
  makeTempUserData,
  openSettings,
  seedFakeDsh,
  seedSettings,
  waitForReady,
  waitForSettingsRegistry,
} from './helpers';

test.describe('E2E-07 设置页', () => {
  test('registry 持久化 / 校验提示 / 关闭即退出', async () => {
    const tmp = makeTempUserData();
    let app: ElectronApplication | null = null;
    try {
      seedFakeDsh(tmp.dir);
      seedSettings(tmp.dir);
      app = await launchApp({ userData: tmp.dir });
      await waitForReady(app);

      // T6-01 registry 持久化：填写 → 落盘 → 关闭重开 → 值保留
      const customRegistry = 'https://registry.npmmirror.com';
      const settings = await openSettings(app);
      await settings.fill('#registry', customRegistry);
      await settings.locator('#registry').blur();
      await waitForSettingsRegistry(tmp.dir, customRegistry);
      await settings.close();
      const settings2 = await openSettings(app);
      await expect(settings2.locator('#registry')).toHaveValue(customRegistry);

      // T6-05 校验提示：非法 registry → 错误提示可见
      await settings2.fill('#registry', 'not-a-url');
      await settings2.locator('#registry').blur();
      await expect(settings2.locator('#registry-error')).toBeVisible();
      await expect(settings2.locator('#registry-error')).not.toHaveText('');
      // 恢复合法值（避免污染后续断言）
      await settings2.fill('#registry', customRegistry);
      await settings2.locator('#registry').blur();
      await waitForSettingsRegistry(tmp.dir, customRegistry);

      // T6-03 关闭即退出：开 closeToQuit → 关主窗口 → 应用退出
      await settings2.click('#closeToQuit');
      await expect(settings2.locator('#closeToQuit')).toHaveAttribute('aria-checked', 'true');
      await closeMainWindow(app);
      await app.waitForEvent('close');
      app = null; // 已退出
    } finally {
      if (app) await app.close().catch(() => {});
      tmp.cleanup();
    }
  });
});