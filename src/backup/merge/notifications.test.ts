import { test } from 'node:test';
import { deepEqual, equal, ok } from 'node:assert/strict';

import type { NotifRow, NotifSource } from '../../notifications/types';
import { NOTIF_RETENTION } from '../../notifications/types';
import { mergeDismiss, mergeNotifications } from './notifications';

function row(id: string, source: NotifSource, ts: string): NotifRow {
  return {
    id,
    source,
    severity: 'info',
    title: id,
    body: '',
    link: { kind: 'workflow', workflowId: 'w1' },
    ts,
    readAt: ts,
  };
}

test('通知：包内基底 + 本地按 id 去重追加', () => {
  const local = { version: 1, notifications: [row('n1', 'workflow', '2026-09-02T00:00:00.000Z'), row('n3', 'workflow', '2026-09-03T00:00:00.000Z')] };
  const incoming = { version: 1, notifications: [row('n1', 'workflow', '2026-09-01T00:00:00.000Z'), row('n2', 'board-exec', '2026-09-01T12:00:00.000Z')] };
  const { value, conflicts } = mergeNotifications(local, incoming);

  const ids = value.notifications.map((n) => n.id).sort();
  deepEqual(ids, ['n1', 'n2', 'n3']);
  equal(value.notifications.find((n) => n.id === 'n1')!.ts, '2026-09-01T00:00:00.000Z'); // 基底优先
  equal(conflicts.length, 1);
  equal(conflicts[0].kind, 'notif'); // 归 notif 类，不污染 workflow 计数
  equal(conflicts[0].resolution, 'skipped-identical');
  equal(conflicts[0].id, 'n1');
});

test('通知：按源 ring cap 裁剪（超出计 skipped，保留较新）', () => {
  const rows: NotifRow[] = [];
  for (let i = 0; i < NOTIF_RETENTION.workflow + 5; i++) {
    rows.push(row(`n${String(i).padStart(3, '0')}`, 'workflow', `2026-01-01T00:00:${String(i).padStart(2, '0')}.000Z`));
  }
  const { value, conflicts } = mergeNotifications({ version: 1, notifications: rows }, { version: 1, notifications: [] });
  equal(value.notifications.length, NOTIF_RETENTION.workflow);
  ok(value.notifications.some((n) => n.ts.endsWith(':54.000Z')));
  ok(!value.notifications.some((n) => n.ts.endsWith(':04.000Z')));
  equal(conflicts.length, 5, '被裁 5 条');
  ok(conflicts.every((c) => c.kind === 'notif'));
});

test('dismiss：逐 channel 取较新 ISO 日期；旧 date 键视作 dsh', () => {
  const merged = mergeDismiss(
    { dsh: '2026-09-17', hull: '2026-01-01', date: '2026-09-18' },
    { dsh: '2026-09-16', hull: '2026-02-01' },
  );
  equal(merged.dsh, '2026-09-18'); // 旧 date 键取新
  equal(merged.hull, '2026-02-01');
  const merged2 = mergeDismiss({}, { dsh: '2026-03-01T00:00:00.000Z' });
  equal(merged2.dsh, '2026-03-01T00:00:00.000Z');
  equal('hull' in merged2, false);
  deepEqual(mergeDismiss(null, null), {});
});
