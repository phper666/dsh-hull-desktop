/**
 * S1 来源三级降级解析单测（CON-R-skills-005，设计 D5）
 * metadata.source → lock source+skillPath 构建 GitHub tree URL → null「来源未知」
 */
import { test } from 'node:test';
import { deepEqual, equal } from 'node:assert/strict';

import { parseSkillsLock, resolveSource } from './sourceResolver';

test('一级：metadata.source https 直接采用（T8）', () => {
  equal(resolveSource('https://github.com/o/r', null), 'https://github.com/o/r');
});

test('一级非 https（http/javascript:/file:）→ 视为无效降级（Q-038）', () => {
  equal(resolveSource('http://github.com/o/r', null), null);
  equal(resolveSource('javascript:alert(1)', null), null);
  equal(resolveSource('file:///etc/passwd', null), null);
});

test('二级：lock source+skillPath 构建 GitHub tree URL（T9）', () => {
  const url = resolveSource(null, { source: 'https://github.com/owner/repo', skillPath: 'skills/x' });
  equal(url, 'https://github.com/owner/repo/tree/main/skills/x');
});

test('二级：.git 后缀剥离 + lock.branch 采用', () => {
  const url = resolveSource(null, { source: 'https://github.com/owner/repo.git', skillPath: 'skills/y', branch: 'dev' });
  equal(url, 'https://github.com/owner/repo/tree/dev/skills/y');
});

test('二级缺 skillPath 或 source 非法 → null', () => {
  equal(resolveSource(null, { source: 'https://github.com/o/r' }), null);
  equal(resolveSource(null, { skillPath: 'skills/x' }), null);
  equal(resolveSource(null, { source: 'ftp://x/y', skillPath: 'p' }), null);
});

test('三级均无 → null「来源未知」（T10）', () => {
  equal(resolveSource(null, null), null);
  equal(resolveSource(undefined, {}), null);
});

test('一级优先于二级（CON-R-skills-005 优先级）', () => {
  const url = resolveSource('https://github.com/a/b', { source: 'https://github.com/c/d', skillPath: 'p' });
  equal(url, 'https://github.com/a/b');
});

test('parseSkillsLock：数组形态与 map 形态都归一为 name→entry；坏 JSON → 空 map', () => {
  const asArray = parseSkillsLock(JSON.stringify([{ name: 'x', source: 'https://github.com/o/r', skillPath: 'skills/x', hash: 'aa' }]));
  deepEqual(asArray['x'], { source: 'https://github.com/o/r', skillPath: 'skills/x', hash: 'aa' });

  const asMap = parseSkillsLock(JSON.stringify({ y: { source: 'https://github.com/o/r', skillPath: 'skills/y' } }));
  deepEqual(asMap['y'], { source: 'https://github.com/o/r', skillPath: 'skills/y' });

  deepEqual(parseSkillsLock('not json'), {});
  deepEqual(parseSkillsLock('[]'), {});
});
