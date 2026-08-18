import { test, after } from 'node:test';
import { equal, deepEqual, ok, rejects } from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ChannelService } from './ChannelService';
import { SettingsProvider } from '../settings/SettingsProvider';
import type { RegistryHttpGet } from '../updater/registry';

const tempDirs: string[] = [];
after(() => {
  for (const d of tempDirs) rmSync(d, { recursive: true, force: true });
});

const METADATA = JSON.stringify({
  'dist-tags': { latest: '1.0.0' },
  versions: {
    '0.1.0-rc.6': {},
    '0.1.0-rc.7': {},
    '1.0.0': {},
    '2.0.0': {},
  },
});

const VERSION_URL_RE = /\/\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;

function makeChannel(overrides: { httpGet?: RegistryHttpGet } = {}) {
  const userDataPath = mkdtempSync(join(tmpdir(), 'hull-channel-'));
  tempDirs.push(userDataPath);
  const settings = new SettingsProvider({ userDataPath });
  const calls: string[] = [];
  const httpGet: RegistryHttpGet =
    overrides.httpGet ??
    (async (url) => {
      calls.push(url);
      if (VERSION_URL_RE.test(url)) return { ok: true, status: 200, text: '{}' }; // 版本端点 → 存在
      return { ok: true, status: 200, text: METADATA };
    });
  const service = new ChannelService({ settings, httpGet, registry: 'https://mirror.example.com' });
  return { service, settings, userDataPath, calls };
}

test('① get 默认 latest + pinnedVersion null', () => {
  const { service } = makeChannel();
  equal(service.get().channel, 'latest');
  equal(service.get().pinnedVersion, null);
});

test('② set("pinned","1.0.0") 存在性通过（200）→ 持久化', async () => {
  const { service, settings, calls } = makeChannel();
  await service.set('pinned', '1.0.0');
  equal(settings.getSettings().channel, 'pinned');
  equal(settings.getSettings().pinnedVersion, '1.0.0');
  ok(calls.some((u) => VERSION_URL_RE.test(u)), '单版本端点被调用');
});

test('③ set("pinned","abc") → version-invalid，不调网络', async () => {
  const { service, calls } = makeChannel();
  await rejects(service.set('pinned', 'abc'), (e: unknown) => (e as { code: string }).code === 'version-invalid');
  equal(calls.length, 0, '格式校验先于网络');
});

test('④ set("pinned","9.9.9") 404 → version-not-found', async () => {
  const { service, settings } = makeChannel({
    httpGet: async (url) => {
      if (url.endsWith('/9.9.9')) return { ok: false, status: 404, text: 'Not Found' };
      return { ok: true, status: 200, text: METADATA };
    },
  });
  await rejects(service.set('pinned', '9.9.9'), (e: unknown) => (e as { code: string }).code === 'version-not-found');
  equal(settings.getSettings().channel, 'latest', '未持久化');
});

test('⑤ set("latest") 清 pinnedVersion（B4）', async () => {
  const { service, settings } = makeChannel();
  await service.set('pinned', '1.0.0');
  await service.set('latest');
  equal(settings.getSettings().channel, 'latest');
  equal(settings.getSettings().pinnedVersion, null);
});

test('⑥ resolveTarget latest → dist-tags.latest', async () => {
  const { service } = makeChannel();
  equal(await service.resolveTarget(), '1.0.0');
});

test('⑦ resolveTarget pinned → 存在性校验通过返回版本', async () => {
  const { service } = makeChannel();
  await service.set('pinned', '1.0.0');
  equal(await service.resolveTarget(), '1.0.0');
});

test('⑧ resolveTarget pinned 下架（先 200 后 404）→ version-not-found', async () => {
  let versionStatus = 200;
  const { service } = makeChannel({
    httpGet: async (url) => {
      if (VERSION_URL_RE.test(url)) return { ok: versionStatus === 200, status: versionStatus, text: '{}' };
      return { ok: true, status: 200, text: METADATA };
    },
  });
  await service.set('pinned', '1.0.0'); // 锁定成功（200）
  versionStatus = 404; // 模拟下架
  await rejects(service.resolveTarget(), (e: unknown) => (e as { code: string }).code === 'version-not-found');
});

test('⑨ listVersions：semver 降序 + 非法过滤 + latest 标注', async () => {
  const { service } = makeChannel({
    httpGet: async () => ({
      ok: true,
      status: 200,
      text: JSON.stringify({
        'dist-tags': { latest: '2.0.0' },
        versions: {
          '0.1.0-rc.6': {},
          'not-a-version': {},
          '2.0.0': {},
          '0.1.0-rc.7': {},
          '1.0.0': {},
        },
      }),
    }),
  });
  const r = await service.listVersions();
  deepEqual(r.versions, ['2.0.0', '1.0.0', '0.1.0-rc.7', '0.1.0-rc.6'], 'semver 降序 + 非法过滤');
  equal(r.latest, '2.0.0');
});

test('⑨b listVersions：超 100 截断（LIST_LIMIT）', async () => {
  const versions: Record<string, unknown> = {};
  for (let i = 0; i < 105; i++) versions[`1.0.${i}`] = {};
  const { service } = makeChannel({
    httpGet: async () => ({ ok: true, status: 200, text: JSON.stringify({ versions }) }),
  });
  const r = await service.listVersions();
  equal(r.versions.length, 100, '截断前 100');
  equal(r.versions[0], '1.0.104', '降序首元素');
});

test('⑩ listVersions 网络失败 → registry-unreachable', async () => {
  const { service } = makeChannel({
    httpGet: async () => {
      throw new Error('ECONNREFUSED');
    },
  });
  await rejects(service.listVersions(), (e: unknown) => (e as { code: string }).code === 'registry-unreachable');
});

test('⑪ set channel 非法 → version-invalid', async () => {
  const { service, calls } = makeChannel();
  await rejects(service.set('stable', '1.0.0'), (e: unknown) => (e as { code: string }).code === 'version-invalid');
  equal(calls.length, 0);
});

test('🔴-B resolveTarget latest registry 不可达 → registry-unreachable（非 check-failed）', async () => {
  const { service } = makeChannel({
    httpGet: async () => {
      throw new Error('ECONNREFUSED');
    },
  });
  await rejects(service.resolveTarget(), (e: unknown) => (e as { code: string }).code === 'registry-unreachable');
});
