import { test, after } from 'node:test';
import { equal, ok, throws } from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { resolveSafeNotePath } from './pathGuard';

const tempDirs: string[] = [];
after(() => {
  for (const d of tempDirs) rmSync(d, { recursive: true, force: true });
});

function makeRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), 'hull-notes-guard-'));
  tempDirs.push(dir);
  mkdirSync(join(dir, 'sub'));
  writeFileSync(join(dir, 'a.md'), 'x');
  writeFileSync(join(dir, 'sub', 'b.md'), 'x');
  return dir;
}

test('合法：根内相对路径解析为绝对路径', () => {
  const root = makeRoot();
  equal(resolveSafeNotePath(root, 'a.md'), join(root, 'a.md'));
  equal(resolveSafeNotePath(root, 'sub/b.md'), join(root, 'sub', 'b.md'));
});

test('拒 ../ 穿越', () => {
  const root = makeRoot();
  throws(() => resolveSafeNotePath(root, '../x.md'), (e: unknown) => (e as { code: string }).code === 'notes-path-invalid');
  throws(() => resolveSafeNotePath(root, 'sub/../../x.md'), (e: unknown) => (e as { code: string }).code === 'notes-path-invalid');
});

test('拒绝对路径', () => {
  const root = makeRoot();
  throws(() => resolveSafeNotePath(root, '/etc/passwd'), (e: unknown) => (e as { code: string }).code === 'notes-path-invalid');
});

test('拒隐藏段（. 开头目录/文件，含 .trash）', () => {
  const root = makeRoot();
  throws(() => resolveSafeNotePath(root, '.hidden/a.md'), (e: unknown) => (e as { code: string }).code === 'notes-path-invalid');
  throws(() => resolveSafeNotePath(root, 'sub/.hidden.md'), (e: unknown) => (e as { code: string }).code === 'notes-path-invalid');
});

test('拒空串/非字符串/空段/反斜杠', () => {
  const root = makeRoot();
  throws(() => resolveSafeNotePath(root, ''), (e: unknown) => (e as { code: string }).code === 'notes-path-invalid');
  throws(() => resolveSafeNotePath(root, undefined), (e: unknown) => (e as { code: string }).code === 'notes-path-invalid');
  throws(() => resolveSafeNotePath(root, 123 as unknown as string), (e: unknown) => (e as { code: string }).code === 'notes-path-invalid');
  throws(() => resolveSafeNotePath(root, 'sub//b.md'), (e: unknown) => (e as { code: string }).code === 'notes-path-invalid');
  throws(() => resolveSafeNotePath(root, 'sub\\b.md'), (e: unknown) => (e as { code: string }).code === 'notes-path-invalid');
});

test('符号链接逃逸：link.md → 根外目标被拒（basename/包含校验）', () => {
  const root = makeRoot();
  const outsideDir = mkdtempSync(join(tmpdir(), 'hull-notes-outside-'));
  tempDirs.push(outsideDir);
  writeFileSync(join(outsideDir, 'secret.md'), 'x');
  symlinkSync(join(outsideDir, 'secret.md'), join(root, 'link.md'));
  throws(() => resolveSafeNotePath(root, 'link.md'), (e: unknown) => (e as { code: string }).code === 'notes-path-invalid');
  rmSync(join(root, 'link.md'));
});

test('符号链接目录逃逸：父目录 symlink 指向根外被拒', () => {
  const root = makeRoot();
  const outsideDir = mkdtempSync(join(tmpdir(), 'hull-notes-outside2-'));
  tempDirs.push(outsideDir);
  writeFileSync(join(outsideDir, 'c.md'), 'x');
  symlinkSync(outsideDir, join(root, 'dirlink'));
  throws(() => resolveSafeNotePath(root, 'dirlink/c.md'), (e: unknown) => (e as { code: string }).code === 'notes-path-invalid');
});

test('根内合法符号链接不误伤', () => {
  const root = makeRoot();
  symlinkSync(join(root, 'a.md'), join(root, 'alias.md'));
  ok(resolveSafeNotePath(root, 'alias.md').endsWith('alias.md'));
});
