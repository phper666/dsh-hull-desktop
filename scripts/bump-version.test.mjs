import { test } from 'node:test';
import { equal, throws } from 'node:assert/strict';

import { bumpVersion, isValidBump } from './bump-version.mjs';

test('① patch：0.1.0 → 0.1.1', () => {
  equal(bumpVersion('0.1.0', 'patch'), '0.1.1');
});

test('② patch 跨：0.1.9 → 0.1.10', () => {
  equal(bumpVersion('0.1.9', 'patch'), '0.1.10');
});

test('③ minor：0.1.0 → 0.2.0（patch 归零）', () => {
  equal(bumpVersion('0.1.0', 'minor'), '0.2.0');
});

test('④ minor 跨：0.1.9 → 0.2.0（patch 归零）', () => {
  equal(bumpVersion('0.1.9', 'minor'), '0.2.0');
});

test('⑤ major：0.2.5 → 1.0.0（minor+patch 归零）', () => {
  equal(bumpVersion('0.2.5', 'major'), '1.0.0');
});

test('⑥ major 跨：1.9.9 → 2.0.0', () => {
  equal(bumpVersion('1.9.9', 'major'), '2.0.0');
});

test('⑦ 非法版本抛错', () => {
  throws(() => bumpVersion('abc', 'patch'), /version/);
  throws(() => bumpVersion('1.2', 'patch'), /version/);
  throws(() => bumpVersion('', 'patch'), /version/);
});

test('⑧ 非法档位抛错', () => {
  throws(() => bumpVersion('1.0.0', 'pre'), /bump/);
  throws(() => bumpVersion('1.0.0', 'x'), /bump/);
});

test('⑨ isValidBump 三档合法', () => {
  equal(isValidBump('patch'), true);
  equal(isValidBump('minor'), true);
  equal(isValidBump('major'), true);
});

test('⑩ isValidBump 非法档位', () => {
  equal(isValidBump('pre'), false);
  equal(isValidBump(''), false);
  equal(isValidBump('Patch'), false); // 大小写敏感
});
