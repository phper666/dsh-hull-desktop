import { test } from 'node:test';
import { equal, ok } from 'node:assert/strict';

import type { WorkflowDef } from '../../workflows/types';
import { mergeWorkflows } from './workflows';

function wf(id: string, name: string, enabled = true): WorkflowDef {
  return {
    id,
    name,
    enabled,
    steps: [{ id: `${id}_s1`, type: 'delay', config: { seconds: '1' } }],
    trigger: null,
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-01T00:00:00.000Z',
  };
}

test('id 冲突 → 重 id 追加；新 id 直接追加；包内为基底', () => {
  const local = { version: 1, workflows: [wf('w1', '本地流'), wf('w9', '本地独有')] };
  const incoming = { version: 1, workflows: [wf('w1', '包内流'), wf('w2', '包内另一个')] };
  const { value, conflicts } = mergeWorkflows(local, incoming, { uuid: () => 'fixed-uuid' });

  equal(value.workflows.length, 4);
  equal(value.workflows[0].id, 'w1'); // 包内基底顺序保留
  equal(value.workflows[1].id, 'w2');
  const appended1 = value.workflows[2];
  equal(appended1.id, 'wf_fixed-uuid');
  equal(appended1.name, '本地流');
  equal(value.workflows[3].id, 'w9');

  equal(conflicts.length, 1);
  equal(conflicts[0].kind, 'workflow');
  equal(conflicts[0].id, 'w1');
  equal(conflicts[0].resolution, 'appended');
  ok(conflicts[0].detail?.includes('wf_fixed-uuid'));
});

test('id 冲突且内容相同 → 跳过（skipped-identical）', () => {
  const same = wf('w1', '同名同内容');
  const { value, conflicts } = mergeWorkflows(
    { version: 1, workflows: [same] },
    { version: 1, workflows: [{ ...same, steps: same.steps.map((s) => ({ ...s })) }] },
    { uuid: () => 'x' },
  );
  equal(value.workflows.length, 1);
  equal(conflicts[0].resolution, 'skipped-identical');
  equal(conflicts[0].id, 'w1');
});

test('name 相同不合并不覆盖 → 原样追加并记 appended', () => {
  const { value, conflicts } = mergeWorkflows(
    { version: 1, workflows: [wf('w9', '同名')] },
    { version: 1, workflows: [wf('w1', '同名')] },
    { uuid: () => 'x' },
  );
  equal(value.workflows.length, 2);
  equal(conflicts[0].resolution, 'appended');
  equal(conflicts[0].id, 'w9');
  ok(conflicts[0].detail?.includes('同名'));
});

test('incoming 非法/缺失 → 空基底；local 非法 → 不崩', () => {
  const { value } = mergeWorkflows({ version: 1, workflows: [wf('w1', 'a')] }, null, { uuid: () => 'u' });
  equal(value.workflows.length, 1);
  equal(value.workflows[0].id, 'w1');
  const { value: v2 } = mergeWorkflows(null, { version: 1, workflows: [wf('w2', 'b')] }, { uuid: () => 'u' });
  equal(v2.workflows.length, 1);
  equal(v2.version, 1);
});
