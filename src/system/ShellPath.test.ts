import { test } from 'node:test';
import { deepEqual, equal, ok, rejects } from 'node:assert/strict';
import type { spawn } from 'node:child_process';

import { readShellPath, type ShellPathFs } from './ShellPath';

/** fs 桩：exists 控制存在性，dirs 控制 isDirectory（用于区分目录/文件） */
function fakeFs(existing: string[], dirs: string[] = existing): ShellPathFs {
  const exists = new Set(existing);
  const directory = new Set(dirs);
  return {
    existsSync: (p) => exists.has(p),
    statSync: (p) => ({ isDirectory: () => directory.has(p) }),
  };
}

interface FakeSpawnOptions {
  stdout?: string;
  /** false = 永不触发 close（配合超时用例） */
  close?: boolean;
}

/** 最小 ChildProcess 桩：异步投递 stdout/close，记录 kill/调用参数 */
function fakeSpawn(opts: FakeSpawnOptions = {}) {
  const killCalls: string[] = [];
  const calls: Array<{ command: string; args: string[] }> = [];
  const spawnFn = ((command: string, args: string[]) => {
    calls.push({ command, args });
    const listeners = new Map<string, Array<(...a: unknown[]) => void>>();
    const emit = (event: string, ...a: unknown[]) => {
      for (const cb of listeners.get(event) ?? []) cb(...a);
    };
    const child = {
      stdout: {
        on: (event: string, cb: (chunk: Buffer) => void) => {
          if (event === 'data' && opts.stdout !== undefined) {
            setImmediate(() => cb(Buffer.from(opts.stdout as string)));
          }
        },
      },
      on: (event: string, cb: (...a: unknown[]) => void) => {
        listeners.set(event, [...(listeners.get(event) ?? []), cb]);
        if (event === 'close' && opts.close !== false) setImmediate(() => emit('close', 0, null));
        return child;
      },
      kill: (signal: string) => {
        killCalls.push(signal);
        return true;
      },
    };
    return child;
  }) as unknown as typeof spawn;
  return { spawnFn, killCalls, calls };
}

test('正常输出：忽略 rc 噪声，取最后一个标记后 PATH 并过滤/保序', async () => {
  const { spawnFn, calls } = fakeSpawn({
    stdout: 'Welcome!\n[plugins] loaded\r\n__HULL_PATH__/usr/bin:/usr/local/bin:/usr/bin:/bin\n',
  });
  const result = await readShellPath({
    spawnFn,
    shell: '/bin/zsh',
    fs: fakeFs(['/bin/zsh', '/usr/bin', '/usr/local/bin', '/bin']),
  });
  equal(result.shell, '/bin/zsh');
  deepEqual(result.dirs, ['/usr/bin', '/usr/local/bin', '/bin']);
  equal(calls.length, 1);
  equal(calls[0].command, '/bin/zsh');
  deepEqual(calls[0].args, ['-ilc', 'printf "__HULL_PATH__%s" "$PATH"']);
  ok(result.elapsedMs >= 0);
});

test('去重/去空/trim + 只取最后一个标记 + 过滤不存在或非目录', async () => {
  const { spawnFn } = fakeSpawn({
    stdout: '__HULL_PATH__/old:/path\n__HULL_PATH__/a:/b:/a:: /c :/missing:/usr/bin\n',
  });
  const result = await readShellPath({
    spawnFn,
    shell: '/bin/zsh',
    // /usr/bin 存在但不是目录 → 过滤
    fs: fakeFs(['/bin/zsh', '/a', '/b', '/c', '/usr/bin'], ['/bin/zsh', '/a', '/b', '/c']),
  });
  deepEqual(result.dirs, ['/a', '/b', '/c']);
});

test('超时 → reject 且 kill(SIGKILL) 被调用', async () => {
  const { spawnFn, killCalls } = fakeSpawn({ close: false });
  await rejects(
    readShellPath({ spawnFn, shell: '/bin/zsh', timeoutMs: 20, fs: fakeFs(['/bin/zsh']) }),
    /超时/
  );
  deepEqual(killCalls, ['SIGKILL']);
});

test('空输出 / 无标记 / 全被过滤 → reject', async () => {
  await rejects(
    readShellPath({ spawnFn: fakeSpawn({ stdout: '' }).spawnFn, shell: '/bin/zsh', fs: fakeFs(['/bin/zsh']) }),
    /未返回 PATH/
  );
  await rejects(
    readShellPath({
      spawnFn: fakeSpawn({ stdout: '__HULL_PATH__/missing:/gone' }).spawnFn,
      shell: '/bin/zsh',
      fs: fakeFs(['/bin/zsh']),
    }),
    /未返回可用 PATH/
  );
});

test('非法 shell（相对路径/不存在）→ 回退 /bin/zsh', async () => {
  for (const shell of ['relative/zsh', '/opt/no-such-shell']) {
    const { spawnFn, calls } = fakeSpawn({ stdout: '__HULL_PATH__/usr/bin' });
    const result = await readShellPath({ spawnFn, shell, fs: fakeFs(['/bin/zsh', '/usr/bin']) });
    equal(result.shell, '/bin/zsh');
    equal(calls[0].command, '/bin/zsh');
  }
});
