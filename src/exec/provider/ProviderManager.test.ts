/**
 * L3a ProviderManager 单测（B3 design §4.7 / §5）
 *
 * HULL_EXEC_PROVIDER=mock → MockProvider（仅 debug/test）；否则 → ACPProvider。
 * env 注入 seam：不污染全局 process.env。
 */
import { test } from 'node:test';
import { equal, ok } from 'node:assert/strict';

import { ProviderManager } from './ProviderManager';
import { MockProvider } from './MockProvider';
import { ACPProvider } from './ACPProvider';

test('默认（无 env）：→ ACPProvider（真实 dsh ACP）', () => {
  const pm = new ProviderManager({ env: {} });
  equal(pm.modeName, 'acp');
  ok(pm.getProvider() instanceof ACPProvider);
});

test('HULL_EXEC_PROVIDER=mock：→ MockProvider', () => {
  const pm = new ProviderManager({ env: { HULL_EXEC_PROVIDER: 'mock' } });
  equal(pm.modeName, 'mock');
  ok(pm.getProvider() instanceof MockProvider);
});

test('生产忽略 mock：非 mock env 回落 ACP', () => {
  const pm = new ProviderManager({ env: { HULL_EXEC_PROVIDER: 'anything-else' } });
  equal(pm.modeName, 'acp');
  ok(pm.getProvider() instanceof ACPProvider);
});

test('acpFactory 注入：mock 不生效时用工厂', () => {
  let called = false;
  const pm = new ProviderManager({
    env: {},
    acpFactory: () => {
      called = true;
      return new MockProvider();
    },
  });
  equal(pm.modeName, 'acp');
  equal(called, true, 'acpFactory 被调用');
  ok(pm.getProvider() instanceof MockProvider);
});

test('getProvider 返回单例（provider 生命周期）', () => {
  const pm = new ProviderManager({ env: { HULL_EXEC_PROVIDER: 'mock' } });
  equal(pm.getProvider(), pm.getProvider(), '单例');
});
