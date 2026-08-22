/**
 * S2 操作日志单测（CON-R-skills-003/008，设计 D6）
 * operations.jsonl append-only + 启动截断（>10MB 保留最近 1000 行）+ 尾读倒序
 */
import { test } from 'node:test';
import { deepEqual, equal, ok } from 'node:assert/strict';
import { statSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { createNodeFsOps } from '../SkillFsOps';
import { OperationLog } from './OperationLog';

const tempDirs: string[] = [];
function makeTemp(): string {
  const dir = mkdtempSync(join(tmpdir(), 'hull-skills-log-'));
  tempDirs.push(dir);
  return dir;
}
test.after(() => {
  for (const d of tempDirs) rmSync(d, { recursive: true, force: true });
});

test('append + readTail：时间倒序、limit 生效、坏行跳过', () => {
  const file = join(makeTemp(), 'operations.jsonl');
  const log = new OperationLog(file);
  log.append({ ts: '2026-08-23T00:00:01Z', action: 'remove', paths: ['/a'], result: 'success' });
  log.append({ ts: '2026-08-23T00:00:02Z', action: 'disable', paths: ['/b'], result: 'failed', detail: { code: 'skills-conflict' } });
  writeFileSync(file, '{corrupt!!!\n', { flag: 'a' }); // 半行/损坏行（模拟崩溃残留）
  log.append({ ts: '2026-08-23T00:00:03Z', action: 'enable', paths: ['/b'], result: 'success' });

  const all = log.readTail();
  equal(all.length, 3);
  equal(all[0].action, 'enable'); // 最新在前
  equal(all[2].action, 'remove');

  const tail1 = log.readTail(1);
  equal(tail1.length, 1);
  equal(tail1[0].action, 'enable');
});

test('init 截断：>10MB 保留最近 1000 行，旧行丢弃', () => {
  const file = join(makeTemp(), 'operations.jsonl');
  const pad = 'x'.repeat(64);
  const lines: string[] = [];
  for (let i = 0; i < 200_000; i++) {
    lines.push(JSON.stringify({ ts: 't', action: 'remove', paths: [`${pad}${i}`], result: 'success' }));
  }
  writeFileSync(file, lines.join('\n'), 'utf8');
  ok(statSync(file).size > 10 * 1024 * 1024, '前置：文件确实超过 10MB');

  const log = new OperationLog(file);
  log.init();

  ok(statSync(file).size <= 10 * 1024 * 1024, '截断后回到阈值内');
  const tail = log.readTail(1000);
  equal(tail.length, 1000);
  ok(tail[0].paths[0]!.endsWith('199999'), '保留的是最新行');
});

test('缺失文件：init/readTail 不抛错按空处理', () => {
  const log = new OperationLog(join(makeTemp(), 'nope.jsonl'));
  log.init();
  deepEqual(log.readTail(), []);
});
