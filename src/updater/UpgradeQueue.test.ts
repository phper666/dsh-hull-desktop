import { test } from 'node:test';
import { equal, ok } from 'node:assert/strict';

import { UpgradeQueue } from './UpgradeQueue';

test('① acquire dsh → true + inFlight dsh', () => {
  const q = new UpgradeQueue();
  equal(q.acquire('dsh'), true);
  equal(q.inFlight().channel, 'dsh');
});

test('② 重复 acquire → false（queue-busy）', () => {
  const q = new UpgradeQueue();
  equal(q.acquire('dsh'), true);
  equal(q.acquire('dsh'), false);
  equal(q.acquire('hull'), false);
});

test('③ 互斥：hull 占用时 dsh acquire → false', () => {
  const q = new UpgradeQueue();
  equal(q.acquire('hull'), true);
  equal(q.acquire('dsh'), false);
  equal(q.inFlight().channel, 'hull');
});

test('④ release 后重新 acquire → true', () => {
  const q = new UpgradeQueue();
  equal(q.acquire('dsh'), true);
  q.release('dsh');
  equal(q.inFlight().channel, null);
  equal(q.acquire('dsh'), true);
});

test('⑤ 无占用 release 无害；非占用者 release 无效', () => {
  const q = new UpgradeQueue();
  q.release('dsh'); // 无占用 → 无害
  equal(q.inFlight().channel, null);
  equal(q.acquire('dsh'), true);
  q.release('hull'); // 非占用者 → 无效（不释放 dsh）
  equal(q.inFlight().channel, 'dsh');
  equal(q.acquire('hull'), false);
});
