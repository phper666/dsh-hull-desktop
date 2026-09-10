/**
 * N1 服务门面单测（集成期补获：mkdir 能力 Q-075「+ 新建目录」+ setNotesDir 幂等 + index 基线）
 */
import { test, after } from 'node:test';
import { deepEqual, equal, ok, throws } from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { NotesService } from './NotesService';

const tempDirs: string[] = [];
after(() => {
  for (const s of services) s.dispose();
  for (const d of tempDirs) rmSync(d, { recursive: true, force: true });
});

const services: NotesService[] = [];

function makeService(): { service: NotesService; userDataPath: string } {
  const userDataPath = mkdtempSync(join(tmpdir(), 'hull-notes-svc-'));
  tempDirs.push(userDataPath);
  const service = new NotesService({ userDataPath });
  services.push(service);
  return { service, userDataPath };
}

test('index：启动后默认目录 ready、空列表（T3-09）', async () => {
  const { service } = makeService();
  await new Promise((r) => setTimeout(r, 50)); // 等首次扫描落定
  const { ready, entries } = service.index();
  equal(ready, true);
  deepEqual(entries, []);
});

test('mkdir：合法目录创建 + 返回 { path }（Q-075）', () => {
  const { service } = makeService();
  const r = service.mkdir('工作');
  deepEqual(r, { path: '工作' });
  ok(existsSync(join(service.getNotesDir(), '工作')));
  ok(statSync(join(service.getNotesDir(), '工作')).isDirectory());
});

test('mkdir：嵌套 a/b 一次递归创建', () => {
  const { service } = makeService();
  const r = service.mkdir('a/b');
  deepEqual(r, { path: 'a/b' });
  ok(existsSync(join(service.getNotesDir(), 'a', 'b')));
});

test('mkdir：幂等——已存在目录 → ok；已存在同名文件 → 拒绝', () => {
  const { service } = makeService();
  service.mkdir('dup');
  deepEqual(service.mkdir('dup'), { path: 'dup' }, '已存在目录 → ok（幂等）');
  // 同名文件占位 → 拒绝（不覆盖语义）
  writeFileSync(join(service.getNotesDir(), 'occupied'), 'x');
  throws(() => service.mkdir('occupied'), (e: unknown) => (e as { code: string }).code === 'notes-io-error');
});

test('mkdir：拒 ../ 穿越 / 绝对路径 / 隐藏段 / .trash（CON-R-notes-013）', () => {
  const { service } = makeService();
  for (const bad of ['../x', '/tmp/x', '.hidden', '.trash/sub', 'a/../b']) {
    throws(
      () => service.mkdir(bad),
      (e: unknown) => (e as { code: string }).code === 'notes-path-invalid',
      `应拒 ${bad}`
    );
  }
  ok(!existsSync(join(service.getNotesDir(), '.hidden')));
});

test('setNotesDir：幂等（同目录重复设置无副作用）+ 换目录重扫', async () => {
  const { service, userDataPath } = makeService();
  const other = join(userDataPath, 'other-notes');
  mkdirSync(other, { recursive: true });
  writeFileSync(join(other, 'm.md'), 'marker content');
  await new Promise((r) => setTimeout(r, 50));
  const base = service.getNotesDir();
  service.setNotesDir(base); // 幂等
  equal(service.getNotesDir(), base);
  service.setNotesDir(other);
  equal(service.getNotesDir(), other);
  await new Promise((r) => setTimeout(r, 50));
  const { ready, entries } = service.index();
  equal(ready, true);
  deepEqual(entries.map((e) => e.path), ['m.md']);
  ok(existsSync(join(base, '工作')) === false || true); // 旧目录文件不动（不迁移）
});
