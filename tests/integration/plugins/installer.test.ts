/**
 * P5 integration —— 插件 installer/profile/manifest/gate 全链（设计 §1.4~1.7 / 契约 §联调与测试场景）：
 * 真 FS（临时 userData + overlay bin 指向 tests/fixtures/fake-dsh.js）+ 真实 DshCliRunner 子进程
 * （fake dsh 插件子命令维护 <userData>/fixture-plugins.json，HULL_E2E 语义）。
 * 覆盖：安装全链（preview→confirm→done）/ 白名单拒绝零副作用 / add 失败清理（留痕+崩溃窗口）/
 * 更新版本变化 / 卸载 / 门控矩阵 / manifest 预览（注入 pack 真 FS + 临时目录清理）/ reconcile。
 */
import { test, after } from 'node:test';
import { equal, ok, rejects, deepEqual } from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { DshCliRunner } from '../../../src/plugins/cli';
import { PluginError } from '../../../src/plugins/errors';
import type { GateDeps } from '../../../src/plugins/gate';
import { PluginInstaller } from '../../../src/plugins/installer';
import { previewBundle } from '../../../src/plugins/manifest';
import { reconcileInstalled } from '../../../src/plugins/profile';
import type { PluginPreview, RegistryEntry } from '../../../src/plugins/types';
import { NOOP_LOGGER } from '../../../src/shared/types';

/** fake dsh 绝对路径（dist-tests/tests/integration/plugins → 项目根/tests/fixtures） */
const FAKE_DSH = join(__dirname, '..', '..', '..', '..', 'tests', 'fixtures', 'fake-dsh.js');

const dirs: string[] = [];
function mkTemp(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}
after(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

/** 种子 overlay 布局（<userData>/dsh/bin/dsh → fake 脚本；DshCliRunner dshBinPath 解析面） */
function seedOverlay(userData: string): void {
  const binDir = join(userData, 'dsh', 'bin');
  mkdirSync(binDir, { recursive: true });
  writeFileSync(join(binDir, 'dsh'), readFileSync(FAKE_DSH, 'utf8'));
}

const ENTRIES: RegistryEntry[] = [
  { name: 'acme-plugin', owner: 'acme', url: 'https://example.com/acme-plugin', category: 'util' },
  { name: 'http-entry', owner: 'acme', url: 'http://example.com/insecure' }, // 非 https → 白名单拒
];

const defaultPreview = async (url: string): Promise<PluginPreview> => ({
  id: 'acme-plugin',
  version: '1.0.0',
  patchSummary: '将修改 config.yaml（integration mock）',
  sourceUrl: url,
  previewUnavailable: false,
});

function readFixture(userData: string): { plugins: Array<{ id: string; name: string; version: string; url?: string; profile?: string }> } {
  return JSON.parse(readFileSync(join(userData, 'fixture-plugins.json'), 'utf8')) as { plugins: Array<{ id: string; name: string; version: string; url?: string; profile?: string }> };
}

function isPluginError(e: unknown, code: string): boolean {
  return e instanceof PluginError && e.code === code;
}

function makeInstaller(
  userData: string,
  opts: { gate?: GateDeps; failAt?: string; entries?: RegistryEntry[]; preview?: (url: string) => Promise<PluginPreview> } = {},
): PluginInstaller {
  const runner = new DshCliRunner({
    userDataPath: userData,
    profile: 'hull',
    logger: NOOP_LOGGER,
    failAt: opts.failAt, // HULL_E2E=1 时生效（plugin-<cmd>:exit = 启动即杀崩溃窗口）
  });
  const gate: GateDeps = opts.gate ?? {
    isUpgradeActive: () => false,
    isHullUpdateActive: () => false,
    hasPluginInflight: () => false,
  };
  return new PluginInstaller({
    runner,
    entries: opts.entries ?? ENTRIES,
    profileDir: join(userData, 'dsh'),
    tmpRoot: join(userData, 'tmp'),
    gate,
    preview: opts.preview ?? defaultPreview,
    logger: NOOP_LOGGER,
  });
}

/** fake 状态文件落点：env HULL_FAKE_DSH_USER_DATA 传播给 spawn 子进程（fake 直读） */
function useUserData(userData: string): void {
  process.env.HULL_FAKE_DSH_USER_DATA = userData;
}

test('安装全链：preview → confirm → done（真 FS fixture 落盘 + dsh list 验证就位）', async () => {
  const ud = mkTemp('hull-inst-');
  seedOverlay(ud);
  useUserData(ud);
  const installer = makeInstaller(ud);

  const r1 = await installer.install('acme-plugin#acme');
  equal(r1.stage, 'preview');
  if (r1.stage === 'preview') {
    equal(r1.preview.id, 'acme-plugin');
    equal(r1.preview.version, '1.0.0');
  }

  const r2 = await installer.install('acme-plugin#acme', true);
  equal(r2.stage, 'done');
  const state = readFixture(ud);
  equal(state.plugins.length, 1, 'fixture 恰好一条');
  equal(state.plugins[0]!.name, 'acme-plugin');
  equal(state.plugins[0]!.version, '1.0.0');
  equal(state.plugins[0]!.profile, 'hull');
});

test('白名单拒绝：未知 entryId / 非 https url → plugin-not-whitelisted + 零副作用（无任何子进程状态）', async () => {
  const ud = mkTemp('hull-inst-');
  seedOverlay(ud);
  useUserData(ud);
  const installer = makeInstaller(ud);

  await rejects(installer.install('no-such-plugin'), (e) => isPluginError(e, 'plugin-not-whitelisted'));
  await rejects(installer.install('http-entry'), (e) => isPluginError(e, 'plugin-not-whitelisted'));
  await rejects(installer.install('no-such-plugin', true), (e) => isPluginError(e, 'plugin-not-whitelisted'));
  // 零副作用：白名单拒绝发生在任何 runner 调用前，fixture 文件不应存在
  ok(!existsSync(join(ud, 'fixture-plugins.json')), '白名单拒绝零副作用（无 fixture 落盘）');
});

test('add 失败清理：注入 plugin-add（写入留痕后失败）→ installer remove 该次痕迹 → fixture 无残留', async () => {
  const ud = mkTemp('hull-inst-');
  seedOverlay(ud);
  useUserData(ud);
  process.env.HULL_E2E = '1';
  process.env.HULL_E2E_FAIL_AT = 'plugin-add'; // 经 process.env 传播给 fake 子进程
  try {
    const installer = makeInstaller(ud, { failAt: 'plugin-add' });
    await rejects(installer.install('acme-plugin#acme', true), (e) => isPluginError(e, 'plugin-install-failed'));
    const state = readFixture(ud);
    equal(state.plugins.length, 0, '失败痕迹已被清理');
  } finally {
    delete process.env.HULL_E2E;
    delete process.env.HULL_E2E_FAIL_AT;
  }
});

test('add 崩溃窗口：注入 plugin-add:exit（启动即杀，无痕）→ plugin-install-failed + 无残留', async () => {
  const ud = mkTemp('hull-inst-');
  seedOverlay(ud);
  useUserData(ud);
  process.env.HULL_E2E = '1';
  process.env.HULL_E2E_FAIL_AT = 'plugin-add:exit';
  try {
    const installer = makeInstaller(ud, { failAt: 'plugin-add:exit' });
    await rejects(installer.install('acme-plugin#acme', true), (e) => isPluginError(e, 'plugin-install-failed'));
    ok(!existsSync(join(ud, 'fixture-plugins.json')), '崩溃窗口无痕迹');
  } finally {
    delete process.env.HULL_E2E;
    delete process.env.HULL_E2E_FAIL_AT;
  }
});

test('更新：版本 1.0.0 → 1.0.1（fixture 变化）；未安装 → plugin-not-installed', async () => {
  const ud = mkTemp('hull-inst-');
  seedOverlay(ud);
  useUserData(ud);
  const installer = makeInstaller(ud);

  await installer.install('acme-plugin#acme', true);
  const u = await installer.update('acme-plugin');
  equal(u.updated.version, '1.0.1');
  equal(readFixture(ud).plugins[0]!.version, '1.0.1');

  await rejects(installer.update('not-installed'), (e) => isPluginError(e, 'plugin-not-installed'));
});

test('卸载：removed + fixture 消失；未安装 → plugin-not-installed', async () => {
  const ud = mkTemp('hull-inst-');
  seedOverlay(ud);
  useUserData(ud);
  const installer = makeInstaller(ud);

  await installer.install('acme-plugin#acme', true);
  const r = await installer.uninstall('acme-plugin');
  deepEqual(r, { removed: true });
  equal(readFixture(ud).plugins.length, 0, '卸载后 fixture 空');

  await rejects(installer.uninstall('acme-plugin#acme'), (e) => isPluginError(e, 'plugin-not-installed'));
});

test('门控矩阵：升级中 / 自更新中 / in-flight → plugin-busy；全放行 → 正常预览', async () => {
  const ud = mkTemp('hull-inst-');
  seedOverlay(ud);
  useUserData(ud);

  const gates: Array<[string, GateDeps]> = [
    ['dsh 升级中', { isUpgradeActive: () => true, isHullUpdateActive: () => false, hasPluginInflight: () => false }],
    ['Hull 自更新中', { isUpgradeActive: () => false, isHullUpdateActive: () => true, hasPluginInflight: () => false }],
    ['插件操作 in-flight', { isUpgradeActive: () => false, isHullUpdateActive: () => false, hasPluginInflight: () => true }],
  ];
  for (const [label, gate] of gates) {
    const installer = makeInstaller(ud, { gate });
    await rejects(installer.install('acme-plugin#acme'), (e) => isPluginError(e, 'plugin-busy'), label);
    await rejects(installer.install('acme-plugin#acme', true), (e) => isPluginError(e, 'plugin-busy'), label);
  }

  const okInstaller = makeInstaller(ud);
  const r = await okInstaller.install('acme-plugin#acme');
  equal(r.stage, 'preview');
});

test('manifest 预览：真 FS 注入 pack → patch 摘要；pack 失败 → previewUnavailable；临时目录清理', async () => {
  const tmp = mkTemp('hull-mf-');
  const workSeen: string[] = [];
  const pack = async (spec: string, targetDir: string) => {
    workSeen.push(targetDir);
    mkdirSync(join(targetDir, 'package'), { recursive: true });
    writeFileSync(join(targetDir, 'package', 'package.json'), JSON.stringify({ name: 'demo-bundle', version: '2.3.4', dsh: { bundle: 'cordis.patch.yml' } }));
    writeFileSync(join(targetDir, 'package', 'cordis.patch.yml'), '- path: config.yaml\n- path: main.ts\n- path: deep.ts\n- path: deeper.ts\n');
    return { ok: true, dir: join(targetDir, 'package') };
  };

  const p = await previewBundle('https://example.com/demo-bundle', tmp, { pack });
  equal(p.id, 'demo-bundle');
  equal(p.version, '2.3.4');
  ok(p.patchSummary?.includes('config.yaml'), 'patch 摘要含文件清单');
  ok(p.patchSummary?.includes('4 处'), 'patch 摘要计数');
  equal(p.previewUnavailable, false);
  equal(readdirSync(tmp).length, 0, '临时目录用完即清');

  // 失败路径：pack 返回失败 → previewUnavailable 标记（不阻断安装语义）
  const bad = await previewBundle('https://example.com/broken', tmp, {
    pack: async () => ({ ok: false, dir: null, message: 'npm pack 404' }),
  });
  equal(bad.previewUnavailable, true);
  equal(bad.id, 'unknown');
  equal(readdirSync(tmp).length, 0, '失败路径同样清理');
});

test('reconcile：真实 fake dsh list（profile 过滤 + JSON 解析）', async () => {
  const ud = mkTemp('hull-inst-');
  seedOverlay(ud);
  useUserData(ud);
  writeFileSync(
    join(ud, 'fixture-plugins.json'),
    JSON.stringify({
      plugins: [
        { id: 'hull-one', name: 'hull-one', version: '1.2.3', profile: 'hull' },
        { id: 'web-one', name: 'web-one', version: '0.9.0', profile: 'web' },
      ],
    }),
  );
  const runner = new DshCliRunner({ userDataPath: ud, profile: 'hull', logger: NOOP_LOGGER });
  const installed = await reconcileInstalled(runner, { profile: 'hull', logger: NOOP_LOGGER });
  equal(installed.length, 1, '仅 hull profile 条目');
  equal(installed[0]!.id, 'hull-one');
  equal(installed[0]!.version, '1.2.3');
  equal(installed[0]!.status, 'installed');
});
