import { test, after } from 'node:test';
import { deepEqual, equal, ok, rejects } from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { NOOP_LOGGER } from '../shared/types';

import { PluginError } from './errors';
import {
  ensureHullProfile,
  ensureProfile,
  filterByProfile,
  HULL_PLUGIN_PROFILE,
  parseBundleList,
  reconcileInstalled,
  type ParsedBundle,
} from './profile';
import type { DshCliResult } from './types';

test('HULL_PLUGIN_PROFILE = hull', () => {
  equal(HULL_PLUGIN_PROFILE, 'hull');
});

test('parseBundleList：JSON 数组', () => {
  const out = parseBundleList('[{"id":"a","name":"A","version":"1.0.0"},{"bundle":"b","version":"2.0.0"}]');
  deepEqual(out, [
    { id: 'a', name: 'A', version: '1.0.0' },
    { id: 'b', name: 'b', version: '2.0.0' },
  ]);
});

test('parseBundleList：{ plugins: [...] } 包裹', () => {
  const out = parseBundleList('{"plugins":[{"id":"a","name":"A","version":"1.0.0"}]}');
  deepEqual(out, [{ id: 'a', name: 'A', version: '1.0.0' }]);
});

test('parseBundleList：JSON 项含 profile 字段保留', () => {
  const out = parseBundleList('[{"id":"a","name":"A","version":"1","profile":"hull"}]');
  deepEqual(out, [{ id: 'a', name: 'A', version: '1', profile: 'hull' }]);
});

test('parseBundleList：文本行（id@version / id version / 裸 id / 空行 / 注释）', () => {
  const out = parseBundleList('# 注释行\n\nfoo@1.0.0\nbar 2.1.0\nbare\n');
  deepEqual(out, [
    { id: 'foo', name: 'foo', version: '1.0.0' },
    { id: 'bar', name: 'bar', version: '2.1.0' },
    { id: 'bare', name: 'bare', version: '' },
  ]);
});

test('parseBundleList：空输出 → []', () => {
  deepEqual(parseBundleList(''), []);
  deepEqual(parseBundleList('  \n  '), []);
});

test('filterByProfile：标注其他 profile 丢弃，未标注保留', () => {
  const bundles: ParsedBundle[] = [
    { id: 'a', name: 'a', version: '1' },
    { id: 'b', name: 'b', version: '1', profile: 'hull' },
    { id: 'c', name: 'c', version: '1', profile: 'work' },
  ];
  const out = filterByProfile(bundles);
  deepEqual(out.map((b) => b.id), ['a', 'b']);
});

test('reconcileInstalled：dsh list → InstalledPlugin[]（registryVersion null，status installed）', async () => {
  let listCalled = 0;
  const runner = {
    run: async (cmd: 'list', args?: string[]): Promise<DshCliResult> => {
      listCalled++;
      deepEqual(args, []);
      void cmd;
      return { ok: true, stdout: '[{"id":"a","name":"A","version":"1.0.0"},{"id":"skip","name":"S","version":"1","profile":"work"}]' };
    },
  };
  const out = await reconcileInstalled(runner, { logger: NOOP_LOGGER });
  equal(listCalled, 1);
  deepEqual(out, [{ id: 'a', name: 'A', version: '1.0.0', registryVersion: null, status: 'installed' }]);
});

test('reconcileInstalled：dsh 不可达 → plugin-profile-missing', async () => {
  const runner = {
    run: async (): Promise<DshCliResult> => ({ ok: false, code: 1, message: 'dsh boom', stderrTail: 'err' }),
  };
  await rejects(reconcileInstalled(runner), (err: unknown) => err instanceof PluginError && err.code === 'plugin-profile-missing');
});

test('ensureProfile：list 成功 → 就绪', async () => {
  let calls = 0;
  const runner = {
    run: async (): Promise<DshCliResult> => {
      calls++;
      return { ok: true, stdout: '[]' };
    },
  };
  await ensureProfile(runner, NOOP_LOGGER);
  equal(calls, 1);
});

test('ensureProfile：list 失败 → plugin-profile-missing', async () => {
  const runner = {
    run: async (): Promise<DshCliResult> => ({ ok: false, code: 2, message: 'profile hull not found', stderrTail: 'x' }),
  };
  await rejects(ensureProfile(runner, NOOP_LOGGER), (err: unknown) => err instanceof PluginError && err.code === 'plugin-profile-missing');
});

// ── ensureHullProfile（壳启动 profile 初始化/修复） ──

const tmpHomes: string[] = [];
after(() => {
  for (const home of tmpHomes) rmSync(home, { recursive: true, force: true });
});

function makeHome(): string {
  const home = mkdtempSync(join(tmpdir(), 'hull-profile-'));
  tmpHomes.push(home);
  return home;
}

function readJson(path: string): Record<string, any> {
  return JSON.parse(readFileSync(path, 'utf8')) as Record<string, any>;
}

function writeFile(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, 'utf8');
}

test('ensureHullProfile：无 web profile → 建最小 hull（base + web-app + patchReload live）', () => {
  const home = makeHome();
  const res = ensureHullProfile({ home, logger: NOOP_LOGGER });
  deepEqual(res, { initialized: true, repaired: false, migratedPatch: false });
  const pkg = readJson(join(home, '.dsh', 'profiles', 'hull', 'package.json'));
  equal(pkg.name, 'dsh-profile-hull');
  equal(pkg.private, true);
  deepEqual(pkg.dsh.profile.bundles, ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app']);
  equal(pkg.dsh.profile.patchReload, 'live');
});

test('ensureHullProfile：有 web profile → 复制 patch/cordis/workspace，保留自定义 bundle，只改 name', () => {
  const home = makeHome();
  const webDir = join(home, '.dsh', 'profiles', 'web');
  const patch = 'plugins:\n  demo:\n    enabled: true\n';
  const cordis = 'foo: bar\n';
  const workspace = 'packages:\n  - .\n';
  writeFile(
    join(webDir, 'package.json'),
    JSON.stringify({
      name: 'dsh-profile-web',
      private: true,
      dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@custom/extra'], patchReload: 'live' } },
      dependencies: { '@deepseek-ai/dsh-web-app': '1.0.0' },
    }),
  );
  writeFileSync(join(webDir, 'cordis.patch.yml'), patch, 'utf8');
  writeFileSync(join(webDir, 'cordis.yml'), cordis, 'utf8');
  writeFileSync(join(webDir, 'pnpm-workspace.yaml'), workspace, 'utf8');

  const res = ensureHullProfile({ home, logger: NOOP_LOGGER });
  deepEqual(res, { initialized: true, repaired: false, migratedPatch: false });
  const hullDir = join(home, '.dsh', 'profiles', 'hull');
  equal(readFileSync(join(hullDir, 'cordis.patch.yml'), 'utf8'), patch, '用户 patch 原样保留');
  equal(readFileSync(join(hullDir, 'cordis.yml'), 'utf8'), cordis);
  equal(readFileSync(join(hullDir, 'pnpm-workspace.yaml'), 'utf8'), workspace);
  const pkg = readJson(join(hullDir, 'package.json'));
  equal(pkg.name, 'dsh-profile-hull');
  deepEqual(pkg.dsh.profile.bundles, ['@deepseek-ai/dsh-base', '@custom/extra', '@deepseek-ai/dsh-web-app']);
  equal(pkg.dependencies['@deepseek-ai/dsh-web-app'], '1.0.0', '其余字段保留');
});

test('ensureHullProfile：hull 已存在缺 web-app → 补齐 bundles，不改 cordis.patch.yml', () => {
  const home = makeHome();
  const hullDir = join(home, '.dsh', 'profiles', 'hull');
  const patch = 'keep: me\n';
  writeFile(
    join(hullDir, 'package.json'),
    JSON.stringify({
      name: 'dsh-profile-hull',
      dsh: { profile: { bundles: ['@deepseek-ai/dsh-base'], patchReload: 'live' } },
      dependencies: { '@deepseek-ai/dsh-base': '1.0.0' },
    }),
  );
  writeFileSync(join(hullDir, 'cordis.patch.yml'), patch, 'utf8');

  const res = ensureHullProfile({ home, logger: NOOP_LOGGER });
  deepEqual(res, { initialized: false, repaired: true, migratedPatch: false });
  const pkg = readJson(join(hullDir, 'package.json'));
  deepEqual(pkg.dsh.profile.bundles, ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app']);
  equal(pkg.name, 'dsh-profile-hull', 'name 不变');
  equal(pkg.dsh.profile.patchReload, 'live');
  equal(readFileSync(join(hullDir, 'cordis.patch.yml'), 'utf8'), patch, 'patch 不被覆盖');
});

test('ensureHullProfile：幂等——bundle 齐备 → 不重写（二次调用 repaired=false）', () => {
  const home = makeHome();
  equal(ensureHullProfile({ home, logger: NOOP_LOGGER }).initialized, true);
  const pkgPath = join(home, '.dsh', 'profiles', 'hull', 'package.json');
  const before = readFileSync(pkgPath, 'utf8');
  const res = ensureHullProfile({ home, logger: NOOP_LOGGER });
  deepEqual(res, { initialized: false, repaired: false, migratedPatch: false });
  equal(readFileSync(pkgPath, 'utf8'), before, '内容未被重写');
});

test('ensureHullProfile：坏 JSON 不抛，返回未修复且文件不动', () => {
  const home = makeHome();
  const pkgPath = join(home, '.dsh', 'profiles', 'hull', 'package.json');
  writeFile(pkgPath, '{ not json');
  const res = ensureHullProfile({ home, logger: NOOP_LOGGER });
  deepEqual(res, { initialized: false, repaired: false, migratedPatch: false });
  equal(readFileSync(pkgPath, 'utf8'), '{ not json');
});

test('ensureHullProfile：hull 目录存在但缺 package.json → 补建最小 package.json', () => {
  const home = makeHome();
  mkdirSync(join(home, '.dsh', 'profiles', 'hull'), { recursive: true });
  const res = ensureHullProfile({ home, logger: NOOP_LOGGER });
  deepEqual(res, { initialized: false, repaired: true, migratedPatch: false });
  const pkg = readJson(join(home, '.dsh', 'profiles', 'hull', 'package.json'));
  deepEqual(pkg.dsh.profile.bundles, ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app']);
});

// ── 一次性 patch 迁移（web → hull，防用户模型/provider 配置丢失） ──

/** dsh plugin 自动创建 profile 时写入的原始模板（逐字） */
const DEFAULT_PATCH_TEMPLATE = [
  '# Your patch layer for this dsh profile, applied after every bundle layer:',
  '# a top-level YAML array of loader patch entries (id-targeted config',
  '# overrides, disables, and insert lists; `!!js` expressions allowed).',
  '[]',
  '',
].join('\n');

function seedHull(home: string, patch: string | null, bundles: string[] = ['@deepseek-ai/dsh-base']): string {
  const hullDir = join(home, '.dsh', 'profiles', 'hull');
  writeFile(
    join(hullDir, 'package.json'),
    JSON.stringify({ name: 'dsh-profile-hull', dsh: { profile: { bundles } } }),
  );
  if (patch !== null) writeFile(join(hullDir, 'cordis.patch.yml'), patch);
  return hullDir;
}

function seedWebPatch(home: string, content: string): void {
  writeFile(join(home, '.dsh', 'profiles', 'web', 'cordis.patch.yml'), content);
}

const REAL_PATCH = 'llm-pi-ai:\n  providers:\n    zhipu:\n      apiKeyEnv: ZHIPU_KEY\n      baseURL: https://example.test\n';

test('ensureHullProfile：hull patch 原始模板 + web 有真实配置 → 逐字迁移，bundles 同时补齐', () => {
  const home = makeHome();
  const hullDir = seedHull(home, DEFAULT_PATCH_TEMPLATE);
  seedWebPatch(home, REAL_PATCH);
  const res = ensureHullProfile({ home, logger: NOOP_LOGGER });
  deepEqual(res, { initialized: false, repaired: true, migratedPatch: true });
  equal(readFileSync(join(hullDir, 'cordis.patch.yml'), 'utf8'), REAL_PATCH, '用户配置逐字保留');
  const pkg = readJson(join(hullDir, 'package.json'));
  deepEqual(pkg.dsh.profile.bundles, ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'], '迁移不中断 bundle 补齐');
});

test('ensureHullProfile：hull patch 已有真实内容 → 不覆盖（migratedPatch=false）', () => {
  const home = makeHome();
  const own = 'own-config: keep\n';
  const hullDir = seedHull(home, own);
  seedWebPatch(home, REAL_PATCH);
  const res = ensureHullProfile({ home, logger: NOOP_LOGGER });
  equal(res.migratedPatch, false);
  equal(readFileSync(join(hullDir, 'cordis.patch.yml'), 'utf8'), own);
});

test('ensureHullProfile：web 不存在 / web 也是空模板 → 不迁移', () => {
  const home = makeHome();
  const hullDir = seedHull(home, DEFAULT_PATCH_TEMPLATE);
  equal(ensureHullProfile({ home, logger: NOOP_LOGGER }).migratedPatch, false, 'web 不存在');
  equal(readFileSync(join(hullDir, 'cordis.patch.yml'), 'utf8'), DEFAULT_PATCH_TEMPLATE);

  seedWebPatch(home, DEFAULT_PATCH_TEMPLATE);
  equal(ensureHullProfile({ home, logger: NOOP_LOGGER }).migratedPatch, false, 'web 也是空模板');
  equal(readFileSync(join(hullDir, 'cordis.patch.yml'), 'utf8'), DEFAULT_PATCH_TEMPLATE);
});

test('ensureHullProfile：迁移后二次调用幂等（migratedPatch=false，patch 不变）', () => {
  const home = makeHome();
  const hullDir = seedHull(home, DEFAULT_PATCH_TEMPLATE, ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app']);
  seedWebPatch(home, REAL_PATCH);
  equal(ensureHullProfile({ home, logger: NOOP_LOGGER }).migratedPatch, true);
  const res = ensureHullProfile({ home, logger: NOOP_LOGGER });
  deepEqual(res, { initialized: false, repaired: false, migratedPatch: false });
  equal(readFileSync(join(hullDir, 'cordis.patch.yml'), 'utf8'), REAL_PATCH);
});
