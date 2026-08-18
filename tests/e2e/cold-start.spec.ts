/**
 * E2E-01 冷启动 / E2E-05 退出清理 / E2E-06 托盘（S7 契约场景组）。
 * 全部用种子 fake dsh overlay（D2 兜底：可控 + 不依赖真实 dsh 包）。
 */
import { test, expect, type ElectronApplication } from '@playwright/test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  closeMainWindow,
  launchApp,
  mainWindowUrl,
  mainWindowVisible,
  makeTempUserData,
  openSettings,
  psCommandLines,
  seedFakeDsh,
  seedSettings,
  sleep,
  startFakeRegistry,
  trayMenuItems,
  waitForOkPage,
  waitForReady,
  waitForTrayItemEnabled,
} from './helpers';

test.describe('E2E-01 冷启动', () => {
  test('启动 → 主窗口出现 → UI 可交互，总时长 ≤10s（Q-009 权威口径）', async () => {
    const tmp = makeTempUserData();
    let app: ElectronApplication | null = null;
    try {
      seedFakeDsh(tmp.dir);
      seedSettings(tmp.dir); // 关自动检查（防原生 dialog 干扰）
      const t0 = Date.now();
      app = await launchApp({ userData: tmp.dir });
      const win = await waitForReady(app, 30_000);
      const elapsed = Date.now() - t0;
      console.log(`[E2E-01] 冷启动总时长: ${elapsed}ms`);
      expect(elapsed, `冷启动总时长 ${elapsed}ms 应 ≤ 10s（Q-009）`).toBeLessThan(10_000);
      // UI 可交互：官方 UI（fake dsh "ok" 页）HTTP 响应内容可见
      const url = await mainWindowUrl(app);
      expect((await (await fetch(url)).text())).toBe('ok');
      // dsh 子进程在跑（pid 文件存在）
      expect(existsSync(join(tmp.dir, 'dsh.pid'))).toBe(true);
    } finally {
      if (app) await app.close().catch(() => {});
      tmp.cleanup();
    }
  });
});

test.describe('E2E-05 退出清理', () => {
  test('退出后零残留（无 dsh 子进程、无 pid 文件）', async () => {
    const tmp = makeTempUserData();
    let app: ElectronApplication | null = null;
    try {
      seedFakeDsh(tmp.dir);
      seedSettings(tmp.dir);
      app = await launchApp({ userData: tmp.dir });
      await waitForReady(app);
      const pidFile = join(tmp.dir, 'dsh.pid');
      expect(existsSync(pidFile)).toBe(true);
      const pid = (JSON.parse(readFileSync(pidFile, 'utf8')) as { pid: number }).pid;
      // 退出编排（quitOrchestration：stop dsh → 删 pid → app.quit）
      await app.evaluate(() => (globalThis as { __hullTest?: { quit(): void } }).__hullTest?.quit());
      await app.waitForEvent('close');
      app = null; // 已退出
      // 无 pid 文件
      expect(existsSync(pidFile)).toBe(false);
      // 进程不存在
      let alive = true;
      try {
        process.kill(pid, 0);
      } catch {
        alive = false;
      }
      expect(alive, `dsh 子进程 ${pid} 应已退出`).toBe(false);
      // ps 无残留 fake dsh（cmdline 含 userData + dsh/bin/dsh）
      const leftovers = psCommandLines().filter((l) => l.includes(tmp.dir) && l.includes('dsh/bin/dsh'));
      expect(leftovers).toEqual([]);
    } finally {
      if (app) await app.close().catch(() => {});
      tmp.cleanup();
    }
  });
});

test.describe('E2E-06 托盘', () => {
  test('打开主窗口/设置入口/升级中禁用（覆盖 T6-04/T1-06）', async () => {
    const tmp = makeTempUserData();
    const reg = await startFakeRegistry({ tarballDelayMs: 15_000 }); // 慢 tarball → installing 段可捕获
    let app: ElectronApplication | null = null;
    try {
      seedFakeDsh(tmp.dir);
      seedSettings(tmp.dir, { registry: reg.url }); // 升级走假 registry
      app = await launchApp({ userData: tmp.dir, registry: reg.url });
      await waitForReady(app);
      // 托盘菜单存在（5 菜单项 + 分隔符 = 6）
      const items0 = await trayMenuItems(app);
      expect(items0.length).toBe(6);
      expect(items0.find((i) => i.label === '检查更新…')?.enabled).toBe(true);
      // 打开主窗口（T1-06）：关闭 → 隐藏到托盘（closeToQuit=false 默认）→ openMain 恢复
      await closeMainWindow(app);
      await sleep(500);
      expect(await mainWindowVisible(app)).toBe(false);
      await app.evaluate(() => (globalThis as { __hullTest?: { openMain(): void } }).__hullTest?.openMain());
      await sleep(500);
      expect(await mainWindowVisible(app)).toBe(true);
      // 设置入口：openSettings → 设置页出现
      const settings = await openSettings(app);
      await expect(settings.locator('h1')).toHaveText('Hull 设置');
      // 升级中禁用（T6-04）：设置页触发升级 → installing 段托盘「检查更新…」禁用 → 完成后恢复
      await settings.click('#check-dsh');
      await settings.waitForSelector('#modal.show');
      await settings.click('#modal-actions .btn.primary');
      await waitForTrayItemEnabled(app, '检查更新…', false, 30_000);
      await waitForOkPage(app, 60_000);
      await waitForTrayItemEnabled(app, '检查更新…', true, 30_000);
    } finally {
      if (app) await app.close().catch(() => {});
      await reg.close();
      tmp.cleanup();
    }
  });
});