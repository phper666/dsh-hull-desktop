/**
 * NotificationService 单测（§一/二）：emit/按源保留/逐条已读/迁移幂等/onChanged 推送。
 * 确定性：uuid/ts 注入；存储落临时目录。
 */
import { test } from 'node:test';
import { deepEqual, equal, ok, throws } from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { NotificationService } from './NotificationService';
import type { NotifInput } from './types';

function makeEnv(opts: { runsJson?: unknown } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'hull-notifs-'));
  if (opts.runsJson) {
    mkdirSync(join(dir, 'workflows'), { recursive: true });
    writeFileSync(join(dir, 'workflows', 'runs.json'), JSON.stringify(opts.runsJson));
  }
  let seq = 0;
  const changes: number[] = [];
  const svc = new NotificationService({
    userDataPath: dir,
    uuid: () => `n-${++seq}`,
    now: () => new Date('2026-09-03T10:00:00Z'),
    onChanged: () => changes.push(seq),
  });
  return { svc, dir, changes };
}

const base: NotifInput = {
  source: 'workflow',
  severity: 'error',
  title: '工作流 · 夜巡【失败】',
  body: 'HTTP 503',
  link: { kind: 'workflow', workflowId: 'wf-1' },
};

test('emit：落盘 + 默认未读 + onChanged 触发', () => {
  const { svc, dir, changes } = makeEnv();
  svc.emit(base);
  equal(changes.length, 1, 'onChanged 触发');
  ok(existsSync(join(dir, 'notifications', 'notifications.json')));
  const all = svc.list();
  equal(all.length, 1);
  equal(all[0].id, 'n-1');
  equal(all[0].severity, 'error');
  equal(all[0].readAt, null, 'error 默认未读');
  equal(all[0].ts, '2026-09-03T10:00:00.000Z');
});

test('emit：info 显式 readAt 可立即已读', () => {
  const { svc } = makeEnv();
  svc.emit({ ...base, severity: 'info', title: '成功', readAt: '2026-09-03T10:00:00Z' });
  equal(svc.list()[0].readAt, '2026-09-03T10:00:00Z');
});

test('按源保留：workflow 50 / board-exec 100（环形按 ts 裁剪，互不挤占）', () => {
  const { svc } = makeEnv();
  for (let i = 0; i < 55; i++) svc.emit({ ...base, title: `w${i}`, ts: new Date(Date.UTC(2026, 8, 3, 0, i)).toISOString() });
  for (let i = 0; i < 105; i++)
    svc.emit({ ...base, source: 'board-exec', severity: 'info', title: `b${i}`, link: { kind: 'task', boardId: 'b1', taskId: `t${i}` }, ts: new Date(Date.UTC(2026, 8, 3, 0, i)).toISOString() });
  const all = svc.list();
  equal(all.filter((n) => n.source === 'workflow').length, 50);
  equal(all.filter((n) => n.source === 'board-exec').length, 100);
  // 环形：最旧的被裁（w0/b0 不在，w54/b104 在）
  ok(!all.some((n) => n.title === 'w0'));
  ok(all.some((n) => n.title === 'w54'));
  ok(!all.some((n) => n.title === 'b0'));
});

test('markAllRead：全量与按源', () => {
  const { svc } = makeEnv();
  svc.emit(base);
  svc.emit({ ...base, source: 'board-exec', severity: 'error', link: { kind: 'task', boardId: 'b', taskId: 't' } });
  svc.markAllRead('workflow');
  equal(svc.list().find((n) => n.source === 'workflow')!.readAt !== null, true);
  equal(svc.list().find((n) => n.source === 'board-exec')!.readAt, null, '按源只读本源');
  svc.markAllRead();
  ok(svc.list().every((n) => n.readAt !== null));
});

test('迁移：runs.json → workflow 通知（failed 未读/success 已读），幂等且 runs 原样保留', () => {
  const runsJson = {
    version: 1,
    runs: [
      { id: 'r1', workflowId: 'wf-a', workflowName: '夜巡', startedAt: '2026-09-03T09:00:00Z', finishedAt: '2026-09-03T09:01:00Z', status: 'failed', trigger: 'cron', log: [{ stepId: 's1', type: 'http', ok: false, message: '503', durationMs: 100 }] },
      { id: 'r2', workflowId: 'wf-a', workflowName: '夜巡', startedAt: '2026-09-02T09:00:00Z', status: 'success', trigger: 'cron', log: [] },
    ],
  };
  const { svc, dir } = makeEnv({ runsJson });
  svc.migrateFromWorkflowRuns();
  const all = svc.list();
  equal(all.length, 2);
  const fail = all.find((n) => n.severity === 'error')!;
  equal(fail.readAt, null, 'failed 导入为未读');
  equal(fail.body, '503');
  const okN = all.find((n) => n.severity === 'info')!;
  ok(okN.readAt !== null, 'success 导入为已读');
  ok(existsSync(join(dir, 'workflows', 'runs.json')), 'runs 原样保留');
  // 幂等：再次迁移不重复
  svc.migrateFromWorkflowRuns();
  equal(svc.list().length, 2);
});

test('迁移：notifications.json 已存在则跳过；无 runs.json 不动作', () => {
  const { svc, dir } = makeEnv({ runsJson: { version: 1, runs: [] } });
  svc.emit(base); // 已有数据
  svc.migrateFromWorkflowRuns();
  equal(svc.list().length, 1, '已有数据不迁移');
  // 无 runs.json
  const empty = mkdtempSync(join(tmpdir(), 'hull-notifs-empty-'));
  try {
    const svc2 = new NotificationService({ userDataPath: empty, uuid: () => 'x', now: () => new Date() });
    svc2.migrateFromWorkflowRuns();
    equal(svc2.list().length, 0);
  } finally {
    rmSync(empty, { recursive: true, force: true });
  }
});

test('onChanged 缺省不炸（无回调可独立用）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hull-notifs-nocb-'));
  try {
    const svc = new NotificationService({ userDataPath: dir, uuid: () => 'u', now: () => new Date() });
    svc.emit(base);
    equal(svc.list().length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
