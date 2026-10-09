/**
 * P5 integration —— 插件 registry（设计 §1.3 / 契约 §联调与测试场景「市场加载/降级」）：
 * 真 FS（临时 snapshot 文件）+ 注入 fetchImpl/时钟。用例：首拉 remote / 1h 缓存命中 /
 * 过期重拉 / refresh 强制 / 失败回落 snapshot / 失败回落过期缓存 / 全失败 unreachable。
 * 注：registry 内存缓存为模块级（生产单例），用例间 clearRegistryCache 隔离。
 */
import { test, after } from 'node:test';
import { deepEqual, equal, ok, rejects } from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { PluginError } from '../../../src/plugins/errors';
import { clearRegistryCache, loadRegistry, type RegistryLoadResult } from '../../../src/plugins/registry';
import { NOOP_LOGGER } from '../../../src/shared/types';

const dirs: string[] = [];
function mkTemp(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}
after(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

const REMOTE_ENTRIES = [
  { name: 'alpha', owner: 'a', url: 'https://example.com/alpha', category: 'util' },
  { name: 'beta', owner: 'b', url: 'https://example.com/beta' },
];
const SNAPSHOT_ENTRIES = [{ name: 'snap-only', owner: 's', url: 'https://example.com/snap-only' }];

const T0 = new Date('2026-01-01T00:00:00.000Z');

/** 可注入行为的 fetch（calls 计数 + fail 开关） */
function makeFetch(calls: { n: number }, fail: () => boolean): typeof fetch {
  return async (input: unknown) => {
    calls.n++;
    if (fail()) throw new Error(`fetch failed ${String(input)}`);
    return new Response(JSON.stringify({ plugins: REMOTE_ENTRIES }));
  };
}

function makeOpts(tmp: string, fetchImpl: typeof fetch, now: () => Date) {
  return { url: 'https://registry.test/plugins.json', snapshotPath: join(tmp, 'snapshot.json'), fetchImpl, now, logger: NOOP_LOGGER };
}

function seedSnapshot(tmp: string, entries: unknown[]): void {
  writeFileSync(join(tmp, 'snapshot.json'), JSON.stringify({ plugins: entries }));
}

function isRegistryUnreachable(e: unknown): boolean {
  return e instanceof PluginError && e.code === 'plugin-registry-unreachable';
}

test('registry 首拉 remote（fetch 一次，entries 归一）', async () => {
  clearRegistryCache();
  const tmp = mkTemp('hull-reg-');
  const calls = { n: 0 };
  const r = await loadRegistry(makeOpts(tmp, makeFetch(calls, () => false), () => T0));
  equal(calls.n, 1);
  equal(r.source, 'remote');
  equal(r.entries.length, 2);
  deepEqual(r.entries.map((e) => e.name).sort(), ['alpha', 'beta']);
});

test('1h 内缓存命中（时钟注入：+30min 不重拉）', async () => {
  clearRegistryCache();
  const tmp = mkTemp('hull-reg-');
  const calls = { n: 0 };
  const now = { t: T0 };
  const opts = makeOpts(tmp, makeFetch(calls, () => false), () => now.t);
  await loadRegistry(opts);
  now.t = new Date(T0.getTime() + 30 * 60 * 1000);
  const r2 = await loadRegistry(opts);
  equal(calls.n, 1, '缓存命中不应重拉');
  equal(r2.source, 'cache');
  deepEqual(r2.entries.map((e) => e.name).sort(), ['alpha', 'beta']);
});

test('过期重拉（+61min 越过 1h TTL）', async () => {
  clearRegistryCache();
  const tmp = mkTemp('hull-reg-');
  const calls = { n: 0 };
  const now = { t: T0 };
  const opts = makeOpts(tmp, makeFetch(calls, () => false), () => now.t);
  await loadRegistry(opts);
  now.t = new Date(T0.getTime() + 61 * 60 * 1000);
  const r2 = await loadRegistry(opts);
  equal(calls.n, 2);
  equal(r2.source, 'remote');
});

test('refresh 强制重拉（TTL 内也拉；forceRefresh=true）', async () => {
  clearRegistryCache();
  const tmp = mkTemp('hull-reg-');
  const calls = { n: 0 };
  const opts = makeOpts(tmp, makeFetch(calls, () => false), () => T0);
  await loadRegistry(opts);
  const r2 = await loadRegistry(opts, true);
  equal(calls.n, 2);
  equal(r2.source, 'remote');
});

test('失败回落 snapshot（无缓存；真 FS snapshot 文件）', async () => {
  clearRegistryCache();
  const tmp = mkTemp('hull-reg-');
  seedSnapshot(tmp, SNAPSHOT_ENTRIES);
  const r = await loadRegistry(makeOpts(tmp, makeFetch({ n: 0 }, () => true), () => T0));
  equal(r.source, 'snapshot');
  deepEqual(r.entries.map((e) => e.name), ['snap-only']);
});

test('失败回落过期缓存（最近数据优先于 snapshot）', async () => {
  clearRegistryCache();
  const tmp = mkTemp('hull-reg-');
  seedSnapshot(tmp, SNAPSHOT_ENTRIES);
  const calls = { n: 0 };
  const now = { t: T0 };
  const opts = makeOpts(tmp, makeFetch(calls, () => false), () => now.t);
  await loadRegistry(opts); // 首拉成功入缓存
  now.t = new Date(T0.getTime() + 61 * 60 * 1000); // 过期
  const r2 = await loadRegistry(makeOpts(tmp, makeFetch(calls, () => true), () => now.t));
  equal(r2.source, 'cache', '过期缓存优先于 snapshot');
  equal(r2.entries.length, 2);
});

test('全失败（无缓存 + snapshot 空/缺失）→ plugin-registry-unreachable', async () => {
  clearRegistryCache();
  const tmp = mkTemp('hull-reg-');
  seedSnapshot(tmp, []); // 空列表 → loadSnapshot 视为不可用
  await rejects(
    loadRegistry(makeOpts(tmp, makeFetch({ n: 0 }, () => true), () => T0)),
    isRegistryUnreachable,
  );
});
