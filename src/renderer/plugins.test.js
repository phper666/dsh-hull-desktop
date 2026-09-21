/**
 * P4 插件市场纯函数单测（node:test；docs/api/feishu-plugin-market-api-contract.md §错误码 + §页面交互规范口径）。
 * 覆盖：错误码→中文映射（9 kebab + fallback）、搜索过滤（前端）、状态徽标映射。
 */
const { test } = require('node:test');
const assert = require('node:assert');
const { ERR_TEXT, pluginErrText, filterEntries, entryIdOf, STATUS_BADGE } = require('./plugins.js');

// ── 错误码 → 中文提示映射 ──
test('pluginErrText：9 个 kebab 错误码均有中文映射', () => {
  const codes = [
    'plugin-registry-unreachable', 'plugin-not-whitelisted', 'plugin-install-failed',
    'plugin-update-failed', 'plugin-uninstall-failed', 'plugin-profile-missing',
    'plugin-busy', 'plugin-not-installed', 'plugin-version-too-old',
  ];
  for (const c of codes) {
    assert.ok(ERR_TEXT[c], `缺映射: ${c}`);
    assert.match(ERR_TEXT[c], /[\u4e00-\u9fff]/, `${c} 应为中文`);
    assert.notStrictEqual(pluginErrText(c, null), c, `${c} 不应裸露 kebab 码`);
  }
});

test('pluginErrText：未识别 code 回落 message，无 message 回落兜底', () => {
  assert.strictEqual(pluginErrText('unknown-code', '后端透传摘要'), '后端透传摘要');
  assert.strictEqual(pluginErrText('unknown-code', ''), '操作失败。');
});

// ── 前端搜索过滤 ──
test('filterEntries：空词返回全量', () => {
  const e = [{ name: 'a' }, { name: 'b' }];
  assert.strictEqual(filterEntries(e, '').length, 2);
  assert.strictEqual(filterEntries(e, '   ').length, 2);
});

test('filterEntries：名称/描述/分类/owner 命中（大小写不敏感）', () => {
  const e = [
    { name: 'ghost', description: '', category: '', owner: '' },
    { name: 'x', description: 'marketplace io', category: 'tools', owner: 'acme' },
    { name: 'y', description: '', category: 'UI', owner: '' },
  ];
  assert.deepEqual(filterEntries(e, 'GHOST').map((x) => x.name), ['ghost']);
  assert.deepEqual(filterEntries(e, 'marketplace').map((x) => x.name), ['x']);
  assert.deepEqual(filterEntries(e, 'tools').map((x) => x.name), ['x']);
  assert.deepEqual(filterEntries(e, 'ACME').map((x) => x.name), ['x']);
  assert.deepEqual(filterEntries(e, 'UI').map((x) => x.name), ['y']);
});

test('filterEntries：无命中返回空数组', () => {
  assert.deepEqual(filterEntries([{ name: 'a' }], 'zzz'), []);
});

// ── entryId 复合键（防同 name 不同 owner 装错；owner 缺省 '' 兜底）──
test('entryIdOf：name#owner 复合键 + owner 缺省 name# 兜底', () => {
  assert.strictEqual(entryIdOf({ name: 'a', owner: 'o' }), 'a#o');
  assert.strictEqual(entryIdOf({ name: 'a' }), 'a#');
  assert.strictEqual(entryIdOf({ name: 'a', owner: '' }), 'a#');
  const dupA = entryIdOf({ name: 'dup', owner: 'a' });
  const dupB = entryIdOf({ name: 'dup', owner: 'b' });
  assert.notStrictEqual(dupA, dupB, '同 name 不同 owner 的 entryId 必须不同');
});

// ── 状态徽标映射 ──
test('STATUS_BADGE：installed/updatable/deprecated 三态映射', () => {
  assert.strictEqual(STATUS_BADGE.installed.cls, 'latest');
  assert.strictEqual(STATUS_BADGE.installed.text, '已安装');
  assert.strictEqual(STATUS_BADGE.updatable.cls, 'upgradable');
  assert.strictEqual(STATUS_BADGE.updatable.text, '可更新');
  assert.strictEqual(STATUS_BADGE.deprecated.cls, 'notinstalled');
  assert.strictEqual(STATUS_BADGE.deprecated.text, '已弃用');
});