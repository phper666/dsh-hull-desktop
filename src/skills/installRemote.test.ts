/**
 * 远程安装单测（O-3：npx skills add 封装）
 * 注入 runner mock：参数校验（owner/repo@skill + agent 白名单）、非零退出、runner 抛错、超时
 */
import { test } from 'node:test';
import { deepEqual, equal, rejects, throws } from 'node:assert/strict';

import { RemoteInstallFailedError, SkillValidationError } from './errors';
import { installRemote, parseSkillRef, INSTALL_AGENTS } from './installRemote';

test('parseSkillRef 合法 → 拆分 repo/skill', () => {
  deepEqual(parseSkillRef('anthropics/skills@webapp-testing'), { repo: 'anthropics/skills', skill: 'webapp-testing' });
  deepEqual(parseSkillRef('vercel-labs/agent-skills@core'), { repo: 'vercel-labs/agent-skills', skill: 'core' });
});

test('parseSkillRef 非法格式（注入载荷）→ validation-error', () => {
  const bad = ['', 'no-slash', 'a/b', 'a@b', 'a/b@c/d', 'a/b@;rm -rf', 'a/../b@c', 'https://x/y@z'];
  for (const ref of bad) {
    throws(() => parseSkillRef(ref), (err: Error) => err instanceof SkillValidationError, `ref=${ref}`);
  }
});

test('agent 白名单：合法 agent 通过，非法 → validation-error', async () => {
  equal(INSTALL_AGENTS.includes('opencode'), true);
  let args: string[] | null = null;
  const res = await installRemote('a/b@c', 'opencode', {
    runner: async (a) => { args = a; return { code: 0, stdout: 'ok' }; },
  });
  deepEqual(res, { installedRef: 'a/b@c', agent: 'opencode' });
  deepEqual(args, ['skills', 'add', 'a/b', '-s', 'c', '-a', 'opencode']);
  await rejects(
    () => installRemote('a/b@c', 'not-an-agent', { runner: async () => ({ code: 0, stdout: '' }) }),
    (err: Error) => err instanceof SkillValidationError
  );
});

test('非零退出码 → remote-install-failed', async () => {
  await rejects(
    () => installRemote('a/b@c', 'opencode', { runner: async () => ({ code: 1, stdout: 'error' }) }),
    (err: Error) => err instanceof RemoteInstallFailedError && err.code === 'remote-install-failed'
  );
});

test('runner 抛错（npx 不存在/网络失败）→ remote-install-failed', async () => {
  await rejects(
    () => installRemote('a/b@c', 'opencode', { runner: async () => { throw new Error('ENOENT npx'); } }),
    (err: Error) => err instanceof RemoteInstallFailedError
  );
});

test('超时 → remote-install-failed（注入短超时 + 永不返回的 runner）', async () => {
  await rejects(
    () =>
      installRemote('a/b@c', 'opencode', {
        timeoutMs: 30,
        runner: (_args, signal) =>
          new Promise((_resolve, reject) => {
            signal?.addEventListener('abort', () => reject(new Error('aborted')));
          }),
      }),
    (err: Error) => err instanceof RemoteInstallFailedError
  );
});
