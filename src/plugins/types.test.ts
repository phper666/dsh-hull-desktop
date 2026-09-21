import { test } from 'node:test';
import { equal, ok } from 'node:assert/strict';

import { PluginError, type PluginErrorCode } from './errors';
import { normalizeEntries } from './registry';
import { entryId, type InstalledPlugin, type PluginPreview, type RegistryEntry } from './types';

const ALL_CODES: PluginErrorCode[] = [
  'plugin-registry-unreachable',
  'plugin-not-whitelisted',
  'plugin-install-failed',
  'plugin-update-failed',
  'plugin-uninstall-failed',
  'plugin-profile-missing',
  'plugin-busy',
  'plugin-not-installed',
  'plugin-version-too-old',
];

test('PluginError：9 个 kebab 错误码全可构造，code 透传', () => {
  for (const code of ALL_CODES) {
    const err = new PluginError(code, `msg-${code}`);
    ok(err instanceof Error);
    ok(err instanceof PluginError);
    equal(err.name, 'PluginError');
    equal(err.code, code);
    equal(err.message, `msg-${code}`);
  }
});

test('RegistryEntry 字段约束：必填 name/owner/url，可选字段原样保留，非法项丢弃', () => {
  const raw = [
    { name: 'a', owner: 'o', url: 'https://x/a' },
    { name: 'b', owner: 'o', url: 'https://x/b', category: 'tool', install: 'pnpm i b', deprecated: true, minDshVersion: '0.1.5' },
    { name: 'no-url', owner: 'o' },
    { name: '', owner: 'o', url: 'https://x/c' },
    { url: 'https://x/d' },
    42,
  ];
  const out: RegistryEntry[] = normalizeEntries(raw);
  equal(out.length, 2);
  ok(out[0] && out[0].deprecated === undefined); // 缺省 false（不序列化）
  equal(out[1]!.deprecated, true);
  equal(out[1]!.minDshVersion, '0.1.5');
  equal(out[1]!.category, 'tool');
});

test('entryId：name#owner 复合键；owner 缺省 → name#（稳定兜底）', () => {
  equal(entryId({ name: 'hello', owner: 'o' }), 'hello#o');
  equal(entryId({ name: 'legacy', owner: '' }), 'legacy#');
  equal(entryId({ name: 'no-owner' } as RegistryEntry), 'no-owner#');
  // 同 name 不同 owner → 不同 entryId（防装错）
  const a: RegistryEntry = { name: 'dup', owner: 'a', url: 'https://x/a' };
  const b: RegistryEntry = { name: 'dup', owner: 'b', url: 'https://x/b' };
  equal(entryId(a) !== entryId(b), true);
});

test('InstalledPlugin / PluginPreview 字段齐备', () => {
  const installed: InstalledPlugin = { id: 'a', name: 'A', version: '1.0.0', registryVersion: null, status: 'installed' };
  equal(installed.status, 'installed');
  const updatable: InstalledPlugin = { id: 'b', name: 'B', version: '0.9.0', registryVersion: '1.0.0', status: 'updatable' };
  equal(updatable.status, 'updatable');
  const preview: PluginPreview = {
    id: 'a',
    version: '1.0.0',
    patchSummary: null,
    sourceUrl: 'https://x/a',
    previewUnavailable: true,
  };
  equal(preview.previewUnavailable, true);
  equal(preview.patchSummary, null);
});
