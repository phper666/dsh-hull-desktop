import { test } from 'node:test';
import { deepEqual, equal } from 'node:assert/strict';

import { emptyReport, mergeReports } from './conflicts';

test('emptyReport：六类计数归零 + 空清单', () => {
  const r = emptyReport();
  deepEqual(r.classes, {
    note: { added: 0, updated: 0, skipped: 0 },
    kanban: { added: 0, updated: 0, skipped: 0 },
    workflow: { added: 0, updated: 0, skipped: 0 },
    skill: { added: 0, updated: 0, skipped: 0 },
    setting: { added: 0, updated: 0, skipped: 0 },
    notif: { added: 0, updated: 0, skipped: 0 },
  });
  deepEqual(r.conflicts, []);
  deepEqual(r.notices, []);
});

test('mergeReports：计数相加、冲突/提示拼接，不改入参', () => {
  const a = emptyReport();
  a.classes.note = { added: 1, updated: 2, skipped: 3 };
  a.conflicts.push({ kind: 'note', path: 'a.md', resolution: 'renamed' });
  const b = emptyReport();
  b.classes.note = { added: 10, updated: 20, skipped: 30 };
  b.classes.kanban = { added: 4, updated: 0, skipped: 0 };
  b.conflicts.push({ kind: 'kanban', id: 'b_1', resolution: 'appended' });
  b.notices.push({ code: 'notes-dir-fallback', message: 'x' });

  const merged = mergeReports(a, b);
  deepEqual(merged.classes.note, { added: 11, updated: 22, skipped: 33 });
  deepEqual(merged.classes.kanban, { added: 4, updated: 0, skipped: 0 });
  equal(merged.conflicts.length, 2);
  deepEqual(merged.notices, [{ code: 'notes-dir-fallback', message: 'x' }]);
  // 入参未被改写
  deepEqual(a.classes.note, { added: 1, updated: 2, skipped: 3 });
  equal(b.conflicts.length, 1);
});
