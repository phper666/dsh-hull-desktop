/**
 * P5 e2e —— 插件市场验收 5 断言（设计 §5.3 / 契约 §联调与测试场景）：
 *   ① 安装生效（市场 tab 点安装 → 信任确认 → fake dsh fixture 出现 bundle + UI 已装列表出现）
 *   ② 更新版本变化（bridge 通道触发 → fixture 版本 bump → UI 已装列表版本变化）
 *   ③ 卸载恢复（UI 二次确认 → fixture 清空 + UI 空态）
 *   ④ 白名单外 entryId 拒绝（plugin-not-whitelisted 错误 + 零副作用）
 *   ⑤ registry 不可达（HULL_E2E_REGISTRY 指向不存在 → 降级文案 + snapshot 可用标注）
 * 注入：HULL_USER_DATA 隔离 + HULL_E2E + HULL_E2E_REGISTRY 本地 fixture + fake dsh plugin mock。
 */
import { test, expect } from '@playwright/test';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import {
  launchApp,
  makeTempUserData,
  seedFakeDsh,
  seedSettings,
  startFakePluginRegistry,
  waitForFixturePlugins,
  waitForReady,
  type ElectronApplication,
} from './helpers';

/** 本地 registry fixture 条目（url 必须 https——白名单校验；entryId = name#owner 复合键） */
const FIXTURE_ENTRIES = [
  { name: 'e2e-demo', owner: 'dsh-hull-desktop', url: 'https://example.com/e2e-demo', category: 'demo', description: 'e2e fixture plugin' },
  { name: 'e2e-second', owner: 'dsh-hull-desktop', url: 'https://example.com/e2e-second', category: 'demo' },
];

/** entryId 复合键（与 renderer entryIdOf / 主进程 types.entryId 同构） */
const entryId = (name: string, owner: string): string => `${name}#${owner}`;

interface PluginApp {
  app: ElectronApplication;
  shell: import('@playwright/test').Page;
  ud: ReturnType<typeof makeTempUserData>;
}

/** 启动 + 就绪 + 打开插件市场 tab（复用既有 e2e 基建；HULL_E2E_REGISTRY 经 launchApp env 注入） */
async function launchPluginsApp(env: Record<string, string> = {}): Promise<PluginApp> {
  const ud = makeTempUserData();
  seedFakeDsh(ud.dir);
  seedSettings(ud.dir);
  const app = await launchApp({ userData: ud.dir, env });
  const shell = await waitForReady(app);
  await shell.click('#nav-plugin');
  await shell.waitForSelector('#plugin:not(.hidden)');
  return { app, shell, ud };
}

/** UI 安装流：市场 tab 点安装 → 信任确认 modal → 确认安装（data-install = entryId 复合键） */
async function installViaUi(shell: import('@playwright/test').Page, name: string, owner: string): Promise<void> {
  const id = entryId(name, owner);
  await shell.waitForSelector(`[data-install="${id}"]`);
  await shell.click(`[data-install="${id}"]`);
  await shell.waitForSelector('.sk-modal [data-ok]');
  await shell.click('.sk-modal [data-ok]');
}

test('验收 ①安装生效 ②更新版本变化 ③卸载恢复（安装→更新→卸载生命周期，fake dsh fixture 全链）', async () => {
  const reg = await startFakePluginRegistry(FIXTURE_ENTRIES);
  const { app, shell, ud } = await launchPluginsApp({ HULL_E2E_REGISTRY: reg.url });
  try {
    // ── ① 安装生效：市场 tab 点安装 → 确认 → fixture 出现 bundle + UI 已装列表出现 ──
    await installViaUi(shell, 'e2e-demo', 'dsh-hull-desktop');
    const installed = await waitForFixturePlugins(ud.dir, (p) => p.some((x) => x.name === 'e2e-demo' && x.version === '1.0.0'));
    expect(installed).toHaveLength(1);
    expect(installed[0]!.profile).toBe('hull');

    await shell.click('[data-tab="installed"]');
    await expect(shell.locator('#pkt-list')).toContainText('e2e-demo');
    await expect(shell.locator('#pkt-list')).toContainText('已安装');
    await expect(shell.locator('#pkt-list')).toContainText('1.0.0');

    // ── ② 更新版本变化：bridge 通道 pluginUpdate → fixture 1.0.1 → UI 已装列表版本变化 ──
    const upd = await shell.evaluate(() =>
      (window as unknown as { hull: { pluginUpdate(p: { id: string }): Promise<{ ok: boolean }> } }).hull.pluginUpdate({ id: 'e2e-demo' }),
    );
    expect(upd.ok).toBe(true);
    await waitForFixturePlugins(ud.dir, (p) => p.some((x) => x.name === 'e2e-demo' && x.version === '1.0.1'));
    await shell.click('#pkt-refresh'); // 重新检测 → UI 反映新版本
    await expect(shell.locator('#pkt-list')).toContainText('1.0.1');

    // ── ③ 卸载恢复：UI 二次确认 → fixture 清空 + UI 空态 ──
    await shell.click('[data-uninstall="e2e-demo"]');
    await shell.waitForSelector('.sk-modal [data-ok]');
    await shell.click('.sk-modal [data-ok]');
    await waitForFixturePlugins(ud.dir, (p) => p.length === 0);
    await expect(shell.locator('#pkt-list')).toContainText('尚未安装任何插件');
  } finally {
    await app.close();
    await reg.close();
    ud.cleanup();
  }
});

test('验收 ④白名单外 entryId 拒绝：plugin-not-whitelisted + 零副作用（无 fixture 落盘）', async () => {
  const reg = await startFakePluginRegistry(FIXTURE_ENTRIES);
  const { app, shell, ud } = await launchPluginsApp({ HULL_E2E_REGISTRY: reg.url });
  try {
    // 市场已加载（registry 拉取成功 → 白名单条目就位）
    await shell.waitForSelector('[data-install="e2e-demo#dsh-hull-desktop"]');

    const res = await shell.evaluate(() =>
      (window as unknown as { hull: { pluginInstall(p: { entryId: string }): Promise<{ ok: boolean; code?: string }> } }).hull.pluginInstall({ entryId: 'not-in-registry' }),
    );
    expect(res.ok).toBe(false);
    expect(res.code).toBe('plugin-not-whitelisted');
    // 零副作用：拒绝发生在任何 dsh 调用前，fixture 文件不应存在
    expect(existsSync(join(ud.dir, 'fixture-plugins.json'))).toBe(false);
  } finally {
    await app.close();
    await reg.close();
    ud.cleanup();
  }
});

test('验收 ⑤ registry 不可达：HULL_E2E_REGISTRY 指向不存在 → 降级文案 + snapshot 可用标注（离线快照兜底）', async () => {
  // 死端口（127.0.0.1:1 连接拒绝即时失败；snapshot = 打包 assets 内置兜底）
  const { app, shell, ud } = await launchPluginsApp({ HULL_E2E_REGISTRY: 'http://127.0.0.1:1/plugins.json' });
  try {
    // snapshot 条目渲染（4105 条真实快照；作用域 #pkt-list——.sk-row 会被隐藏的 skills 区同名行干扰）
    await shell.waitForSelector('#pkt-list .sk-row');
    // 来源标注 = 离线快照 + 降级文案
    await expect(shell.locator('#pkt-statusbar')).toContainText('离线快照');
    await expect(shell.locator('#pkt-statusbar')).toContainText('registry 不可达');
  } finally {
    await app.close();
    ud.cleanup();
  }
});
