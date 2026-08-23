/**
 * S1 来源解析单测（CON-R-skills-005，设计 D5，Q-034 变更）
 * metadata.source 一级解析；无 → null「来源未知」。
 * 已移除 lock 二级降级（skills-lock.json 不再读取——升级检测只依赖标准位置 .arkcli 平台 lock + frontmatter source）。
 */
import { test } from 'node:test';
import { equal } from 'node:assert/strict';

import { resolveSource } from './sourceResolver';

test('metadata.source https 直接采用', () => {
  equal(resolveSource('https://github.com/o/r'), 'https://github.com/o/r');
  equal(resolveSource('https://skills.sh/x/y'), 'https://skills.sh/x/y');
});

test('非 https（http/javascript:/file:）→ 视为无效降级 null（Q-038）', () => {
  equal(resolveSource('http://github.com/o/r'), null);
  equal(resolveSource('javascript:alert(1)'), null);
  equal(resolveSource('file:///etc/passwd'), null);
});

test('空/undefined → null「来源未知」', () => {
  equal(resolveSource(null), null);
  equal(resolveSource(undefined), null);
  equal(resolveSource(''), null);
});
