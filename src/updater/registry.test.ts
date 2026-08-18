import { test } from 'node:test';
import { equal, ok, rejects } from 'node:assert/strict';

import { checkLatestVersion, fetchLatestVersion, CHECK_TIMEOUT_MS, type RegistryHttpGet } from './registry';

const METADATA = (latest: string) => JSON.stringify({ 'dist-tags': { latest } });

function makeRegistry(overrides: {
  httpGet?: RegistryHttpGet;
  timeoutMs?: number;
  registry?: string;
} = {}) {
  const calls: string[] = [];
  const httpGet: RegistryHttpGet =
    overrides.httpGet ??
    (async (url) => {
      calls.push(url);
      return { ok: true, status: 200, text: METADATA('0.1.0') };
    });
  const run = (current: string | null) =>
    checkLatestVersion({
      registry: overrides.registry ?? 'https://mirror.example.com',
      currentVersion: () => current,
      httpGet,
      timeoutMs: overrides.timeoutMs,
    });
  return { calls, run };
}

test('① URL 编码：scoped 包名 @ 字面 + / 编码（@deepseek-ai%2Fdsh）', async () => {
  const { calls, run } = makeRegistry();
  await run('0.1.0-rc.6');
  equal(calls.length, 1);
  ok(calls[0].includes('@deepseek-ai%2Fdsh'), `URL 含编码包名: ${calls[0]}`);
  ok(calls[0].startsWith('https://mirror.example.com/'), 'registry 前缀');
});

test('② dist-tags.latest 解析 + hasUpdate（current rc.6 < latest 正式版）', async () => {
  const { run } = makeRegistry();
  const r = await run('0.1.0-rc.6');
  equal(r.latest, '0.1.0');
  equal(r.current, '0.1.0-rc.6');
  equal(r.hasUpdate, true, 'prerelease < 正式版 → 有更新');
});

test('③ 无更新（版本相等）', async () => {
  const { run } = makeRegistry();
  const r = await run('0.1.0');
  equal(r.hasUpdate, false);
});

test('④ 超时 CHECK_TIMEOUT_MS → check-failed（timeoutMs seam 快进）', async () => {
  const { run } = makeRegistry({
    timeoutMs: 20,
    httpGet: (_url, { signal }) =>
      new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(new Error('aborted')));
      }),
  });
  await rejects(run('0.1.0'), (e: unknown) => (e as { code: string }).code === 'check-failed');
  equal(CHECK_TIMEOUT_MS, 10_000, '常量 = 10s');
});

test('⑤ 网络错误 / 非 2xx → check-failed', async () => {
  const a = makeRegistry({
    httpGet: async () => {
      throw new Error('ECONNREFUSED');
    },
  });
  await rejects(a.run('0.1.0'), (e: unknown) => (e as { code: string }).code === 'check-failed');
  const b = makeRegistry({ httpGet: async () => ({ ok: false, status: 502, text: 'bad gateway' }) });
  await rejects(b.run('0.1.0'), (e: unknown) => (e as { code: string }).code === 'check-failed');
});

test('⑥ dist-tags 缺失 → /latest 端点 fallback', async () => {
  const calls: string[] = [];
  const { run } = makeRegistry({
    httpGet: async (url) => {
      calls.push(url);
      if (url.endsWith('/latest')) return { ok: true, status: 200, text: '0.2.0\n' };
      return { ok: true, status: 200, text: JSON.stringify({ name: '@deepseek-ai/dsh' }) }; // 无 dist-tags
    },
  });
  const r = await run('0.1.0');
  equal(r.latest, '0.2.0');
  equal(r.hasUpdate, true);
  ok(calls.some((u) => u.endsWith('/latest')), 'fallback 端点被尝试');
});

test('⑦ 当前版本不可读（null）→ check-failed', async () => {
  const { run } = makeRegistry();
  await rejects(run(null), (e: unknown) => (e as { code: string }).code === 'check-failed');
});

test('S6-⑬ registry.ts settings 优先（getRegistry 注入）', async () => {
  const calls: string[] = [];
  const r = await fetchLatestVersion({
    getRegistry: () => 'https://settings.example.com',
    httpGet: async (url) => {
      calls.push(url);
      return { ok: true, status: 200, text: JSON.stringify({ 'dist-tags': { latest: '1.0.0' } }) };
    },
  });
  equal(r, '1.0.0');
  ok(calls[0].startsWith('https://settings.example.com/'), 'settings 优先');
});

test('S6-⑭ 默认官方（registry/getRegistry/env 均无）', async () => {
  const prev = process.env.HULL_REGISTRY;
  delete process.env.HULL_REGISTRY;
  try {
    const calls: string[] = [];
    await fetchLatestVersion({
      httpGet: async (url) => {
        calls.push(url);
        return { ok: true, status: 200, text: JSON.stringify({ 'dist-tags': { latest: '1.0.0' } }) };
      },
    });
    ok(calls[0].startsWith('https://registry.npmjs.org/'), '默认官方');
  } finally {
    if (prev !== undefined) process.env.HULL_REGISTRY = prev;
  }
});

test('Y-1 checkLatestVersion 透传 getRegistry（settings 优先，B7 三消费点补齐）', async () => {
  const calls: string[] = [];
  const r = await checkLatestVersion({
    currentVersion: () => '0.1.0',
    getRegistry: () => 'https://settings.example.com',
    httpGet: async (url) => {
      calls.push(url);
      return { ok: true, status: 200, text: JSON.stringify({ 'dist-tags': { latest: '1.0.0' } }) };
    },
  });
  equal(r.latest, '1.0.0');
  ok(calls[0].startsWith('https://settings.example.com/'), 'check 路径走 settings.registry');
});
