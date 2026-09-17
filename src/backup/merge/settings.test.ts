import { test, after } from 'node:test';
import { equal, ok } from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { HullSettings } from '../../settings/SettingsProvider';
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
