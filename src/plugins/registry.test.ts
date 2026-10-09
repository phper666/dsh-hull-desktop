import { test } from 'node:test';
import { deepEqual, equal, ok, rejects } from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after } from 'node:test';

import { NOOP_LOGGER } from '../shared/types';

import { PluginError } from './errors';
import { clearRegistryCache, loadRegistry, type RegistryOptions } from './registry';

const tempDirs: string[] = [];
after(() => {
  for (const d of tempDirs) rmSync(d, { recursive: true, force: true });
});

const SNAP = [{ name: 'snap-a', owner: 'o', url: 'https://snap.example/a' }];

const fetchOk = (data: unknown): typeof fetch =>
  ((async () => ({ ok: true, status: 200, json: async () => data })) as unknown as typeof fetch);
const fetchFail = (err: Error): typeof fetch =>
  ((async () => {
    throw err;
  }) as unknown as typeof fetch);

let t0 = 1_000_000;
const TTL = 60_000;

function makeOpts(over: Partial<RegistryOptions> = {}): RegistryOptions {
  const dir = mkdtempSync(join(tmpdir(), 'hull-reg-'));
  tempDirs.push(dir);
  const snapPath = join(dir, 'snapshot.json');
  writeFileSync(snapPath, JSON.stringify(SNAP));
  return {
    url: 'https://registry.example/plugins.json',
    cacheTtlMs: TTL,
    snapshotPath: snapPath,
    logger: NOOP_LOGGER,
    now: () => new Date(t0),
    ...over,
  };
}

test('首拉：remote 拉取 + 归一化 + fetchedAt', async () => {
  clearRegistryCache();
  const raw = [
    { name: 'a', owner: 'o', url: 'https://x/a', category: 'tool', deprecated: true, minDshVersion: '0.1.5' },
    { name: 'b', owner: 'o', url: 'https://x/b', install: 'pnpm add b' },
    { name: 'bad', owner: '' }, // 缺 url/owner → 丢弃
    'garbage',
  ];
  let calls = 0;
  const opts = makeOpts({ fetchImpl: fetchOk(raw) });
  const r = await loadRegistry(opts);
  equal(r.source, 'remote');
  equal(r.fetchedAt, new Date(t0).toISOString());
  equal(r.entries.length, 2);
  deepEqual(r.entries[0], {
    name: 'a',
    owner: 'o',
    url: 'https://x/a',
    category: 'tool',
    deprecated: true,
    minDshVersion: '0.1.5',
  });
  deepEqual(r.entries[1], { name: 'b', owner: 'o', url: 'https://x/b', install: 'pnpm add b' });
  void calls;
});

test('缓存命中：TTL 内重复请求不重拉，source=cache', async () => {
  clearRegistryCache();
  let calls = 0;
  const fetchImpl = ((async () => {
    calls++;
    return { ok: true, status: 200, json: async () => SNAP };
  }) as unknown as typeof fetch);
  const opts = makeOpts({ fetchImpl });
  const r1 = await loadRegistry(opts);
  equal(r1.source, 'remote');
  const r2 = await loadRegistry(opts);
  equal(r2.source, 'cache');
  equal(r2.fetchedAt, r1.fetchedAt);
  equal(calls, 1);
});

test('过期重拉：超过 TTL 重新拉取（时钟注入）', async () => {
  clearRegistryCache();
  let calls = 0;
  const fetchImpl = ((async () => {
    calls++;
    return { ok: true, status: 200, json: async () => SNAP };
  }) as unknown as typeof fetch);
  const opts = makeOpts({ fetchImpl });
  await loadRegistry(opts);
  t0 += TTL + 1;
  const r2 = await loadRegistry(opts);
  equal(r2.source, 'remote');
  equal(calls, 2);
});

test('失败回落：remote 失败 → 有缓存回落缓存（source=cache）', async () => {
  clearRegistryCache();
  const opts = makeOpts({ fetchImpl: fetchOk(SNAP) });
  const r1 = await loadRegistry(opts);
  equal(r1.source, 'remote');
  const opts2 = makeOpts({ fetchImpl: fetchFail(new Error('network down')) });
  const r2 = await loadRegistry(opts2);
  equal(r2.source, 'cache');
  equal(r2.entries.length, 1);
});

test('失败回落：无缓存 → snapshot（source=snapshot，无 fetchedAt）', async () => {
  clearRegistryCache();
  const opts = makeOpts({ fetchImpl: fetchFail(new Error('network down')) });
  const r = await loadRegistry(opts);
  equal(r.source, 'snapshot');
  equal(r.fetchedAt, undefined);
  equal(r.entries[0]!.name, 'snap-a');
});

test('全部失败：remote + 无缓存 + snapshot 缺失 → plugin-registry-unreachable', async () => {
  clearRegistryCache();
  const opts = makeOpts({
    fetchImpl: fetchFail(new Error('network down')),
    snapshotPath: join('/nonexistent', 'snapshot.json'),
  });
  await rejects(loadRegistry(opts), (err: unknown) => err instanceof PluginError && err.code === 'plugin-registry-unreachable');
});

test('refresh 强制：忽略新鲜缓存重拉；失败回落缓存', async () => {
  clearRegistryCache();
  let calls = 0;
  const fetchImpl = ((async () => {
    calls++;
    return { ok: true, status: 200, json: async () => SNAP };
  }) as unknown as typeof fetch);
  const opts = makeOpts({ fetchImpl });
  await loadRegistry(opts); // 填充缓存
  const r = await loadRegistry(opts, true); // 强制
  equal(r.source, 'remote');
  equal(calls, 2);

  const opts2 = makeOpts({ fetchImpl: fetchFail(new Error('down')) });
  const r2 = await loadRegistry(opts2, true);
  equal(r2.source, 'cache'); // 强制失败回落缓存
  equal(r2.entries.length, 1);
});

test('snapshot 顶层兼容 { plugins: [...] } 与数组', async () => {
  clearRegistryCache();
  const dir = mkdtempSync(join(tmpdir(), 'hull-reg-'));
  tempDirs.push(dir);
  const snapPath = join(dir, 'snapshot.json');
  writeFileSync(snapPath, JSON.stringify({ plugins: SNAP }));
  const opts = makeOpts({ fetchImpl: fetchFail(new Error('down')), snapshotPath: snapPath });
  const r = await loadRegistry(opts);
  equal(r.source, 'snapshot');
  equal(r.entries.length, 1);
});

test('HTTP 非 2xx 视为拉取失败 → 回落', async () => {
  clearRegistryCache();
  const opts = makeOpts({
    fetchImpl: ((async () => ({ ok: false, status: 500, json: async () => ({}) })) as unknown as typeof fetch),
  });
  const r = await loadRegistry(opts);
  equal(r.source, 'snapshot');
  ok(r.entries.length > 0);
});

test('registry JSON 非数组 → 拉取失败回落', async () => {
  clearRegistryCache();
  const opts = makeOpts({ fetchImpl: fetchOk({ not: 'an array' }) });
  const r = await loadRegistry(opts);
  equal(r.source, 'snapshot');
});
