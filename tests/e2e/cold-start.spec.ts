/**
 * E2E-01 冷启动 / E2E-05 退出清理 / E2E-06 托盘（S7 契约场景组）。
 * 全部用种子 fake dsh overlay（D2 兜底：可控 + 不依赖真实 dsh 包）。
 * S8 壳框架：主窗口 = shell.html（nav + 占位区块），官方 UI = WebContentsView（R2 验证点）。
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
  navStatus,
  officialPage,
  officialViewState,
  psCommandLines,
  seedFakeDsh,
  seedSettings,
  sleep,
  startFakeRegistry,
  trayMenuItems,
  waitForOkPage,
  waitForReady,
  waitForRegistryHits,
  waitForTrayItemEnabled,
} from './helpers';

test.describe('E2E-01 冷启动', () => {
  test('启动 → 壳窗口 + nav 可见 → 官方 view 就绪，总时长 ≤10s（Q-009 权威口径）', async () => {
    const tmp = makeTempUserData();
    let app: ElectronApplication | null = null;
    try {
      seedFakeDsh(tmp.dir);
      seedSettings(tmp.dir); // 关自动检查（防原生 dialog 干扰）
      const t0 = Date.now();
      app = await launchApp({ userData: tmp.dir });
      const shell = await waitForReady(app, 30_000);
      const elapsed = Date.now() - t0;
      console.log(`[E2E-01] 冷启动总时长: ${elapsed}ms`);
      expect(elapsed, `冷启动总时长 ${elapsed}ms 应 ≤ 10s（Q-009）`).toBeLessThan(10_000);
      // 壳框架：nav 三入口（dsh/任务看板/设置，M1-重构 去 nav-upgrade）+ 状态区可见
      await expect(shell.locator('#nav')).toBeVisible();
      await expect(shell.locator('#nav-web')).toBeVisible();
      await expect(shell.locator('#nav-settings')).toBeVisible();
      await expect(shell.locator('#nav-board')).toBeVisible(); // M2 看板已启用（B2）
      await expect(shell.locator('#nav-board')).not.toHaveAttribute('aria-disabled', 'true');
      await expect(shell.locator('#nav-status')).toBeVisible();
      // 官方 UI 就绪：view URL http://127.0.0.1: + HTTP body=ok
      const url = await mainWindowUrl(app);
      expect((await (await fetch(url)).text())).toBe('ok');
      // R2 验证：Playwright 对 WebContentsView page 暴露探测 + 主进程侧兜底断言
      const official = officialPage(app);
      console.log(`[E2E-01] R2: officialPage ${official ? 'exposed' : 'not exposed (fallback)'}`);
      const viewState = await officialViewState(app);
      expect(viewState.url.startsWith('http://127.0.0.1:')).toBe(true);
      expect(viewState.visible).toBe(true);
      // nav 状态区渲染（runtime.phase=ready + currentVersion + hullVersion + upgrade.phase=idle）
      await expect(shell.locator('#status-phase')).toHaveText('运行中');
      await expect(shell.locator('#status-version')).toHaveText('0.1.0-rc.7');
      await expect(shell.locator('#status-hull-version')).not.toHaveText('…'); // Hull 版本已渲染
      await expect(shell.locator('#status-upgrade')).toHaveText('无');
      // nav 排序（M1-重构 + S1 + tokens/connections/workflows 增量）：dsh web → 任务看板 → Skills → Token 消耗 → 工作台连接 → 工作流 → 设置（设置恒最后，无 nav-upgrade）
      const navOrder = await shell.locator('#nav-items .nav-item').evaluateAll((els) => els.map((e) => e.id));
      expect(navOrder).toEqual(['nav-web', 'nav-board', 'nav-skills', 'nav-tokens', 'nav-connections', 'nav-workflows', 'nav-settings']);
      await expect(shell.locator('#nav-upgrade')).toHaveCount(0);
      // 占位区块：official 时全隐藏
      await expect(shell.locator('#starting')).toBeHidden();
      await expect(shell.locator('#installing')).toBeHidden();
      await expect(shell.locator('#failed')).toBeHidden();
      await expect(shell.locator('#not-installed')).toBeHidden();
      // dsh 子进程在跑（pid 文件存在）
      expect(existsSync(join(tmp.dir, 'dsh.pid'))).toBe(true);
    } finally {
      if (app) await app.close().catch(() => {});
      tmp.cleanup();
    }
  });

  test('nav 入口：设置开窗 / 升级触发检查 / 看板禁用无路由', async () => {
    const tmp = makeTempUserData();
    // 无更新种子（latest == 当前版本）→ 检查无 dialog（原生 dialog 不可 Playwright 驱动，与托盘同属 e2e 不可测限制）；
    // 用 registry manifest 请求计数验证「nav 升级 → runCheck → updater.check」链路
    const reg = await startFakeRegistry({ latest: '0.1.0-rc.7' });
    let app: ElectronApplication | null = null;
    try {
      seedFakeDsh(tmp.dir);
      seedSettings(tmp.dir, { registry: reg.url, packageManager: 'npm' });
      app = await launchApp({ userData: tmp.dir, registry: reg.url });
      const shell = await waitForReady(app);
      // 设置 → hull:showSettings → 壳内 settings section 显示（view=placeholder:settings）
      await shell.click('#nav-settings');
      await expect(shell.locator('#settings')).toBeVisible();
      await expect(shell.locator('#settings h1')).toHaveText('dsh-hull-desktop 设置');
      // 看板 → 已启用（B2）：点击 → 看板面板显示（placeholder:board）
      await expect(shell.locator('#nav-board')).toBeEnabled();
      await shell.click('#nav-board');
      await expect(shell.locator('#board')).toBeVisible();
      // 回官方 view（showWeb 对称恢复）
      await shell.click('#nav-web');
      await expect(shell.locator('#board')).toBeHidden();
      // 升级入口已并入设置视图（M1-重构）：设置「检查更新」→ checkDshUpdate → updater.check 命中 registry
      // （无更新 → 静默，无 dialog）
      await shell.click('#nav-settings');
      await shell.click('#check-dsh');
      await waitForRegistryHits(reg, 1, 15_000);
      const status = await navStatus(app);
      expect(status?.upgrade).toBe('无');
    } finally {
      if (app) await app.close().catch(() => {});
      await reg.close();
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
      seedSettings(tmp.dir, { registry: reg.url, packageManager: 'npm' }); // 升级走假 registry（npm 场景）
      app = await launchApp({ userData: tmp.dir, registry: reg.url });
      const shell = await waitForReady(app);
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
      // 设置入口：nav-settings → 壳内 settings section（S8' 独立窗口移除）
      await shell.click('#nav-settings');
      await expect(shell.locator('#settings')).toBeVisible();
      await expect(shell.locator('#settings h1')).toHaveText('dsh-hull-desktop 设置');
      // 升级中禁用（T6-04）：设置视图「检查更新」确认 → installing 段托盘「检查更新…」禁用 → 完成后恢复
      await shell.click('#nav-settings');
      await shell.click('#check-dsh');
      await shell.waitForSelector('#up-dsh-yes', { timeout: 15_000 });
      await shell.click('#up-dsh-yes');
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
