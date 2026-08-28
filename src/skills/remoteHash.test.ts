/**
 * P0-1 远端哈希梯子单测（设计决策 2，docs/design/SK-1-升级检测增强-skills-upgrade-design.md）
 * ① 平台 lock 最高优先（不触缓存/网络）→ ② GitHub source：缓存命中直接取 /
 * 未命中 allowFetch=false 记 pending（同步扫描不请求）→ allowFetch=true 拉取写缓存；
 * fetch 失败降级 null（无 pending）。非 GitHub / 无 source → null 无 pending。
 */
import { test } from 'node:test';
import { deepEqual, equal } from 'node:assert/strict';

import { RemoteSigCache, signatureFromFiles, type TreeEntry } from './gitTree';
import { ladderRemoteHash } from './remoteHash';

function makeCache(): RemoteSigCache {
  return new RemoteSigCache();
}

test('① 平台 lock 命中 → 直接返回，不触缓存/网络', async () => {
  let fetched = 0;
  const r = await ladderRemoteHash({
    lockHash: 'lockhash',
    source: 'https://github.com/o/r/tree/main',
    cache: makeCache(),
    fetchTree: async () => {
      fetched++;
      return [];
    },
    allowFetch: true,
  });
  equal(r.remoteHash, 'lockhash');
  equal(r.pending, null);
  equal(fetched, 0);
});

test('无 source → null + 无 pending', async () => {
  const r = await ladderRemoteHash({ lockHash: null, source: null, cache: makeCache(), fetchTree: async () => [], allowFetch: false });
  equal(r.remoteHash, null);
  equal(r.pending, null);
});

test('非 GitHub source → null + 无 pending（不降级临时 clone）', async () => {
  const r = await ladderRemoteHash({ lockHash: null, source: 'https://gitlab.com/o/r', cache: makeCache(), fetchTree: async () => [], allowFetch: true });
  equal(r.remoteHash, null);
  equal(r.pending, null);
});

test('GitHub + 缓存命中 → 用缓存，不拉取', async () => {
  const cache = makeCache();
  cache.set('o/r#main#skills/foo', 'cachedsig', 1000);
  let fetched = 0;
  const r = await ladderRemoteHash({
    lockHash: null,
    source: 'https://github.com/o/r/tree/main/skills/foo',
    cache,
    fetchTree: async () => {
      fetched++;
      return [];
    },
    allowFetch: true,
    now: 2000,
  });
  equal(r.remoteHash, 'cachedsig');
  equal(r.pending, null);
  equal(fetched, 0);
});

test('GitHub + 缓存未命中 + allowFetch=false（同步扫描）→ null + pending', async () => {
  const r = await ladderRemoteHash({
    lockHash: null,
    source: 'https://github.com/o/r/tree/main/skills/foo',
    cache: makeCache(),
    fetchTree: async () => [],
    allowFetch: false,
  });
  equal(r.remoteHash, null);
  deepEqual(r.pending, { owner: 'o', repo: 'r', branch: 'main', subPath: 'skills/foo' });
});

test('GitHub + 未命中 + allowFetch=true → 拉取签名 + 写缓存', async () => {
  const cache = makeCache();
  const entries: TreeEntry[] = [{ path: 'skills/foo/SKILL.md', type: 'blob', sha: 's'.repeat(40) }];
  const r = await ladderRemoteHash({
    lockHash: null,
    source: 'https://github.com/o/r/tree/main/skills/foo',
    cache,
    fetchTree: async () => entries,
    allowFetch: true,
    now: 1000,
  });
  equal(r.remoteHash, signatureFromFiles([['SKILL.md', 's'.repeat(40)]]));
  equal(cache.get('o/r#main#skills/foo', 1000), r.remoteHash, '签名已写缓存');
});

test('fetch 失败 + allowFetch=true → null 无 pending（静默降级 unknown）', async () => {
  const r = await ladderRemoteHash({
    lockHash: null,
    source: 'https://github.com/o/r',
    cache: makeCache(),
    fetchTree: async () => {
      throw new Error('network');
    },
    allowFetch: true,
  });
  equal(r.remoteHash, null);
  equal(r.pending, null);
});
