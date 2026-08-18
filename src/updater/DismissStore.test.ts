import { test, after } from 'node:test';
import { equal, ok } from 'node:assert/strict';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { DismissStore } from './DismissStore';

const tempDirs: string[] = [];
after(() => {
  for (const d of tempDirs) rmSync(d, { recursive: true, force: true });
});

function makeStore(): { store: DismissStore; userDataPath: string } {
  const userDataPath = mkdtempSync(join(tmpdir(), 'hull-dismiss-'));
  tempDirs.push(userDataPath);
  return { store: new DismissStore({ userDataPath }), userDataPath };
}

/** 本地日期 YYYY-MM-DD（测试侧同实现规则） */
function localDate(d: Date): string {
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${m}-${day}`;
}

test('① dismissToday("dsh") → isDismissedToday("dsh") true', () => {
  const { store } = makeStore();
  equal(store.isDismissedToday('dsh'), false);
  store.dismissToday('dsh');
  equal(store.isDismissedToday('dsh'), true);
});

test('② 分通道隔离：dismissToday("hull") → hull true + dsh false', () => {
  const { store } = makeStore();
  store.dismissToday('hull');
  equal(store.isDismissedToday('hull'), true);
  equal(store.isDismissedToday('dsh'), false, 'dsh 不受 hull 污染');
});

test('③ 旧单键 { date } 兼容：视作 dsh 侧，hull 不受污染', () => {
  const { store, userDataPath } = makeStore();
  writeFileSync(join(userDataPath, 'dismiss.json'), JSON.stringify({ date: localDate(new Date()) }), 'utf8');
  equal(store.isDismissedToday('dsh'), true, '旧单键视作 dsh');
  equal(store.isDismissedToday('hull'), false, 'hull 不受旧数据污染');
});

test('④ 损坏 JSON → false 且不覆盖原文件', () => {
  const { store, userDataPath } = makeStore();
  writeFileSync(join(userDataPath, 'dismiss.json'), '{broken json', 'utf8');
  equal(store.isDismissedToday('dsh'), false);
  equal(store.isDismissedToday('hull'), false);
  equal(readFileSync(join(userDataPath, 'dismiss.json'), 'utf8'), '{broken json', '原文件未动');
});

test('⑤ 旧日期 → false', () => {
  const { store, userDataPath } = makeStore();
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  writeFileSync(join(userDataPath, 'dismiss.json'), JSON.stringify({ dsh: localDate(yesterday) }), 'utf8');
  equal(store.isDismissedToday('dsh'), false);
});

test('⑥ 写失败（只读目录）→ 不抛 + 当日不去重（无害降级）', () => {
  const { store, userDataPath } = makeStore();
  chmodSync(userDataPath, 0o555);
  try {
    store.dismissToday('dsh'); // 必须不抛
  } finally {
    chmodSync(userDataPath, 0o755);
  }
  equal(store.isDismissedToday('dsh'), false);
});

test('⑦ 文件缺失 → false（不建文件）', () => {
  const { store, userDataPath } = makeStore();
  equal(store.isDismissedToday('dsh'), false);
  ok(!existsSync(join(userDataPath, 'dismiss.json')));
});
