/**
 * E2E-02 首装+取消（S7 契约场景）：引导态 + 重装成功。
 * registry 用本地假 registry（注入模拟——真实官方 registry 网络慢且波动，冷装 234s+ 实测 261s，
 * 多次超 590s；真实包安装路径由 runtime-verification 文档 + 手动安装验证记录覆盖）。
 * 场景全编排真实执行：空 userData → ensure 首装 → 取消 → 引导态 → 重装 → staging gate → swap → start → ready。
 */
import { test, expect, type ElectronApplication, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  launchApp,
  mainWindowUrl,
  makeTempUserData,
  seedSettings,
  sleep,
  startFakeRegistry,
  waitForMainWindow,
} from './helpers';

/** 安装结果判定：成功（官方 UI 就绪）或失败（not-installed/failed 视图 → 快速失败） */
async function waitForInstallOutcome(app: ElectronApplication, win: Page, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const url = await mainWindowUrl(app);
    if (url.startsWith('http://127.0.0.1:')) {
      try {
        const res = await fetch(url);
        if ((await res.text()) === 'ok') return; // 成功：官方 UI 可交互
      } catch {
        /* 服务未就绪 */
      }
    }
    const state = await win
      .evaluate(() => {
        // tsconfig.tests.json 无 DOM lib：最小 DOM 接口内联（evaluate 在 renderer 运行，运行时 DOM 可用）
        interface MinEl {
          classList: { contains(c: string): boolean };
          textContent: string | null;
        }
        const doc = (globalThis as unknown as { document: { getElementById(id: string): MinEl | null } }).document;
        const vis = (id: string) => {
          const el = doc.getElementById(id);
          return el ? !el.classList.contains('hidden') : false;
        };
        const msg = (id: string) => doc.getElementById(id)?.textContent ?? '';
        if (vis('not-installed')) return { state: 'not-installed', msg: msg('not-installed-msg') };
        if (vis('failed')) return { state: 'failed', msg: msg('failed-msg') };
        return null;
      })
      .catch(() => null); // 页面导航中（成功路径）→ 忽略
    if (state) throw new Error(`安装失败（${state.state}）: ${state.msg}`);
    await sleep(1000);
  }
  throw new Error(`安装未在 ${timeoutMs}ms 内完成`);
}

test.describe('E2E-02 首装+取消', () => {
  test('引导态 + 重装成功', async () => {
    test.setTimeout(120_000);
    const tmp = makeTempUserData();
    const reg = await startFakeRegistry({ latest: '9.9.9' });
    let app: ElectronApplication | null = null;
    try {
      seedSettings(tmp.dir, { registry: reg.url, packageManager: 'npm' }); // 安装走假 registry（npm 场景；pnpm 需真实 store）
      app = await launchApp({ userData: tmp.dir, registry: reg.url });
      const win = await waitForMainWindow(app);
      // 首装：进「未安装」引导态（需求变更 2026-08-24：不再自动触发，需手动点安装）
      await win.waitForSelector('#not-installed', { state: 'visible', timeout: 30_000 });
      await expect(win.locator('#not-installed h1')).toHaveText('dsh 尚未安装');
      // 点「安装 dsh」→ 安装视图出现
      await win.click('#install-btn');
      await win.waitForSelector('#installing', { state: 'visible', timeout: 30_000 });
      await expect(win.locator('#installing h1')).toHaveText('正在安装 dsh…');
      // 取消安装 → 引导态（not-installed 视图）
      await win.click('#cancel-install');
      await win.waitForSelector('#not-installed', { state: 'visible', timeout: 30_000 });
      await expect(win.locator('#not-installed h1')).toHaveText('dsh 尚未安装');
      // 重装 → 等待安装完成 → 官方 UI
      await win.click('#install-btn');
      await win.waitForSelector('#installing', { state: 'visible', timeout: 30_000 });
      await waitForInstallOutcome(app, win, 90_000);
      // 版本校验（registry dist-tags.latest）
      const pkg = JSON.parse(
        readFileSync(join(tmp.dir, 'dsh', 'node_modules', '@deepseek-ai', 'dsh', 'package.json'), 'utf8')
      ) as { version: string };
      expect(pkg.version).toBe('9.9.9');
    } finally {
      if (app) await app.close().catch(() => {});
      await reg.close();
      tmp.cleanup();
    }
  });
});