import { test, after } from 'node:test';
import { deepEqual, equal, ok } from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { BACKUP_SCOPE, EXCLUDE_NAME_PATTERNS, enumerateFiles, isInsideUserData, resolveItemPaths } from './scope';

const tempDirs: string[] = [];
after(() => {
  for (const d of tempDirs) rmSync(d, { recursive: true, force: true });
});

function mkTemp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

const item = (id: string) => {
  const found = BACKUP_SCOPE.find((i) => i.id === id);
  ok(found, `scope item ${id}`);
  return found!;
};

// ─────────────────────────── isInsideUserData ───────────────────────────

test('isInsideUserData：自身 / 子目录 / 外部', () => {
  const userData = mkTemp('hull-bk-ud-');
  const outside = mkTemp('hull-bk-out-');
  equal(isInsideUserData(userData, userData), true);
  equal(isInsideUserData(join(userData, 'a', 'b'), userData), true); // 尚未创建也能判定
  mkdirSync(join(userData, 'sub'));
  equal(isInsideUserData(join(userData, 'sub'), userData), true);
  equal(isInsideUserData(outside, userData), false);
  equal(isInsideUserData(join(outside, 'x'), userData), false);
});

test('isInsideUserData：realpath 符号链接两个方向', () => {
  const userData = mkTemp('hull-bk-ud-');
  const outside = mkTemp('hull-bk-out-');
  mkdirSync(join(userData, 'sub'));
  // 链在 userData 内、指向外部 → 不算 userData 内（防自包含绕过）
  symlinkSync(outside, join(userData, 'link-out'), 'dir');
  equal(isInsideUserData(join(userData, 'link-out'), userData), false);
  // 链在外部、指向 userData 内 → 算 userData 内
  symlinkSync(join(userData, 'sub'), join(outside, 'link-in'), 'dir');
  equal(isInsideUserData(join(outside, 'link-in'), userData), true);
});

// ─────────────────────────── resolveItemPaths ───────────────────────────

test('resolveItemPaths：默认 notes 在 userData 内', () => {
  const userData = mkTemp('hull-bk-ud-');
  const resolved = resolveItemPaths(item('notes'), { userDataPath: userData, notesDir: join(userData, 'notes') });
  deepEqual(resolved, { absSource: join(userData, 'notes'), packRel: 'notes' });
});

test('resolveItemPaths：notes 外置 → null；notes-trash 固定在 userData/notes', () => {
  const userData = mkTemp('hull-bk-ud-');
  const external = mkTemp('hull-bk-notes-');
  equal(resolveItemPaths(item('notes'), { userDataPath: userData, notesDir: external }), null);
  // notesDir == userData 属病态配置，同样不打包
  equal(resolveItemPaths(item('notes'), { userDataPath: userData, notesDir: userData }), null);
  deepEqual(resolveItemPaths(item('notes-trash'), { userDataPath: userData, notesDir: external }), {
    absSource: join(userData, 'notes'),
    packRel: 'notes',
  });
});

test('resolveItemPaths：settings / skills / notifs 包内路径', () => {
  const userData = mkTemp('hull-bk-ud-');
  const ctx = { userDataPath: userData, notesDir: join(userData, 'notes') };
  deepEqual(resolveItemPaths(item('settings'), ctx), { absSource: join(userData, 'settings.json'), packRel: 'settings.json' });
  deepEqual(resolveItemPaths(item('skills'), ctx), { absSource: userData, packRel: '.' });
  deepEqual(resolveItemPaths(item('notifs'), ctx), { absSource: userData, packRel: '.' });
});

// ─────────────────────────── enumerateFiles ───────────────────────────

test('EXCLUDE_NAME_PATTERNS：瞬态过滤', () => {
  // 注意 skills/staging 由 skills 项正列举挡住，pattern 只覆盖 `*-staging/` 形态
  const hit = ['a.tmp', 'x.tmp-123', 'b.bak-1', 'c.corrupt-22', 'a-staging/b.md', 'skills-remote-staging/x'];
  const miss = ['a.md', 'a.tmp2', 'bak-1.md', 'staging.md', 'skills/staging/x'];
  for (const rel of hit) equal(EXCLUDE_NAME_PATTERNS.some((p) => p.test(rel)), true, rel);
  for (const rel of miss) equal(EXCLUDE_NAME_PATTERNS.some((p) => p.test(rel)), false, rel);
});

test('enumerateFiles：notes 仅 .md（.DS_Store/图片/.txt 不入包）+ 排除 .trash 与 trash.json + 瞬态过滤', () => {
  const notesDir = mkTemp('hull-bk-notes-');
  mkdirSync(join(notesDir, 'sub'));
  mkdirSync(join(notesDir, '.trash'));
  mkdirSync(join(notesDir, 'assets'));
  writeFileSync(join(notesDir, 'b.md'), 'b');
  writeFileSync(join(notesDir, 'a.md'), 'a');
  writeFileSync(join(notesDir, 'sub', 'c.md'), 'c');
  writeFileSync(join(notesDir, 'assets', 'img.png'), 'x');
  writeFileSync(join(notesDir, 'assets', 'deep.md'), 'd');
  writeFileSync(join(notesDir, '.DS_Store'), 'x');
  writeFileSync(join(notesDir, 'readme.txt'), 'x');
  writeFileSync(join(notesDir, 'trash.json'), '{}');
  writeFileSync(join(notesDir, '.trash', 'tr_1.md'), 'x');
  writeFileSync(join(notesDir, 'junk.bak-1'), 'x');
  writeFileSync(join(notesDir, 'junk.tmp'), 'x');
  // 非 md 过滤不能剪目录：assets/ 内 .md 仍收
  deepEqual(enumerateFiles(notesDir, item('notes')), ['a.md', 'assets/deep.md', 'b.md', 'sub/c.md']);
});

test('enumerateFiles：notes-trash 只收 trash.json + .trash/**', () => {
  const notesDir = mkTemp('hull-bk-notes-');
  mkdirSync(join(notesDir, 'sub'));
  mkdirSync(join(notesDir, '.trash'));
  writeFileSync(join(notesDir, 'a.md'), 'a');
  writeFileSync(join(notesDir, 'trash.json'), '{}');
  writeFileSync(join(notesDir, '.trash', 'tr_1.md'), 'x');
  writeFileSync(join(notesDir, 'sub', 'c.md'), 'c');
  deepEqual(enumerateFiles(notesDir, item('notes-trash')), ['.trash/tr_1.md', 'trash.json']);
});

test('enumerateFiles：skills 正列举（两个索引 + disabled/ + trash/）不吃缓存/安装体/staging', () => {
  // parts 项源根 = userData 根，part.rel 为 userData 相对路径
  const userData = mkTemp('hull-bk-ud-');
  const skillsDir = join(userData, 'skills');
  mkdirSync(join(skillsDir, 'trash', 'tr_1'), { recursive: true });
  mkdirSync(join(skillsDir, 'disabled', 'd_1'), { recursive: true });
  mkdirSync(join(skillsDir, 'staging'), { recursive: true });
  mkdirSync(join(skillsDir, 'installed-skill'), { recursive: true });
  writeFileSync(join(skillsDir, 'disabled.json'), '{}');
  writeFileSync(join(skillsDir, 'trash.json'), '{}');
  writeFileSync(join(skillsDir, 'trash', 'tr_1', 'SKILL.md'), 'x');
  writeFileSync(join(skillsDir, 'disabled', 'd_1', 'SKILL.md'), 'x');
  writeFileSync(join(skillsDir, 'hash-cache.json'), '{}');
  writeFileSync(join(skillsDir, 'remote-sig-cache.json'), '{}');
  writeFileSync(join(skillsDir, 'staging', 'x'), 'x');
  writeFileSync(join(skillsDir, 'installed-skill', 'SKILL.md'), 'x');
  deepEqual(enumerateFiles(userData, item('skills')), [
    'skills/disabled.json',
    'skills/disabled/d_1/SKILL.md',
    'skills/trash.json',
    'skills/trash/tr_1/SKILL.md',
  ]);
});

test('enumerateFiles：notifs = notifications.json + 根 dismiss.json；缺源不报错', () => {
  const userData = mkTemp('hull-bk-ud-');
  mkdirSync(join(userData, 'notifications'));
  writeFileSync(join(userData, 'notifications', 'notifications.json'), '{}');
  writeFileSync(join(userData, 'dismiss.json'), '{}');
  deepEqual(enumerateFiles(userData, item('notifs')), ['dismiss.json', 'notifications/notifications.json']);
  deepEqual(enumerateFiles(join(userData, 'nope'), item('notifs')), []);
});

test('enumerateFiles：file 项存在才枚举', () => {
  const userData = mkTemp('hull-bk-ud-');
  writeFileSync(join(userData, 'settings.json'), '{}');
  deepEqual(enumerateFiles(join(userData, 'settings.json'), item('settings')), ['settings.json']);
  deepEqual(enumerateFiles(join(userData, 'missing.json'), item('settings')), []);
});

test('enumerateFiles：notesDir 自身是符号链接 → 跟到 realpath 内容（不漏备）', () => {
  const userData = mkTemp('hull-bk-ud-');
  mkdirSync(join(userData, 'real-notes'));
  writeFileSync(join(userData, 'real-notes', 'a.md'), 'a');
  symlinkSync(join(userData, 'real-notes'), join(userData, 'notes'), 'dir');
  const ctx = { userDataPath: userData, notesDir: join(userData, 'notes') };
  const resolved = resolveItemPaths(item('notes'), ctx);
  ok(resolved);
  deepEqual(enumerateFiles(resolved!.absSource, item('notes')), ['a.md']);
});
