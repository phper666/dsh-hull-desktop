import { test } from 'node:test';
import { equal } from 'node:assert/strict';

import type { RegistryEntry } from './types';
import { isWhitelisted } from './whitelist';

const entries: RegistryEntry[] = [
  { name: 'hello', owner: 'o', url: 'https://github.com/o/hello' },
  { name: 'http-only', owner: 'o', url: 'http://insecure.example/x' },
  { name: 'exact', owner: 'o', url: 'https://exact.example/x', deprecated: true },
];

test('命中：entryId（name#owner 复合键）逐字匹配且 url https → 返回条目', () => {
  equal(isWhitelisted('hello#o', entries)?.name, 'hello');
  equal(isWhitelisted('exact#o', entries)?.name, 'exact');
});

test('未命中：不存在的 entryId / 空串 → null', () => {
  equal(isWhitelisted('nope#o', entries), null);
  equal(isWhitelisted('', entries), null);
});

test('非 https url 拒绝', () => {
  equal(isWhitelisted('http-only#o', entries), null);
});

test('大小写敏感：大小写不同视为未命中', () => {
  equal(isWhitelisted('Hello#o', entries), null);
  equal(isWhitelisted('hello#O', entries), null);
});

test('复合键缺段：只有 name（无 #owner）不匹配（防旧格式误放行）', () => {
  equal(isWhitelisted('hello', entries), null);
});

test('owner 缺省条目：entryId = name# 兜底命中（owner ?? \'\' 稳定）', () => {
  const legacy: RegistryEntry[] = [{ name: 'legacy', owner: '' as string, url: 'https://legacy.example/x' }];
  equal(isWhitelisted('legacy#', legacy)?.name, 'legacy');
});

test('同 name 不同 owner：各自 entryId 命中正确条目（防装错）', () => {
  const dup: RegistryEntry[] = [
    { name: 'dup', owner: 'a', url: 'https://a.example/dup' },
    { name: 'dup', owner: 'b', url: 'https://b.example/dup' },
  ];
  equal(isWhitelisted('dup#a', dup)?.url, 'https://a.example/dup');
  equal(isWhitelisted('dup#b', dup)?.url, 'https://b.example/dup');
});

test('空列表 → null（无兜底放行）', () => {
  equal(isWhitelisted('hello#o', []), null);
});
