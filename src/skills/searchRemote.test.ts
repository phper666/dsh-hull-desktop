/**
 * S1 远程搜索单测（CON-R-skills-010 / Q-036 / T-2，设计 D6）
 * npx skills find 封装：注入 runner mock、30s 超时、失败降级 remote-search-failed
 */
import { test } from 'node:test';
import { deepEqual, equal, rejects } from 'node:assert/strict';

import { RemoteSearchFailedError, SkillValidationError } from './errors';
import { searchRemote } from './searchRemote';

test('空 query → validation-error 不 spawn', async () => {
  let spawned = false;
  await rejects(
    () => searchRemote('  ', { runner: async () => { spawned = true; return { code: 0, stdout: '' }; } }),
    (err: Error) => err instanceof SkillValidationError
  );
  equal(spawned, false);
});

test('JSON 输出映射：installed 恒 false，缺字段置 null（O-1 防御）', async () => {
  const entries = await searchRemote('commit', {
    runner: async () => ({
      code: 0,
      stdout: JSON.stringify([
        { name: 'a', description: 'desc a', source: 'https://github.com/o/a', installs: 12 },
        { name: 'b' },
      ]),
    }),
  });
  equal(entries.length, 2);
  deepEqual(entries[0], { name: 'a', description: 'desc a', source: 'https://github.com/o/a', installs: 12, installed: false });
  deepEqual(entries[1], { name: 'b', description: null, source: null, installs: null, installed: false });
});

test('非零退出码 → remote-search-failed', async () => {
  await rejects(
    () => searchRemote('q', { runner: async () => ({ code: 1, stdout: '' }) }),
    (err: Error) => err instanceof RemoteSearchFailedError && err.code === 'remote-search-failed'
  );
});

test('输出不可解析（非 JSON）→ remote-search-failed', async () => {
  await rejects(
    () => searchRemote('q', { runner: async () => ({ code: 0, stdout: 'some plain text output' }) }),
    (err: Error) => err instanceof RemoteSearchFailedError
  );
});

test('runner 抛错（npx 不存在/网络失败）→ remote-search-failed', async () => {
  await rejects(
    () => searchRemote('q', { runner: async () => { throw new Error('ENOENT npx'); } }),
    (err: Error) => err instanceof RemoteSearchFailedError
  );
});

test('超时 → remote-search-failed（注入短超时 + 永不返回的 runner）', async () => {
  await rejects(
    () =>
      searchRemote('q', {
        timeoutMs: 30,
        runner: (_args, signal) =>
          new Promise((_resolve, reject) => {
            signal?.addEventListener('abort', () => reject(new Error('aborted')));
          }),
      }),
    (err: Error) => err instanceof RemoteSearchFailedError
  );
});
