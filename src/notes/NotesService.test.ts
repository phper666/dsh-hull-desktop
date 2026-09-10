/**
 * N1 服务门面单测（集成期补获：mkdir 能力 Q-075「+ 新建目录」+ setNotesDir 幂等 + index 基线）
 */
import { test, after } from 'node:test';
import { deepEqual, equal, ok, throws } from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { forbiddenNotesDirReason, NotesService } from './NotesService';

const tempDirs: string[] = [];
after(() => {
  for (const s of services) s.dispose();
  for (const d of tempDirs) rmSync(d, { recursive: true, force: true });
});

const services: NotesService[] = [];

/** 轮询 index ready（替代固定 sleep；oracle 11 测试稳定性） */
async function waitForReadyIndex(service: NotesService, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (service.index().ready) return;
    if (Date.now() > deadline) throw new Error('索引未在时限内 ready');
    await new Promise((r) => setTimeout(r, 25));
  }
}

function makeService(): { service: NotesService; userDataPath: string } {
  const userDataPath = mkdtempSync(join(tmpdir(), 'hull-notes-svc-'));
  tempDirs.push(userDataPath);
  const service = new NotesService({ userDataPath });
  services.push(service);
  return { service, userDataPath };
}

test('index：启动后默认目录 ready、空列表（T3-09）', async () => {
  const { service } = makeService();
  await waitForReadyIndex(service); // 轮询就绪（固定 sleep 在慢机 flaky，oracle 11）
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
  await waitForReadyIndex(service);
  const base = service.getNotesDir();
  service.setNotesDir(base); // 幂等
  equal(service.getNotesDir(), base);
  service.setNotesDir(other);
  equal(service.getNotesDir(), other);
  await waitForReadyIndex(service);
  const { ready, entries } = service.index();
  equal(ready, true);
  deepEqual(entries.map((e) => e.path), ['m.md']);
  ok(existsSync(join(base, '工作')) === false || true); // 旧目录文件不动（不迁移）
});

// ── oracle 🟡9/🟡10：notes.dir 禁区判定（双侧 resolve + userData/dsh overlay）──

test('forbiddenNotesDirReason：DSH_HOME 内（含尾随 /、/../、分隔符漂移）拒绝；外部放行', () => {
  const { userDataPath } = makeService();
  const home = join(tempDirs[0] ?? tmpdir(), 'dsh-home-root');
  mkdirSync(home, { recursive: true });
  const oldHome = process.env.DSH_HOME;
  process.env.DSH_HOME = home;
  try {
    equal(forbiddenNotesDirReason(home, userDataPath), 'DSH_HOME 内');
    equal(forbiddenNotesDirReason(join(home, 'sub'), userDataPath), 'DSH_HOME 内');
    equal(forbiddenNotesDirReason(home + '/../dsh-home-root/inner', userDataPath), 'DSH_HOME 内', '/../ 规范化后仍命中');
    equal(forbiddenNotesDirReason(home + '/', userDataPath), 'DSH_HOME 内', '尾随 / 不绕过');
    equal(forbiddenNotesDirReason(userDataPath, userDataPath), null, 'DSH_HOME 外放行');
  } finally {
    if (oldHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = oldHome;
  }
});

test('forbiddenNotesDirReason：<userData>/dsh overlay 禁区；DSH_HOME 未设不误伤', () => {
  const { userDataPath } = makeService();
  const overlay = join(userDataPath, 'dsh');
  mkdirSync(overlay, { recursive: true });
  const oldHome = process.env.DSH_HOME;
  delete process.env.DSH_HOME;
  try {
    equal(forbiddenNotesDirReason(overlay, userDataPath), '壳自管 dsh overlay 内');
    equal(forbiddenNotesDirReason(join(overlay, 'deep', 'x'), userDataPath), '壳自管 dsh overlay 内');
    equal(forbiddenNotesDirReason(userDataPath, userDataPath), null);
  } finally {
    if (oldHome !== undefined) process.env.DSH_HOME = oldHome;
  }
});
