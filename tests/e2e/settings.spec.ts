/**
 * E2E-07 设置页场景组（S8' S6' 重构：独立窗口 → 壳内 section#settings）：
 * T6-01 registry 持久化 / T6-03 关闭即退出 / T6-05 校验提示。
 */
import { test, expect, type ElectronApplication } from '@playwright/test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

function ok(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg);
}

import {
  closeMainWindow,
  launchApp,
  makeTempUserData,
  openSettings,
  seedFakeDsh,
  seedSettings,
  waitForReady,
  waitForSettingsRegistry,
  waitForSettingsTheme,
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
      const shell = await openSettings(app);
      // 设置 section 可见（view=placeholder:settings）
      await expect(shell.locator('#settings')).toBeVisible();
      await expect(shell.locator('#settings h1')).toHaveText('dsh-hull-desktop 设置');
      // 诊断区「打开日志目录」按钮唯一 id 可点（修复重复 id=open-logs 未绑定 bug）
      await expect(shell.locator('#open-logs-dir')).toBeEnabled();
      await expect(shell.locator('#open-logs-dir')).toBeVisible();
      // dsh 运行时「检查更新」按钮 idle 时可点（busy 判定健壮）
      await expect(shell.locator('#check-dsh')).toBeEnabled();
      await shell.fill('#registry', customRegistry);
      await shell.locator('#registry').blur();
      await waitForSettingsRegistry(tmp.dir, customRegistry);
      // 切走再切回（重渲染）→ 值保留
      await shell.click('#nav-web');
      await expect(shell.locator('#settings')).toBeHidden();
      await shell.click('#nav-settings');
      await expect(shell.locator('#settings')).toBeVisible();
      await expect(shell.locator('#registry')).toHaveValue(customRegistry);

      // T6-05 校验提示：非法 registry → 错误提示可见
      await shell.fill('#registry', 'not-a-url');
      await shell.locator('#registry').blur();
      await expect(shell.locator('#registry-error')).toBeVisible();
      await expect(shell.locator('#registry-error')).not.toHaveText('');
      // 恢复合法值（避免污染后续断言）
      await shell.fill('#registry', customRegistry);
      await shell.locator('#registry').blur();
      await waitForSettingsRegistry(tmp.dir, customRegistry);

      // T6-03 关闭即退出：开 closeToQuit → 关主窗口 → 应用退出
      await shell.click('#closeToQuit');
      await expect(shell.locator('#closeToQuit')).toHaveAttribute('aria-checked', 'true');
      await closeMainWindow(app);
      await app.waitForEvent('close');
      app = null; // 已退出
    } finally {
      if (app) await app.close().catch(() => {});
      tmp.cleanup();
    }
  });

  test('T2-UI 主题切换：即时应用 + 持久化', async () => {
    const tmp = makeTempUserData();
    let app: ElectronApplication | null = null;
    try {
      seedFakeDsh(tmp.dir);
      seedSettings(tmp.dir, { theme: 'dark' }); // 显式存量值：默认档已改 system（CON-R-theme-004 v1.3），跟随 OS 会使默认断言不稳定
      app = await launchApp({ userData: tmp.dir });
      await waitForReady(app);

      const shell = await openSettings(app);
      await expect(shell.locator('#theme-seg')).toBeVisible();
      // 默认暗色（seeded）
      await expect(shell.locator('body')).toHaveAttribute('data-theme', 'dark');
      await expect(shell.locator('#theme-seg button[data-theme="dark"]')).toHaveAttribute('aria-pressed', 'true');

      // 切亮色
      await shell.click('#theme-seg button[data-theme="light"]');
      await expect(shell.locator('body')).toHaveAttribute('data-theme', 'light');
      await expect(shell.locator('#theme-seg button[data-theme="light"]')).toHaveAttribute('aria-pressed', 'true');
      await waitForSettingsTheme(tmp.dir, 'light');

      // 重开后仍为亮色
      await shell.click('#nav-web');
      await shell.click('#nav-settings');
      await expect(shell.locator('body')).toHaveAttribute('data-theme', 'light');
      await expect(shell.locator('#theme-seg button[data-theme="light"]')).toHaveAttribute('aria-pressed', 'true');
    } finally {
      if (app) await app.close().catch(() => {});
      tmp.cleanup();
    }
  });

  test('N4 笔记区块：默认路径显示 + 复制按钮 toast', async () => {
    const tmp = makeTempUserData();
    let app: ElectronApplication | null = null;
    try {
      seedFakeDsh(tmp.dir);
      seedSettings(tmp.dir);
      app = await launchApp({ userData: tmp.dir });
      await waitForReady(app);
      const shell = await openSettings(app);
      // T4-01 默认路径显示：生效路径 = <userData>/notes（SettingsProvider 读路径默认解析）
      const expected = join(tmp.dir, 'notes');
      await expect(shell.locator('#notes-dir-path')).toHaveText(expected, { timeout: 15_000 });
      // 「更改目录」/「复制路径」按钮存在（原生 dialog 不可 Playwright 驱动——pick 全流程由单测+手工覆盖）
      await expect(shell.locator('#notes-pick')).toBeVisible();
      // T4-02 复制按钮：点击 → toast 反馈
      await shell.locator('#notes-copy').click();
      await expect(shell.locator('.toast', { hasText: '路径已复制' })).toBeVisible({ timeout: 10_000 });
      // UI 展示不写盘：settings.json 的 notesDir 仍为启动 migrate() 落的默认值（未被 UI 更改）
      const s = JSON.parse(readFileSync(join(tmp.dir, 'settings.json'), 'utf8')) as { notesDir?: unknown };
      ok(!('notesDir' in s) || s.notesDir === expected, 'UI 展示不写盘（notesDir 维持默认）');
    } finally {
      if (app) await app.close().catch(() => {});
      tmp.cleanup();
    }
  });
});
