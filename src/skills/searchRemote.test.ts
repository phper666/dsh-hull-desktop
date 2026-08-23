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

test('输出不可解析（无条目纯文本）→ remote-search-failed', async () => {
  await rejects(
    () => searchRemote('q', { runner: async () => ({ code: 0, stdout: 'some plain text output' }) }),
    (err: Error) => err instanceof RemoteSearchFailedError
  );
});

// O-1 实测协调项：`npx skills find` 真实输出为 ANSI 彩色文本树（两行一组：name + url），非 JSON
test('文本树输出解析：ANSI 剥离 + name/url/installs 提取（O-1 实测格式）', async () => {
  const ansi = (s: string) => `\u001b[38;5;145m${s}\u001b[0m`;
  const stdout = [
    '',
    ansi('Install with') + ' npx skills add <owner/repo@skill>',
    '',
    `${ansi('obra/superpowers@test-driven-development')} ${ansi('205.5K installs')}`,
    `${ansi('└ https://skills.sh/obra/superpowers/test-driven-development')}`,
    '',
    `${ansi('anthropics/skills@webapp-testing')} ${ansi('139.4K installs')}`,
    `${ansi('└ https://skills.sh/anthropics/skills/webapp-testing')}`,
    '',
    `${ansi('big/skill@megamodule')} ${ansi('1.2M installs')}`,
    `${ansi('└ https://skills.sh/big/skill/megamodule')}`,
  ].join('\n');
  const entries = await searchRemote('test', { runner: async () => ({ code: 0, stdout }) });
  equal(entries.length, 3);
  deepEqual(entries[0], {
    name: 'obra/superpowers@test-driven-development',
    description: null,
    source: 'https://skills.sh/obra/superpowers/test-driven-development',
    installs: 205500,
    installed: false,
  });
  deepEqual(entries[1], {
    name: 'anthropics/skills@webapp-testing',
    description: null,
    source: 'https://skills.sh/anthropics/skills/webapp-testing',
    installs: 139400,
    installed: false,
  });
  deepEqual(entries[2], {
    name: 'big/skill@megamodule',
    description: null,
    source: 'https://skills.sh/big/skill/megamodule',
    installs: 1200000,
    installed: false,
  });
});

test('文本树无 url 行 → source null，installs 未匹配 → null', async () => {
  const entries = await searchRemote('q', {
    runner: async () => ({ code: 0, stdout: 'foo/bar@baz  no-install-info\n' }),
  });
  equal(entries.length, 1);
  deepEqual(entries[0], { name: 'foo/bar@baz', description: null, source: null, installs: null, installed: false });
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
