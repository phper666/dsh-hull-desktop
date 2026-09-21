import { test } from 'node:test';
import { deepEqual, equal, ok, rejects } from 'node:assert/strict';

import { NOOP_LOGGER } from '../shared/types';

import { PluginError } from './errors';
import {
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
