import { test, after } from 'node:test';
import { deepEqual, equal, ok } from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync, type Dirent } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { StorageService, type StorageFs } from './StorageService';

const tempDirs: string[] = [];
after(() => {
  for (const d of tempDirs) rmSync(d, { recursive: true, force: true });
});

/** 构造 userData + 三类条目（Cache 1000 / logs 2000 / dsh-previous 3000 字节） */
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'hull-storage-'));
  tempDirs.push(dir);
  mkdirSync(join(dir, 'Cache'), { recursive: true });
  writeFileSync(join(dir, 'Cache', 'data_0'), Buffer.alloc(1000));
  mkdirSync(join(dir, 'logs'), { recursive: true });
  writeFileSync(join(dir, 'logs', 'hull.log'), Buffer.alloc(2000));
  mkdirSync(join(dir, 'dsh-previous', 'lib'), { recursive: true });
  writeFileSync(join(dir, 'dsh-previous', 'lib', 'bin.js'), Buffer.alloc(3000));
  return dir;
}

test('info：三类条目尺寸正确 + 总计/可清理合计 + dsh-previous 不可回滚时 clearable=false', async () => {
  const userDataPath = fixture();
  const svc = new StorageService({ userDataPath, canRollback: () => false });
  const info = await svc.info();
  const byId = Object.fromEntries(info.entries.map((e) => [e.id, e]));
  equal(byId['chromium-cache'].bytes, 1000);
  equal(byId['logs'].bytes, 2000);
  equal(byId['dsh-previous'].bytes, 3000);
  equal(byId['dsh-previous'].clearable, false);
  equal(byId['dsh-previous'].note, '清理后无法回滚到上一版 dsh');
  equal(info.totalBytes, 6000);
  equal(info.clearableBytes, 3000); // chromium + logs
});

test('clear logs：删目录内文件保留目录，freedBytes 只算目标条目', async () => {
  const userDataPath = fixture();
  const svc = new StorageService({ userDataPath });
  const result = await svc.clear(['logs']);
  equal(result.freedBytes, 2000);
  deepEqual(result.skipped, []);
  ok(existsSync(join(userDataPath, 'logs')), 'logs 目录保留');
  deepEqual(readdirSync(join(userDataPath, 'logs')), []);
  equal(result.info.totalBytes, 4000);
});

test('clear dsh-previous：不可回滚 → skipped + 不删除', async () => {
  const userDataPath = fixture();
  const svc = new StorageService({ userDataPath, canRollback: () => false });
  const result = await svc.clear(['dsh-previous']);
  equal(result.freedBytes, 0);
  deepEqual(result.skipped, ['dsh-previous']);
  ok(existsSync(join(userDataPath, 'dsh-previous')));
});

test('clear dsh-previous：可回滚 → 整目录删除 + freedBytes 正确', async () => {
  const userDataPath = fixture();
  const svc = new StorageService({ userDataPath, canRollback: () => true });
  equal((await svc.info()).entries.find((e) => e.id === 'dsh-previous')?.clearable, true);
  const result = await svc.clear(['dsh-previous']);
  equal(result.freedBytes, 3000);
  ok(!existsSync(join(userDataPath, 'dsh-previous')));
});

test('clear chromium-cache：调注入的 clearChromium 并随后重新量尺寸', async () => {
  const userDataPath = fixture();
  let calls = 0;
  const svc = new StorageService({
    userDataPath,
    clearChromium: async () => {
      calls += 1;
      rmSync(join(userDataPath, 'Cache'), { recursive: true, force: true });
    },
  });
  const result = await svc.clear(['chromium-cache']);
  equal(calls, 1);
  equal(result.freedBytes, 1000);
  equal(result.info.entries.find((e) => e.id === 'chromium-cache')?.bytes, 0);
});

test('路径越界拒绝：fs 返回 ../ 逃逸条目 → 不 stat/不删除，尺寸 0', async () => {
  const statCalls: string[] = [];
  const rmCalls: string[] = [];
  const escape = [{ name: '../../evil', isDirectory: () => false, isFile: () => true } as unknown as Dirent];
  const fakeFs: StorageFs = {
    readdir: async () => escape,
    stat: async (p) => {
      statCalls.push(p);
      return { size: 9999 };
    },
    rm: async (p) => {
      rmCalls.push(p);
    },
  };
  const userDataPath = '/tmp/hull-storage-escape';
  const svc = new StorageService({ userDataPath, fsImpl: fakeFs });
  const info = await svc.info();
  equal(info.totalBytes, 0);
  deepEqual(statCalls, []);
  await svc.clear(['logs']);
  deepEqual(rmCalls, []);
});
