import { test, after } from 'node:test';
import { equal, ok } from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { SCHEMA_VERSION_CURRENT, type HullSettings } from '../../settings/SettingsProvider';
import { DEFAULT_NOTIF_PREFS } from '../../notifications/prefs';
import { mergeSettings, resolveNotesDir } from './settings';

const dirs: string[] = [];
after(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

function tmp(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}

function makeLocal(userDataPath: string): HullSettings {
  return {
    closeToQuit: false,
    schemaVersion: 4,
    channel: 'latest',
    pinnedVersion: null,
    autoCheckDsh: true,
    autoCheckHull: true,
    registry: 'https://registry.npmjs.org',
    theme: 'dark',
    packageManager: 'pnpm',
    notifPrefs: { ...DEFAULT_NOTIF_PREFS },
    notesDir: join(userDataPath, 'local-notes'),
  };
}

test('settings：字段级 {...local,...incoming} + 本地独有键保留 + 读路径归一化', () => {
  const userData = tmp('hull-merge-set-');
  const local = makeLocal(userData);
  const customNotes = tmp('hull-merge-set-notes-');
  const { value, conflicts, notices } = mergeSettings(
    local,
    { closeToQuit: true, theme: 'light', registry: 'https://mirror.example.com', notesDir: customNotes },
    { userDataPath: userData, exists: () => true },
  );

  equal(value.closeToQuit, true);
  equal(value.theme, 'light');
  equal(value.registry, 'https://mirror.example.com');
  equal(value.notesDir, customNotes);
  equal(value.autoCheckHull, true); // 本地独有键保留
  equal(value.packageManager, 'pnpm');
  equal(value.schemaVersion, 4);
  equal(conflicts.length, 0);
  equal(notices.length, 0);
});

test('settings：非法值逐项回退本地值（kept-local）', () => {
  const userData = tmp('hull-merge-set2-');
  const local = makeLocal(userData);
  const { value, conflicts } = mergeSettings(
    local,
    {
      theme: 'neon',
      packageManager: 'yarn',
      registry: 'ftp://bad',
      pinnedVersion: 42,
      notifPrefs: 'oops',
      closeToQuit: 'yes',
    },
    { userDataPath: userData, exists: () => true },
  );

  equal(value.theme, 'dark');
  equal(value.packageManager, 'pnpm');
  equal(value.registry, local.registry);
  equal(value.pinnedVersion, null);
  equal(value.closeToQuit, false);
  equal(value.notifPrefs.systemPushWorkflow, DEFAULT_NOTIF_PREFS.systemPushWorkflow);
  ok(conflicts.length >= 5);
  ok(conflicts.every((c) => c.kind === 'setting' && c.resolution === 'kept-local'));
});

test('settings：pinned 通道约束（非法 pinnedVersion → 回落本地）', () => {
  const userData = tmp('hull-merge-set3-');
  const local = makeLocal(userData);
  const bad = mergeSettings(local, { channel: 'pinned', pinnedVersion: 'not-a-version' }, { userDataPath: userData, exists: () => true });
  equal(bad.value.channel, 'latest');
  equal(bad.value.pinnedVersion, null);

  const good = mergeSettings(local, { channel: 'pinned', pinnedVersion: '1.2.3' }, { userDataPath: userData, exists: () => true });
  equal(good.value.channel, 'pinned');
  equal(good.value.pinnedVersion, '1.2.3');

  const clear = mergeSettings(local, { channel: 'latest', pinnedVersion: '1.2.3' }, { userDataPath: userData, exists: () => true });
  equal(clear.value.pinnedVersion, null);
});

test('settings：notesDir 不存在 → 回退默认 + notes-dir-fallback notice（不保留本地）', () => {
  const userData = tmp('hull-merge-set4-');
  const local = makeLocal(userData);
  const { value, notices, conflicts } = mergeSettings(
    local,
    { notesDir: '/definitely/not/exists/hull-notes' },
    { userDataPath: userData, exists: (p) => p !== '/definitely/not/exists/hull-notes' },
  );

  equal(value.notesDir, join(userData, 'notes'));
  equal(notices.length, 1);
  equal(notices[0].code, 'notes-dir-fallback');
  equal(conflicts[0].id, 'notesDir');
  equal(conflicts[0].resolution, 'kept-local');
});

test('settings：incoming 缺 notesDir（如包内无 settings）→ 保留本地值，不触发回退/notice', () => {
  const userData = tmp('hull-merge-set6-');
  const local = makeLocal(userData);
  // exists 恒 false：即便本地目录当前不存在，本层也不做回退（回退由 S3 postProcessNotesDir 兜底）
  const { value, notices, conflicts } = mergeSettings(local, {}, { userDataPath: userData, exists: () => false });

  equal(value.notesDir, local.notesDir);
  equal(notices.length, 0);
  equal(conflicts.length, 0);

  // 显式带 null/非法值仍走回退（与缺省区分）
  const bad = mergeSettings(local, { notesDir: null }, { userDataPath: userData, exists: () => false });
  equal(bad.value.notesDir, join(userData, 'notes'));
  equal(bad.notices.length, 1);
});

test('settings：incoming 非对象（null/字符串/数组）→ 视同缺省，全部保留本地', () => {
  const userData = tmp('hull-merge-set7-');
  const local = makeLocal(userData);
  for (const raw of [null, 'oops', [1, 2, 3]]) {
    const { value, conflicts, notices } = mergeSettings(local, raw, { userDataPath: userData, exists: () => true });
    equal(value.closeToQuit, local.closeToQuit);
    equal(value.theme, local.theme);
    equal(value.packageManager, local.packageManager);
    equal(value.channel, local.channel);
    equal(value.pinnedVersion, local.pinnedVersion);
    equal(value.registry, local.registry);
    equal(value.notifPrefs.dndFrom, local.notifPrefs.dndFrom);
    equal(value.notesDir, local.notesDir);
    equal(conflicts.length, 0);
    equal(notices.length, 0);
  }
});

test('settings：schemaVersion 归一为当前版本（本地低版本 → 当前值）', () => {
  const userData = tmp('hull-merge-set8-');
  const local = makeLocal(userData);
  local.schemaVersion = 1;
  const { value } = mergeSettings(local, { theme: 'light' }, { userDataPath: userData, exists: () => true });
  equal(value.schemaVersion, SCHEMA_VERSION_CURRENT);
});

test('settings：registry 非字符串 / 非 URL 字符串 → kept-local；http(s) 合法取包内', () => {
  const userData = tmp('hull-merge-set9-');
  const local = makeLocal(userData);
  const ctx = { userDataPath: userData, exists: () => true };
  for (const bad of [42, 'not a url']) {
    const { value, conflicts } = mergeSettings(local, { registry: bad }, ctx);
    equal(value.registry, local.registry);
    equal(conflicts.filter((c) => c.id === 'registry' && c.resolution === 'kept-local').length, 1);
  }
  equal(mergeSettings(local, { registry: 'http://mirror.local:4873' }, ctx).value.registry, 'http://mirror.local:4873');
});

test('settings：notifPrefs 合法对象走归一化（非法/缺字段回默认），数组结构回退本地', () => {
  const userData = tmp('hull-merge-set10-');
  const local = makeLocal(userData);
  const ctx = { userDataPath: userData, exists: () => true };

  const { value, conflicts } = mergeSettings(
    local,
    { notifPrefs: { systemPushWorkflow: false, dndFrom: '08:30' } },
    ctx,
  );
  equal(value.notifPrefs.systemPushWorkflow, false);
  equal(value.notifPrefs.systemPushBoardExec, DEFAULT_NOTIF_PREFS.systemPushBoardExec);
  equal(value.notifPrefs.dndFrom, '08:30');
  equal(value.notifPrefs.dndTo, DEFAULT_NOTIF_PREFS.dndTo);
  equal(conflicts.length, 0);

  const arr = mergeSettings(local, { notifPrefs: [1] }, ctx);
  equal(arr.value.notifPrefs.systemPushWorkflow, local.notifPrefs.systemPushWorkflow);
  equal(arr.conflicts.filter((c) => c.id === 'notifPrefs' && c.resolution === 'kept-local').length, 1);
});

test('settings：bool 字段非法值逐项回退本地（closeToQuit/autoCheckDsh/autoCheckHull）', () => {
  const userData = tmp('hull-merge-set11-');
  const local = makeLocal(userData);
  const { value, conflicts } = mergeSettings(
    local,
    { closeToQuit: null, autoCheckDsh: 'on', autoCheckHull: 1 },
    { userDataPath: userData, exists: () => true },
  );
  equal(value.closeToQuit, false);
  equal(value.autoCheckDsh, true);
  equal(value.autoCheckHull, true);
  for (const id of ['closeToQuit', 'autoCheckDsh', 'autoCheckHull']) {
    equal(conflicts.filter((c) => c.id === id && c.resolution === 'kept-local').length, 1);
  }
});

test('settings：channel+pinnedVersion 约束组合（缺版本回退 / 本地也无效 → latest）', () => {
  const userData = tmp('hull-merge-set12-');
  const ctx = { userDataPath: userData, exists: () => true };

  // 本地 latest：incoming pinned 无版本 → 回退本地通道
  const localLatest = makeLocal(userData);
  const noVer = mergeSettings(localLatest, { channel: 'pinned' }, ctx);
  equal(noVer.value.channel, 'latest');
  equal(noVer.value.pinnedVersion, null);
  equal(noVer.conflicts.filter((c) => c.id === 'channel' && c.resolution === 'kept-local').length, 1);

  // 本地 pinned+有效版本：incoming pinned 无版本 → 沿用本地锁定版本
  const localPinned = makeLocal(userData);
  localPinned.channel = 'pinned';
  localPinned.pinnedVersion = '1.0.0';
  const keepPinned = mergeSettings(localPinned, { channel: 'pinned' }, ctx);
  equal(keepPinned.value.channel, 'pinned');
  equal(keepPinned.value.pinnedVersion, '1.0.0');
  equal(keepPinned.conflicts.length, 0);

  // 本地 pinned+null：回退后的本地通道也无效 → 最终 latest/null
  const localBroken = makeLocal(userData);
  localBroken.channel = 'pinned';
  localBroken.pinnedVersion = null;
  const toLatest = mergeSettings(localBroken, { channel: 'pinned' }, ctx);
  equal(toLatest.value.channel, 'latest');
  equal(toLatest.value.pinnedVersion, null);
  equal(toLatest.conflicts.filter((c) => c.id === 'channel').length, 1);

  // 显式 null 清空 pinned，但 channel 仍 pinned → 约束回退本地锁定版本
  const clear = mergeSettings(localPinned, { pinnedVersion: null }, ctx);
  equal(clear.value.channel, 'pinned');
  equal(clear.value.pinnedVersion, '1.0.0');
  equal(clear.conflicts.filter((c) => c.id === 'channel' && c.resolution === 'kept-local').length, 1);
});

test('resolveNotesDir：相对路径 / 禁区 / 不存在 → 回退默认', () => {
  const userData = tmp('hull-merge-set5-');
  const dshHome = tmp('hull-merge-dsh-');
  const prev = process.env.DSH_HOME;
  process.env.DSH_HOME = dshHome;
  try {
    equal(resolveNotesDir('relative/notes', { userDataPath: userData, exists: () => true }).fallback, join(userData, 'notes'));
    const forbidden = resolveNotesDir(join(dshHome, 'notes'), { userDataPath: userData, exists: () => true });
    equal(forbidden.fallback, join(userData, 'notes'));
    ok(forbidden.notice?.message.includes('DSH_HOME'));
    const missing = resolveNotesDir(join(userData, 'gone'), { userDataPath: userData, exists: () => false });
    equal(missing.fallback, join(userData, 'notes'));
  } finally {
    if (prev === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = prev;
  }
});
