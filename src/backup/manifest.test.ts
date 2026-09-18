import { test } from 'node:test';
import { deepEqual, equal, ok } from 'node:assert/strict';

import { CURRENT_ITEM_VERSIONS, buildManifest, checkCompatibility, parseManifest, type Manifest } from './manifest';
import { KANBAN_SCHEMA_VERSION } from '../kanban/types';
import { SCHEMA_VERSION_CURRENT } from '../settings/SettingsProvider';

const validItems = [
  { id: 'settings' as const, path: 'settings.json', kind: 'file' as const, version: 4, size: 100, fileCount: 1 },
  { id: 'notes' as const, path: 'notes', kind: 'tree' as const, version: null, size: 200, fileCount: 2 },
];

function build(): Manifest {
  return buildManifest({
    appVersion: '0.1.9',
    platform: 'darwin',
    exportedAt: new Date('2026-09-18T10:20:30.000Z'),
    notesDirHint: '/tmp/notes',
    items: validItems,
  });
}

test('buildManifest：counts 为 items 合计 + ISO 时间', () => {
  const m = build();
  deepEqual(m.counts, { files: 3, bytes: 300 });
  equal(m.exportedAt, '2026-09-18T10:20:30.000Z');
  equal(m.manifestVersion, 1);
});

test('parseManifest：合法包 round-trip + 未知字段容忍', () => {
  const raw = { ...build(), extraTop: 1, items: [{ ...validItems[0], extraItem: 'x' }, validItems[1]] };
  const parsed = parseManifest(raw);
  ok(parsed.ok);
  if (!parsed.ok) return;
  deepEqual(parsed.value.items, validItems);
  deepEqual(parsed.value.counts, { files: 3, bytes: 300 });
});

test('parseManifest：缺必填 / 类型错 → restore-manifest-invalid', () => {
  const okRaw = build();
  for (const [name, raw] of [
    ['非对象', 'nope'],
    ['缺 manifestVersion', { ...okRaw, manifestVersion: undefined }],
    ['manifestVersion 非整数', { ...okRaw, manifestVersion: 1.5 }],
    ['manifestVersion 0', { ...okRaw, manifestVersion: 0 }],
    ['appVersion 类型错', { ...okRaw, appVersion: 9 }],
    ['platform 非法', { ...okRaw, platform: 'aix' }],
    ['exportedAt 非时间', { ...okRaw, exportedAt: 'yesterday' }],
    ['缺 notesDirHint', { ...okRaw, notesDirHint: undefined }],
    ['items 非数组', { ...okRaw, items: {} }],
    ['items 为空', { ...okRaw, items: [] }],
    ['item id 非法', { ...okRaw, items: [{ ...validItems[0], id: 'nope' }] }],
    ['item path 绝对', { ...okRaw, items: [{ ...validItems[0], path: '/etc/passwd' }] }],
    ['item version 类型错', { ...okRaw, items: [{ ...validItems[0], version: '4' }] }],
    ['item fileCount 非整数', { ...okRaw, items: [{ ...validItems[0], fileCount: 1.2 }] }],
    ['缺 counts', { ...okRaw, counts: undefined }],
  ] as const) {
    const parsed = parseManifest(raw);
    equal(parsed.ok, false, name);
    if (!parsed.ok) equal(parsed.code, 'restore-manifest-invalid', name);
  }
});

test('parseManifest：counts 与 items 合计不一致 → 拒绝', () => {
  const parsed = parseManifest({ ...build(), counts: { files: 99, bytes: 300 } });
  equal(parsed.ok, false);
  if (!parsed.ok) equal(parsed.code, 'restore-manifest-invalid');
});

test('checkCompatibility：manifestVersion 0 / 1 / 2 三态', () => {
  const m = build();
  const tooOld = checkCompatibility({ ...m, manifestVersion: 0 });
  equal(tooOld.ok, false);
  if (!tooOld.ok) equal(tooOld.code, 'restore-version-too-old');
  ok(checkCompatibility({ ...m, manifestVersion: 1 }).ok);
  const tooNew = checkCompatibility({ ...m, manifestVersion: 2 });
  equal(tooNew.ok, false);
  if (!tooNew.ok) {
    equal(tooNew.code, 'restore-version-newer');
    ok(tooNew.message.includes('0.1.9'), '提示升级版本');
  }
});

test('checkCompatibility：数据版本高拒 / 低放行 / null 放行', () => {
  const m = build();
  const base = validItems[0];
  const higher = checkCompatibility({ ...m, items: [{ ...base, version: SCHEMA_VERSION_CURRENT + 1 }] });
  equal(higher.ok, false);
  if (!higher.ok) equal(higher.code, 'restore-version-newer');
  ok(checkCompatibility({ ...m, items: [{ ...base, version: SCHEMA_VERSION_CURRENT - 1 }] }).ok);
  ok(checkCompatibility({ ...m, items: [{ ...base, version: null }] }).ok);
  const kanbanHigh = checkCompatibility({
    ...m,
    items: [{ id: 'kanban', path: 'kanban/boards.json', kind: 'file', version: KANBAN_SCHEMA_VERSION + 1, size: 1, fileCount: 1 }],
  });
  equal(kanbanHigh.ok, false);
  if (!kanbanHigh.ok) equal(kanbanHigh.code, 'restore-version-newer');
});

test('CURRENT_ITEM_VERSIONS：与各 store 当前 schema 一致', () => {
  equal(CURRENT_ITEM_VERSIONS.settings, SCHEMA_VERSION_CURRENT);
  equal(CURRENT_ITEM_VERSIONS.kanban, KANBAN_SCHEMA_VERSION);
  equal(CURRENT_ITEM_VERSIONS.workflows, 1);
  equal(CURRENT_ITEM_VERSIONS.notifs, 1);
});
