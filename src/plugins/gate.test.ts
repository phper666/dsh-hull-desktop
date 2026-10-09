import { test } from 'node:test';
import { deepEqual, equal } from 'node:assert/strict';

import { canOperatePlugin, type GateDeps } from './gate';

function deps(over: Partial<GateDeps> = {}): GateDeps {
  return {
    isUpgradeActive: () => false,
    isHullUpdateActive: () => false,
    hasPluginInflight: () => false,
    ...over,
  };
}

test('canOperatePlugin：全空闲 → 放行', () => {
  deepEqual(canOperatePlugin(deps()), { ok: true });
});

test('canOperatePlugin：dsh 升级/安装进行中 → plugin-busy', () => {
  const r = canOperatePlugin(deps({ isUpgradeActive: () => true }));
  equal(r.ok, false);
  equal(r.code, 'plugin-busy');
});

test('canOperatePlugin：Hull 自更新进行中 → plugin-busy', () => {
  const r = canOperatePlugin(deps({ isHullUpdateActive: () => true }));
  equal(r.ok, false);
  equal(r.code, 'plugin-busy');
});

test('canOperatePlugin：插件 in-flight → plugin-busy', () => {
  const r = canOperatePlugin(deps({ hasPluginInflight: () => true }));
  equal(r.ok, false);
  equal(r.code, 'plugin-busy');
});

test('canOperatePlugin：升级 + 自更新同时 → plugin-busy（首因 dsh 升级）', () => {
  const r = canOperatePlugin(deps({ isUpgradeActive: () => true, isHullUpdateActive: () => true }));
  equal(r.ok, false);
  equal(r.code, 'plugin-busy');
});
