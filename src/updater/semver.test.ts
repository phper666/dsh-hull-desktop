import { test } from 'node:test';
import { equal, ok } from 'node:assert/strict';

import { compareVersions, isValidVersion } from './semver';

const cmp = (a: string, b: string) => {
  const r = compareVersions(a, b);
  return r < 0 ? '<' : r > 0 ? '>' : '=';
};

test('① patch 差异：1.0.0 < 1.0.1', () => {
  equal(cmp('1.0.0', '1.0.1'), '<');
});

test('② prerelease < 正式版：1.0.0 > 1.0.0-rc.1', () => {
  equal(cmp('1.0.0', '1.0.0-rc.1'), '>');
});

test('③ rc 序数：rc.1 < rc.2（数字段数值比较）', () => {
  equal(cmp('1.0.0-rc.1', '1.0.0-rc.2'), '<');
  equal(cmp('1.0.0-rc.10', '1.0.0-rc.9'), '>', '数值比较非字典序');
});

test('④ 数字段 < 字母段：rc.1 < rc.alpha', () => {
  equal(cmp('1.0.0-rc.1', '1.0.0-rc.alpha'), '<');
});

test('⑤ 段数少优先：rc.1 < rc.1.1', () => {
  equal(cmp('1.0.0-rc.1', '1.0.0-rc.1.1'), '<');
});

test('⑥ 主版本优先于 prerelease 标记：2.0.0-rc.6 > 1.9.9', () => {
  equal(cmp('2.0.0-rc.6', '1.9.9'), '>');
});

test('⑦ 相等：1.2.3 == 1.2.3；1.2.3-rc.1 == 1.2.3-rc.1', () => {
  equal(cmp('1.2.3', '1.2.3'), '=');
  equal(cmp('1.2.3-rc.1', '1.2.3-rc.1'), '=');
});

test('⑧ 非法版本校验：isValidVersion 边界', () => {
  ok(isValidVersion('1.2.3'));
  ok(isValidVersion('1.2.3-rc.1'));
  ok(isValidVersion('1.2.3-alpha.beta.1'));
  ok(!isValidVersion('1.2'), '缺 patch');
  ok(!isValidVersion('v1.2.3'), 'v 前缀非法');
  ok(!isValidVersion('1.2.3.4'), '四段非法');
  ok(!isValidVersion('1.2.x'), 'x 通配非法');
  ok(!isValidVersion(''), '空串非法');
});

test('⑨ 边界：0.0.0', () => {
  ok(isValidVersion('0.0.0'));
  equal(cmp('0.0.0', '0.0.0'), '=');
  equal(cmp('0.0.0', '0.0.1'), '<');
});

test('⑩ 大版本差异：10.0.0 > 2.0.0；1.10.0 > 1.9.0（多位数段）', () => {
  equal(cmp('10.0.0', '2.0.0'), '>');
  equal(cmp('1.10.0', '1.9.0'), '>');
  equal(cmp('1.10.0', '1.9.10'), '>');
});

test('⑪ compareVersions 非法输入 → throw', () => {
  ok(throwsInvalid('1.2'));
  ok(throwsInvalid('abc'));
});

function throwsInvalid(v: string): boolean {
  try {
    compareVersions(v, '1.0.0');
    return false;
  } catch {
    return true;
  }
}
