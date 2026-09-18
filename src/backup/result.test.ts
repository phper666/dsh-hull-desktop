import { test, after } from 'node:test';
import { deepEqual, equal, ok, throws } from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  clearPending,
  readPending,
  readResult,
  restoreDirPath,
  writePending,
  writeResult,
  type PendingFile,
  type RestoreResult,
} from './result';

const dirs: string[] = [];
after(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

function tmp(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}

function makePending(): PendingFile {
  return {
    version: 1,
    mode: 'merge',
    phase: 'forward',
    step: 'requested',
    sourceDir: '/Users/liyuzhao/Backups/Hull备份-20260917-1305',
    items: ['settings', 'kanban', 'workflows', 'notes', 'notes-trash', 'skills', 'notifs'],
    createdAt: '2026-09-17T13:06:01.000Z',
    failAt: null,
  };
}

function makeResult(): RestoreResult {
  return {
    version: 1,
    mode: 'merge',
    status: 'success',
    finishedAt: '2026-09-17T13:10:44.000Z',
    bakDir: '/tmp/userData/.restore/backup',
    notices: [{ code: 'notes-dir-fallback', message: '原笔记目录不存在，已回退默认目录' }],
    merge: {
      classes: { note: { added: 3, updated: 0, skipped: 1 } },
      conflicts: [{ kind: 'note', path: 'a.md', resolution: 'renamed', detail: 'pkg → a (恢复冲突).md' }],
      notices: [],
    },
    error: null,
  };
}

test('pending：写读往返（字段严格）+ 原子写无残留 tmp', () => {
  const userData = tmp('hull-result-p-');
  const pending = makePending();
  writePending(userData, pending);

  equal(readPending(userData) !== null, true);
  deepEqual(readPending(userData), pending);
  deepEqual(readdirSync(restoreDirPath(userData)), ['pending.json']);
});

test('pending：不存在 / JSON 损坏 / 结构非法 / 高 version → null（不 throw）', () => {
  const userData = tmp('hull-result-p2-');
  equal(readPending(userData), null, '不存在');

  const file = join(restoreDirPath(userData), 'pending.json');
  mkdirSync(restoreDirPath(userData), { recursive: true });
  writeFileSync(file, '{ 不是 JSON');
  equal(readPending(userData), null, '损坏');

  writeFileSync(file, JSON.stringify({ ...makePending(), version: 2 }));
  equal(readPending(userData), null, 'version 高');

  writeFileSync(file, JSON.stringify({ ...makePending(), step: 'nope' }));
  equal(readPending(userData), null, 'step 非法');

  writeFileSync(file, JSON.stringify({ ...makePending(), sourceDir: '' }));
  equal(readPending(userData), null, 'sourceDir 空');

  writeFileSync(file, JSON.stringify({ ...makePending(), items: 'x' }));
  equal(readPending(userData), null, 'items 非数组');
});

test('pending：clearPending 幂等（缺失不抛；存在则删）', () => {
  const userData = tmp('hull-result-p3-');
  clearPending(userData); // 缺失 → 不抛
  ok(!existsSync(join(restoreDirPath(userData), 'pending.json')));

  writePending(userData, makePending());
  clearPending(userData);
  equal(readPending(userData), null);
});

test('result：写读往返（merge 报告 / notice / error=null）', () => {
  const userData = tmp('hull-result-r-');
  const result = makeResult();
  writeResult(userData, result);

  deepEqual(readResult(userData), result);
  deepEqual(readdirSync(restoreDirPath(userData)), ['result.json']);
});

test('result：不存在 / 损坏 / status 非法 → null；failed 态 error 保留', () => {
  const userData = tmp('hull-result-r2-');
  equal(readResult(userData), null);

  const file = join(restoreDirPath(userData), 'result.json');
  mkdirSync(restoreDirPath(userData), { recursive: true });
  writeFileSync(file, 'not json at all');
  equal(readResult(userData), null);

  writeFileSync(file, JSON.stringify({ ...makeResult(), status: 'wat' }));
  equal(readResult(userData), null);

  const failed: RestoreResult = {
    ...makeResult(),
    status: 'failed',
    merge: null,
    error: { code: 'restore-manual-required', message: '现场不完整，需人工处理' },
  };
  writeResult(userData, failed);
  deepEqual(readResult(userData), failed);
});

test('写盘失败上抛（不静默）', () => {
  const userData = tmp('hull-result-ro-');
  mkdirSync(restoreDirPath(userData), { recursive: true });
  chmodSync(restoreDirPath(userData), 0o500);
  try {
    throws(() => writePending(userData, makePending()));
  } finally {
    chmodSync(restoreDirPath(userData), 0o700);
  }
});
