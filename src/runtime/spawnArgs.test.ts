import { test } from 'node:test';
import { equal, deepEqual, ok } from 'node:assert/strict';
import { join } from 'node:path';

import {
  buildSpawnArgv,
  buildDshArgv,
  dshBinPath,
  READY_LINE_RE,
  cleanLine,
  DSH_CLI_SIGNATURE,
  matchesDshSignature,
} from './spawnArgs';

test('buildSpawnArgv：node 在前，--expose-internals 在脚本名前，--no-open 防自动开浏览器', () => {
  const argv = buildSpawnArgv('/usr/local/bin/node', '/tmp/dsh/bin/dsh');
  deepEqual(argv, [
    '/usr/local/bin/node',
    '--expose-internals',
    '/tmp/dsh/bin/dsh',
    'web',
    '--no-open',
    '--host',
    '127.0.0.1',
    '--port',
    '0',
  ]);
  // 顺序断言：--expose-internals 是 node flag，必须位于脚本名之前
  ok(argv.indexOf('--expose-internals') < argv.indexOf('/tmp/dsh/bin/dsh'));
});

test('buildDshArgv：不含 node 自身，web 子命令与 --no-open 参数齐备', () => {
  const argv = buildDshArgv('/tmp/dsh/bin/dsh');
  deepEqual(argv, [
    '--expose-internals',
    '/tmp/dsh/bin/dsh',
    'web',
    '--no-open',
    '--host',
    '127.0.0.1',
    '--port',
    '0',
  ]);
  ok(argv.includes('web'));
  ok(argv.includes('--no-open'));
});

test('READY_LINE_RE：匹配样例 + 捕获 URL', () => {
  const m = READY_LINE_RE.exec('dsh web: http://127.0.0.1:53421');
  ok(m);
  equal(m![1], 'http://127.0.0.1:53421');
});

test('READY_LINE_RE：不匹配样例（https / 缺 web 子命令）', () => {
  equal(READY_LINE_RE.exec('dsh web: https://127.0.0.1:53421'), null);
  equal(READY_LINE_RE.exec('dsh: http://127.0.0.1:53421'), null);
});

test('cleanLine：strip ANSI CSI + trim（容 CRLF）', () => {
  equal(cleanLine('\x1b[32mdsh web: http://127.0.0.1:8080\r\n'), 'dsh web: http://127.0.0.1:8080');
  equal(cleanLine('\x1b[0m\x1b[1;32m  dsh web: http://127.0.0.1:8080  \r'), 'dsh web: http://127.0.0.1:8080');
});

test('READY_LINE_RE 配合 cleanLine：ANSI 前缀 + CRLF 就绪行命中', () => {
  const m = READY_LINE_RE.exec(cleanLine('\x1b[32mdsh web: http://127.0.0.1:8080\r\n'));
  ok(m);
  equal(m![1], 'http://127.0.0.1:8080');
});

test('DSH_CLI_SIGNATURE：含三段签名，matchesDshSignature 校验', () => {
  ok(DSH_CLI_SIGNATURE.includes('web'));
  ok(DSH_CLI_SIGNATURE.includes('--no-open'));
  ok(DSH_CLI_SIGNATURE.includes('--host 127.0.0.1'));
  ok(DSH_CLI_SIGNATURE.includes('--port 0'));
  ok(matchesDshSignature('node --expose-internals /dsh/bin/dsh web --no-open --host 127.0.0.1 --port 0'));
  ok(!matchesDshSignature('node --expose-internals /dsh/bin/dsh web --host 127.0.0.1 --port 0'), '缺 --no-open 不匹配（壳签名含 --no-open）');
  ok(!matchesDshSignature('node /other/web --host 127.0.0.1 --port 8080'));
});

test('dshBinPath：overlay 目录 → <overlayDir>/bin/dsh', () => {
  equal(dshBinPath('/tmp/dsh'), join('/tmp/dsh', 'bin', 'dsh'));
});
