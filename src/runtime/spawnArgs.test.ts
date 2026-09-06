import { test, after } from 'node:test';
import { equal, deepEqual, ok } from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
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
  resolveNodePath,
  resolveBundledNpx,
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

/** pnpm 布局变体：可指定 .pnpm 目录名（模拟不同版本），bin 内容以目录名标记便于断言。
 *  symlink 用相对 target（对齐真实 pnpm 行为）——rename 目录后相对链接不断。 */
function writePnpmLayoutVer(overlay: string, pnpmDirName: string): void {
  const realDir = join(overlay, 'node_modules', '.pnpm', pnpmDirName, 'node_modules', '@deepseek-ai', 'dsh');
  mkdirSync(join(realDir, 'lib'), { recursive: true });
  writeFileSync(join(realDir, 'package.json'), JSON.stringify({ bin: { dsh: 'lib/bin.js' } }), 'utf8');
  writeFileSync(join(realDir, 'lib', 'bin.js'), `// entry ${pnpmDirName}\n`, 'utf8');
  mkdirSync(join(overlay, 'node_modules', '@deepseek-ai'), { recursive: true });
  symlinkSync(join('..', '.pnpm', pnpmDirName, 'node_modules', '@deepseek-ai', 'dsh'), join(overlay, 'node_modules', '@deepseek-ai', 'dsh'), 'dir');
}

test('Q-017-D：同进程 swap 后 dshEntryPath 不得返回旧版缓存路径', () => {
  // 复刻 swapCore 时序：live 路径先承载 v1 → rename 到 previous → staging（v2）rename 回 live。
  // 同一 overlayDir 字符串两次解析——createRequire 的 CJS 解析缓存（Module._pathCache）
  // 以 parent 路径为键且不随文件系统变更失效，会返回 v1 旧 realpath（已被 rename 掉）
  // → 升级验证启动 MODULE_NOT_FOUND → 回滚（prod 实测 2026-09-04 17:25）。
  const home = makeOverlay();
  const live = join(home, 'dsh');
  const staging = join(home, 'dsh-staging');
  const previous = join(home, 'dsh-previous');
  writePnpmLayoutVer(live, 'dsh@1.0.0');
  writePnpmLayoutVer(staging, 'dsh@2.0.0');

  const first = dshEntryPath(live);
  ok(first.includes('dsh@1.0.0'), `首次解析应命中 v1: ${first}`);

  // 模拟 swapCore：①清 previous ②live → previous ③staging → live（同卷 rename）
  rmSync(previous, { recursive: true, force: true });
  renameSync(live, previous);
  renameSync(staging, live);

  const second = dshEntryPath(live);
  ok(second.includes('dsh@2.0.0'), `swap 后必须解析到 v2: ${second}`);
});

// ─────────────────── 0.1.7 修复：resolveNodePath / resolveBundledNpx（单一修改点） ───────────────────

test('resolveNodePath：HULL_NODE_PATH env 优先', () => {
  const saved = process.env.HULL_NODE_PATH;
  try {
    process.env.HULL_NODE_PATH = '/env/node';
    equal(resolveNodePath('/any/userData'), '/env/node');
  } finally {
    if (saved === undefined) delete process.env.HULL_NODE_PATH;
    else process.env.HULL_NODE_PATH = saved;
  }
});

test('resolveNodePath：捆绑 node 存在 → <userData>/node/bin/node；缺失 → PATH 兜底 \'node\'', () => {
  const saved = process.env.HULL_NODE_PATH;
  delete process.env.HULL_NODE_PATH;
  try {
    const dir = mkdtempSync(join(tmpdir(), 'hull-node-'));
    tempDirs.push(dir);
    mkdirSync(join(dir, 'node', 'bin'), { recursive: true });
    writeFileSync(join(dir, 'node', 'bin', 'node'), '#!/bin/sh\n', { mode: 0o755 });
    equal(resolveNodePath(dir), join(dir, 'node', 'bin', 'node'));
    // 无捆绑 → 兜底
    equal(resolveNodePath(join(tmpdir(), 'hull-no-node-xyz')), 'node');
  } finally {
    if (saved !== undefined) process.env.HULL_NODE_PATH = saved;
  }
});

test('resolveBundledNpx：捆绑齐备 → {nodePath, cliJs}；未捆绑 / npx-cli.js 缺失 → undefined', () => {
  const saved = process.env.HULL_NODE_PATH;
  delete process.env.HULL_NODE_PATH;
  try {
    // 齐备：bin/node + lib/node_modules/npm/bin/npx-cli.js
    const dir = mkdtempSync(join(tmpdir(), 'hull-npx-'));
    tempDirs.push(dir);
    mkdirSync(join(dir, 'node', 'bin'), { recursive: true });
    mkdirSync(join(dir, 'node', 'lib', 'node_modules', 'npm', 'bin'), { recursive: true });
    writeFileSync(join(dir, 'node', 'bin', 'node'), '#!/bin/sh\n', { mode: 0o755 });
    writeFileSync(join(dir, 'node', 'lib', 'node_modules', 'npm', 'bin', 'npx-cli.js'), 'console.log(1)\n');
    deepEqual(resolveBundledNpx(dir), {
      nodePath: join(dir, 'node', 'bin', 'node'),
      cliJs: join(dir, 'node', 'lib', 'node_modules', 'npm', 'bin', 'npx-cli.js'),
    });
    // 有 node 无 npx-cli.js（结构变化防御）→ undefined
    const dir2 = mkdtempSync(join(tmpdir(), 'hull-npx2-'));
    tempDirs.push(dir2);
    mkdirSync(join(dir2, 'node', 'bin'), { recursive: true });
    writeFileSync(join(dir2, 'node', 'bin', 'node'), '#!/bin/sh\n', { mode: 0o755 });
    equal(resolveBundledNpx(dir2), undefined);
    // 未捆绑 → undefined（dev 回退 PATH npx）
    equal(resolveBundledNpx(join(tmpdir(), 'hull-no-npx-xyz')), undefined);
  } finally {
    if (saved !== undefined) process.env.HULL_NODE_PATH = saved;
  }
});

test('resolveNodePath/resolveBundledNpx：win32 布局——node.exe 在根（无 bin 层），npx-cli.js 同级 node_modules', () => {
  const saved = process.env.HULL_NODE_PATH;
  delete process.env.HULL_NODE_PATH;
  try {
    const dir = mkdtempSync(join(tmpdir(), 'hull-win-'));
    tempDirs.push(dir);
    mkdirSync(join(dir, 'node', 'node_modules', 'npm', 'bin'), { recursive: true });
    writeFileSync(join(dir, 'node', 'node.exe'), 'binary');
    writeFileSync(join(dir, 'node', 'node_modules', 'npm', 'bin', 'npx-cli.js'), 'console.log(1)\n');
    // resolveNodePath win32 → <userData>/node/node.exe
    equal(resolveNodePath(dir, 'win32'), join(dir, 'node', 'node.exe'));
    // resolveBundledNpx win32 → nodePath + 同级 node_modules/npm/bin/npx-cli.js（正斜杠归一，跨平台断言确定）
    const npx = resolveBundledNpx(dir, 'win32');
    ok(npx, 'win32 捆绑 npx 解析成功');
    ok(npx!.nodePath.endsWith('/node/node.exe'), `nodePath 指向 node.exe: ${npx!.nodePath}`);
    ok(npx!.cliJs.includes('/node/node_modules/npm/bin/npx-cli.js'), `cliJs win 布局: ${npx!.cliJs}`);
    // win 布局不满足（只有 POSIX bin/node）→ undefined
    equal(resolveBundledNpx(dir, 'darwin'), undefined);
  } finally {
    if (saved !== undefined) process.env.HULL_NODE_PATH = saved;
  }
});
