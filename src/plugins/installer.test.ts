import { test } from 'node:test';
import { deepEqual, equal, ok, rejects } from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { DshCliRunner, DshPluginCommand } from './cli';
import { PluginError } from './errors';
import type { GateDeps } from './gate';
import { PluginInstaller, type InstallerDeps } from './installer';
import type { DshCliResult, PluginPreview, RegistryEntry } from './types';

const ENTRIES: RegistryEntry[] = [
  { name: 'demo-plugin', owner: 'hull', url: 'https://npm.example/demo.tgz' },
  { name: 'demo-plugin', owner: 'other', url: 'https://npm.example/demo-other.tgz' },
  { name: 'needs-version', owner: 'hull', url: 'https://npm.example/needs-version.tgz', minDshVersion: '1.2.0' },
];
const PREVIEW: PluginPreview = {
  id: 'demo-plugin',
  version: '1.2.3',
  patchSummary: '将修改 2 处',
  sourceUrl: ENTRIES[0].url,
  previewUnavailable: false,
};
const LIST_HAS_DEMO: DshCliResult = { ok: true, stdout: 'demo-plugin 1.2.3\nother 0.1.0\n' };
const LIST_NO_DEMO: DshCliResult = { ok: true, stdout: 'other 0.1.0\n' };

const gateOpen = (): GateDeps => ({
  isUpgradeActive: () => false,
  isHullUpdateActive: () => false,
  hasPluginInflight: () => false,
});

interface FakeRunner {
  calls: Array<{ cmd: DshPluginCommand; args: string[] }>;
  run(cmd: DshPluginCommand, args: string[]): Promise<DshCliResult>;
}

function makeRunner(script: Partial<Record<DshPluginCommand, DshCliResult | Promise<DshCliResult>>> = {}): FakeRunner {
  const calls: Array<{ cmd: DshPluginCommand; args: string[] }> = [];
  const run: FakeRunner['run'] = async (cmd, args) => {
    calls.push({ cmd, args });
    const r = script[cmd];
    if (r !== undefined) return r;
    if (cmd === 'list') return LIST_HAS_DEMO;
    return { ok: true, stdout: 'ok' };
  };
  return { calls, run };
}

function makeInstaller(runner: FakeRunner, over: Partial<InstallerDeps> = {}) {
  const profileDir = mkdtempSync(join(tmpdir(), 'hull-pf-'));
  const tmpRoot = mkdtempSync(join(tmpdir(), 'hull-tmp-'));
  // FakeRunner 结构兼容 DshCliRunner（类含私有字段，结构赋值不适用 → 显式断言）
  const inst = new PluginInstaller({
    runner: runner as unknown as DshCliRunner,
    entries: ENTRIES,
    profileDir,
    tmpRoot,
    gate: gateOpen(),
    preview: async () => ({ ...PREVIEW }),
    ...over,
  });
  return { inst, profileDir, tmpRoot };
}

const rejectCode = (code: string) => (err: unknown): boolean => {
  equal((err as PluginError).code, code);
  return true;
};

test('install：全路径 preview → confirm → done（runner 调用序列 + 快照复位）', async () => {
  const runner = makeRunner();
  const { inst } = makeInstaller(runner);

  const p = await inst.install('demo-plugin#hull');
  equal(p.stage, 'preview');
  // 类型化空数组：deepEqual 是断言函数（asserts actual is T），[] 会把 calls 收窄成 never[]
  deepEqual(runner.calls, [] as Array<{ cmd: DshPluginCommand; args: string[] }>, '白名单+预览阶段无 runner 调用');
  deepEqual(inst.getSnapshot(), { step: 'preview-ready', inflight: null });

  const d = await inst.install('demo-plugin#hull', true);
  equal(d.stage, 'done');
  deepEqual(d.installed, {
    id: 'demo-plugin',
    name: 'demo-plugin',
    version: '1.2.3',
    registryVersion: null,
    status: 'installed',
  });
  deepEqual(
    runner.calls.map((c) => c.cmd),
    ['list', 'add', 'list']
  );
  deepEqual(runner.calls[1].args, ['https://npm.example/demo.tgz'], 'add 用白名单反查 URL，不接受外部 URL');
  deepEqual(inst.getSnapshot(), { step: 'idle', inflight: null });
});

test('install：同 name 不同 owner → 各自 entryId 命中正确条目（防装错）', async () => {
  const runner = makeRunner();
  const { inst } = makeInstaller(runner, {
    preview: async (url: string) => ({ ...PREVIEW, sourceUrl: url, id: url.split('/').pop() ?? 'x' }),
  });

  const p1 = await inst.install('demo-plugin#other');
  equal(p1.stage, 'preview');
  if (p1.stage === 'preview') equal(p1.preview.sourceUrl, 'https://npm.example/demo-other.tgz');

  const d = await inst.install('demo-plugin#other', true);
  equal(d.stage, 'done');
  deepEqual(runner.calls[1].args, ['https://npm.example/demo-other.tgz'], 'add 用 owner=other 条目 URL');
  // 白名单命中 owner=hull 的条目 → plugin-not-whitelisted？不：owner=other 条目在表内，验证 add URL 已区分
  deepEqual(runner.calls[1], { cmd: 'add', args: ['https://npm.example/demo-other.tgz'] });
});

test('install：白名单拒绝 → plugin-not-whitelisted（零副作用）', async () => {
  const runner = makeRunner();
  const { inst } = makeInstaller(runner);
  await rejects(inst.install('evil-plugin#hull'), rejectCode('plugin-not-whitelisted'));
  await rejects(inst.install('demo-plugin'), rejectCode('plugin-not-whitelisted'), '缺 #owner 段的旧格式不匹配');
  deepEqual(runner.calls, []);
});

test('install：add 失败 → dsh remove 清理痕迹 → plugin-install-failed', async () => {
  const runner = makeRunner({
    add: { ok: false, code: 1, message: 'boom', stderrTail: 'EAI_AGAIN' },
  });
  const { inst } = makeInstaller(runner);
  await rejects(inst.install('demo-plugin#hull', true), rejectCode('plugin-install-failed'));
  deepEqual(
    runner.calls.map((c) => c.cmd),
    ['list', 'add', 'remove']
  );
  deepEqual(runner.calls[2].args, ['https://npm.example/demo.tgz'], '清理 remove 用同一 URL');
  deepEqual(inst.getSnapshot(), { step: 'idle', inflight: null }, '失败后复位');
});

test('install：验证失败（list 缺 bundle）→ dsh remove 清理 → plugin-install-failed', async () => {
  const runner = makeRunner({ list: LIST_NO_DEMO });
  const { inst } = makeInstaller(runner);
  await rejects(inst.install('demo-plugin#hull', true), rejectCode('plugin-install-failed'));
  deepEqual(
    runner.calls.map((c) => c.cmd),
    ['list', 'add', 'list', 'remove']
  );
});

test('install：验证失败（list 子进程失败）→ ensureProfile 前置即失败 → plugin-profile-missing，add 未调用', async () => {
  const runner = makeRunner({ list: { ok: false, code: 1, message: 'dsh down', stderrTail: '' } });
  const { inst } = makeInstaller(runner);
  await rejects(inst.install('demo-plugin#hull', true), rejectCode('plugin-profile-missing'));
  deepEqual(
    runner.calls.map((c) => c.cmd),
    ['list']
  );
});

test('install：ensureProfile 前置失败（dsh 缺失）→ plugin-profile-missing，add 未调用', async () => {
  const runner = makeRunner();
  const { inst } = makeInstaller(runner, {
    ensureProfile: async () => {
      throw new PluginError('plugin-profile-missing', '插件 profile hull 不可用');
    },
  });
  await rejects(inst.install('demo-plugin#hull', true), rejectCode('plugin-profile-missing'));
  deepEqual(runner.calls, [], 'ensureProfile 失败 → 不触达 dsh add');
  deepEqual(inst.getSnapshot(), { step: 'idle', inflight: null }, '失败后复位');
});

test('install：minDshVersion 满足 → preview.versionTooOld=false（不提示）', async () => {
  const runner = makeRunner();
  const { inst } = makeInstaller(runner, { dshVersion: async () => '1.5.0' });
  const p = await inst.install('needs-version#hull');
  equal(p.stage, 'preview');
  if (p.stage === 'preview') equal(p.preview.versionTooOld, false);
});

test('install：minDshVersion 不满足（当前版本低）→ preview.versionTooOld=true（提示用，不拦截）', async () => {
  const runner = makeRunner();
  const { inst } = makeInstaller(runner, { dshVersion: async () => '1.1.0' });
  const p = await inst.install('needs-version#hull');
  equal(p.stage, 'preview');
  if (p.stage === 'preview') equal(p.preview.versionTooOld, true);
  // 仍可继续确认安装（不拦截）
  const d = await inst.install('needs-version#hull', true);
  equal(d.stage, 'done');
});

test('install：无 minDshVersion → 不比较版本（versionTooOld 缺省 false）', async () => {
  const runner = makeRunner();
  const { inst } = makeInstaller(runner, { dshVersion: async () => '0.0.1' });
  const p = await inst.install('demo-plugin#hull');
  equal(p.stage, 'preview');
  if (p.stage === 'preview') equal(p.preview.versionTooOld, false);
});

test('update：未安装 → plugin-not-installed（update 未调用）', async () => {
  const runner = makeRunner({ list: LIST_NO_DEMO });
  const { inst } = makeInstaller(runner);
  await rejects(inst.update('demo-plugin'), rejectCode('plugin-not-installed'));
  deepEqual(
    runner.calls.map((c) => c.cmd),
    ['list']
  );
});

test('update：成功 → updated 版本变化（委托 dsh update）', async () => {
  const runner = makeRunner({ update: { ok: true, stdout: 'demo-plugin@2.0.0 updated\n' } });
  const { inst } = makeInstaller(runner);
  const r = await inst.update('demo-plugin');
  equal(r.updated.version, '2.0.0');
  equal(r.updated.status, 'installed');
  deepEqual(runner.calls[1], { cmd: 'update', args: ['demo-plugin'] });
});

test('update：dsh 失败 → plugin-update-failed（透传 stderr 摘要）', async () => {
  const runner = makeRunner({ update: { ok: false, code: 1, message: 'boom', stderrTail: 'ENOTFOUND' } });
  const { inst } = makeInstaller(runner);
  await rejects(inst.update('demo-plugin'), (err: unknown) => {
    equal((err as PluginError).code, 'plugin-update-failed');
    ok((err as PluginError).message.includes('ENOTFOUND'));
    return true;
  });
});

test('uninstall：未安装 → plugin-not-installed（remove 未调用）', async () => {
  const runner = makeRunner({ list: LIST_NO_DEMO });
  const { inst } = makeInstaller(runner);
  await rejects(inst.uninstall('demo-plugin'), rejectCode('plugin-not-installed'));
  deepEqual(
    runner.calls.map((c) => c.cmd),
    ['list']
  );
});

test('uninstall：成功 → removed + 委托 dsh remove', async () => {
  const runner = makeRunner();
  const { inst } = makeInstaller(runner);
  const r = await inst.uninstall('demo-plugin');
  deepEqual(r, { removed: true });
  deepEqual(runner.calls[1], { cmd: 'remove', args: ['demo-plugin'] });
});

test('并发：in-flight 期间重复 confirm → plugin-busy（单飞）', async () => {
  let resolveAdd!: (r: DshCliResult) => void;
  const addGate = new Promise<DshCliResult>((res) => {
    resolveAdd = res;
  });
  const runner = makeRunner({ add: addGate });
  const { inst } = makeInstaller(runner);

  await inst.install('demo-plugin#hull'); // 预热预览缓存
  const first = inst.install('demo-plugin#hull', true);
  deepEqual(inst.getSnapshot().inflight, { kind: 'install', id: 'demo-plugin#hull' });
  await rejects(inst.install('demo-plugin#hull', true), rejectCode('plugin-busy'));

  resolveAdd({ ok: true, stdout: 'ok' });
  const d = await first;
  equal(d.stage, 'done');
  deepEqual(inst.getSnapshot().inflight, null);
});

test('门控：dsh 升级进行中 → plugin-busy（预览与确认均拒绝）', async () => {
  const runner = makeRunner();
  const { inst } = makeInstaller(runner, { gate: { ...gateOpen(), isUpgradeActive: () => true } });
  await rejects(inst.install('demo-plugin#hull'), rejectCode('plugin-busy'));
  await rejects(inst.install('demo-plugin#hull', true), rejectCode('plugin-busy'));
  deepEqual(runner.calls, []);
});
