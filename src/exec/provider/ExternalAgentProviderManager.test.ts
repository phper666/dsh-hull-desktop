/**
 * ExternalAgentProviderManager 单测（U-002）
 *
 * - 默认禁用/命令不可解析 → 无 provider（registry 未注册口径）
 * - enabled + 可解析命令 → 实例化；同签名 sync 复用；命令变化 → 重建
 */
import { test } from 'node:test';
import { equal, notEqual, ok } from 'node:assert/strict';

import { ExternalAgentProviderManager } from './ExternalAgentProviderManager';
import type { ExternalAgentSettings } from '../../settings/SettingsProvider';
import { NOOP_LOGGER } from '../../shared/types';

function makeManager(initial: ExternalAgentSettings) {
  let cfg = initial;
  const manager = new ExternalAgentProviderManager({
    getExternalAgent: () => cfg,
    getPathSettings: () => ({ extraPath: [], preferExtraPath: false }),
    logger: NOOP_LOGGER,
    onPermission: () => {},
  });
  return { manager, setCfg: (next: ExternalAgentSettings) => (cfg = next) };
}

test('U-002 管理：禁用/空命令/未闭合引号 → 无实例（isReady=false）', () => {
  for (const cfg of [
    { enabled: false, name: '', command: '/opt/agent' },
    { enabled: true, name: '', command: '   ' },
    { enabled: true, name: '', command: '"/unclosed' },
  ]) {
    const { manager } = makeManager(cfg);
    manager.sync();
    equal(manager.getProvider(), undefined);
    equal(manager.isReady(), false);
  }
});

test('U-002 管理：启用 + 可解析 → 实例化；同签名复用，命令变化重建', () => {
  const { manager, setCfg } = makeManager({ enabled: true, name: 'My Agent', command: 'agent --stdio' });
  manager.sync();
  const first = manager.getProvider();
  ok(first, '启用且命令可解析 → 有实例');
  equal(manager.isReady(), true);

  manager.sync(); // 同签名 → 不重建
  equal(manager.getProvider(), first);

  setCfg({ enabled: true, name: 'My Agent', command: 'agent --stdio --verbose' });
  manager.sync();
  notEqual(manager.getProvider(), first, '命令变化 → 重建实例（下次 resolve 生效）');
  ok(manager.getProvider(), '新实例可用');
});
