import { test, after } from 'node:test';
import { equal, deepEqual, ok } from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  buildSpawnArgv,
  buildDshArgv,
  dshBinPath,
  dshEntryPath,
  READY_LINE_RE,
  cleanLine,
  DSH_CLI_SIGNATURE,
  matchesDshSignature,
} from './spawnArgs';

const tempDirs: string[] = [];
after(() => {
  for (const d of tempDirs) rmSync(d, { recursive: true, force: true });
});

/** 建临时 overlay 目录（返回 realpath 归一化路径——macOS /var→/private/var；记录待清理） */
function makeOverlay(): string {
  const d = realpathSync(mkdtempSync(join(tmpdir(), 'hull-ov-')));
  tempDirs.push(d);
  return d;
}

/** 写 npm hoisted 布局：<overlay>/node_modules/@deepseek-ai/dsh/package.json */
function writeNpmLayout(overlay: string, pkgJson: Record<string, unknown> = { bin: { dsh: 'lib/bin.js' } }): void {
  const pkgDir = join(overlay, 'node_modules', '@deepseek-ai', 'dsh');
  mkdirSync(join(pkgDir, 'lib'), { recursive: true });
  writeFileSync(join(pkgDir, 'package.json'), JSON.stringify(pkgJson), 'utf8');
  writeFileSync(join(pkgDir, 'lib', 'bin.js'), '// entry\n', 'utf8');
}

/** 写 pnpm 布局：@deepseek-ai/dsh 为 symlink → .pnpm/.../node_modules/@deepseek-ai/dsh */
function writePnpmLayout(overlay: string, pkgJson: Record<string, unknown> = { bin: { dsh: 'lib/bin.js' } }): void {
  const realDir = join(overlay, 'node_modules', '.pnpm', 'dsh@1.0.0', 'node_modules', '@deepseek-ai', 'dsh');
  mkdirSync(join(realDir, 'lib'), { recursive: true });
  writeFileSync(join(realDir, 'package.json'), JSON.stringify(pkgJson), 'utf8');
  writeFileSync(join(realDir, 'lib', 'bin.js'), '// entry\n', 'utf8');
  mkdirSync(join(overlay, 'node_modules', '@deepseek-ai'), { recursive: true });
  symlinkSync(realDir, join(overlay, 'node_modules', '@deepseek-ai', 'dsh'), 'dir'); // symlink 布局
}

test('buildSpawnArgv：node 在前，--expose-internals 在入口前，--no-open 防自动开浏览器', () => {
  const argv = buildSpawnArgv('/usr/local/bin/node', '/tmp/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js');
  deepEqual(argv, [
    '/usr/local/bin/node',
    '--expose-internals',
    '/tmp/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js',
    'web',
    '--no-open',
    '--host',
    '127.0.0.1',
    '--port',
    '0',
  ]);
  // 顺序断言：--expose-internals 是 node flag，必须位于入口之前
  ok(argv.indexOf('--expose-internals') < argv.indexOf('/tmp/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js'));
});

test('buildDshArgv：不含 node 自身，web 子命令与 --no-open 参数齐备', () => {
  const argv = buildDshArgv('/tmp/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js');
  deepEqual(argv, [
    '--expose-internals',
    '/tmp/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js',
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

test('dshEntryPath：npm hoisted 布局 → bin.dsh 字段解析真实入口（lib/bin.js）', () => {
  const overlay = makeOverlay();
  writeNpmLayout(overlay);
  const entry = dshEntryPath(overlay);
  equal(entry, join(overlay, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'));
});

test('dshEntryPath：pnpm symlink 布局 → 沿 symlink 解析真实入口', () => {
  const overlay = makeOverlay();
  writePnpmLayout(overlay);
  const entry = dshEntryPath(overlay);
  // 应解析到 .pnpm 下的真实目录（symlink 跟随后）
  ok(entry.includes('.pnpm'), `pnpm 布局应指向 .pnpm 真实目录（got: ${entry}）`);
  ok(entry.endsWith('lib/bin.js'));
});

test('dshEntryPath：bin 字段带 ./ 前缀 → 归一化（./lib/bin.js == lib/bin.js）', () => {
  const overlay = makeOverlay();
  writeNpmLayout(overlay, { bin: { dsh: './lib/bin.js' } });
  const entry = dshEntryPath(overlay);
  equal(entry, join(overlay, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'));
});

test('dshEntryPath：bin 字段缺失 → 回退 <pkgDir>/lib/bin.js（dsh 已知入口）', () => {
  const overlay = makeOverlay();
  writeNpmLayout(overlay, { main: 'index.js' }); // 无 bin 字段
  const entry = dshEntryPath(overlay);
  equal(entry, join(overlay, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'));
});

test('dshEntryPath：包不存在 → 回退 <overlay>/lib/bin.js（最外层兜底）', () => {
  const overlay = makeOverlay();
  mkdirSync(join(overlay, 'lib'), { recursive: true });
  writeFileSync(join(overlay, 'lib', 'bin.js'), '// entry\n', 'utf8');
  const entry = dshEntryPath(overlay);
  equal(entry, join(overlay, 'lib', 'bin.js'));
});

test('dshBinPath：overlay 目录 → <overlayDir>/bin/dsh（保留兼容）', () => {
  equal(dshBinPath('/tmp/dsh'), join('/tmp/dsh', 'bin', 'dsh'));
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
  ok(matchesDshSignature('node --expose-internals /dsh/lib/bin.js web --no-open --host 127.0.0.1 --port 0'));
  ok(!matchesDshSignature('node --expose-internals /dsh/lib/bin.js web --host 127.0.0.1 --port 0'), '缺 --no-open 不匹配');
  ok(!matchesDshSignature('node /other/web --host 127.0.0.1 --port 8080'));
});
