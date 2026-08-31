import { test, after } from 'node:test';
import { equal, ok } from 'node:assert/strict';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Logger } from './Logger';

const tempDirs: string[] = [];
after(() => {
  for (const d of tempDirs) rmSync(d, { recursive: true, force: true });
});

function makeDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'hull-log-'));
  tempDirs.push(d);
  return d;
}

test('info/warn/error 追加落盘 hull.log（带级别标记）', () => {
  const dir = makeDir();
  const log = new Logger({ logDir: dir });
  log.info('hello');
  log.warn('careful');
  log.error('boom');
  const content = readFileSync(join(dir, 'hull.log'), 'utf8');
  ok(content.includes('[info] hello'));
  ok(content.includes('[warn] careful'));
  ok(content.includes('[error] boom'));
});

test('超阈值轮转：hull.log → .1/.2/.3 顺序（keepCount=3）', () => {
  const dir = makeDir();
  const log = new Logger({ logDir: dir, maxBytes: 50, keepCount: 3 });
  // 每行 ~53 字节 > 50 → 每次写入前都触发轮转
  for (let i = 1; i <= 8; i++) log.info(`line-${i}-xxxxxxxxxxxx`);
  const base = readFileSync(join(dir, 'hull.log'), 'utf8');
  ok(base.includes('line-8'), '最新行在 hull.log');
  ok(!base.includes('line-7'), 'hull.log 不应含已轮转内容');
  ok(readFileSync(join(dir, 'hull.log.1'), 'utf8').includes('line-7'), '.1 = 最近备份');
  ok(readFileSync(join(dir, 'hull.log.2'), 'utf8').includes('line-6'), '.2 = 次近备份');
  ok(readFileSync(join(dir, 'hull.log.3'), 'utf8').includes('line-5'), '.3 = 最旧备份');
  ok(!existsSync(join(dir, 'hull.log.4')), 'keepCount=3，无 .4');
});

test('dshLog 统一落盘 dsh.log（带时间戳 + [dsh pid=<pid>] 前缀，不再 dsh-<pid>.log）', () => {
  const dir = makeDir();
  const log = new Logger({ logDir: dir });
  log.dshLog(4242, 'dsh web: http://127.0.0.1:53421');
  log.dshLog(4242, 'second line');
  const content = readFileSync(join(dir, 'dsh.log'), 'utf8');
  // 时间戳格式与 hull.log 一致：[YYYY-MM-DD HH:mm:ss.SSS]
  ok(/\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3}\] \[dsh pid=4242\] dsh web:/.test(content), 'dsh.log 含时间戳 + pid 前缀 + 内容');
  ok(/\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3}\] \[dsh pid=4242\] second line/.test(content), '每行独立时间戳');
  ok(!existsSync(join(dir, 'dsh-4242.log')), '不再创建 dsh-<pid>.log');
});

test('写失败降级：不抛，console.warn 告警', () => {
  const dir = makeDir();
  chmodSync(dir, 0o555); // 只读目录 → appendFileSync EACCES
  const origWarn = console.warn;
  const warns: string[] = [];
  console.warn = (m: unknown) => warns.push(String(m));
  try {
    const log = new Logger({ logDir: dir });
    log.info('boom'); // 必须不抛
    log.dshLog(4242, 'line');
    equal(ok(true), undefined);
  } finally {
    console.warn = origWarn;
    chmodSync(dir, 0o755);
  }
  ok(warns.length >= 1, '应产生 console.warn 告警');
});
