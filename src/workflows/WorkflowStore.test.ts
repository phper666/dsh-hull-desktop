/**
 * WorkflowStore v2 触发器字段单测：save 校验 cron 合法性；字段级扩展（version 不 bump）读侧容错。
 */
import { test } from 'node:test';
import { equal, ok, throws } from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { WorkflowStore } from './WorkflowStore';

function makeStore(): { store: WorkflowStore; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'hull-workflows-store-'));
  return { store: new WorkflowStore(dir), dir };
}

test('save：trigger 合法 cron 持久化 + list 回读', () => {
  const { store, dir } = makeStore();
  try {
    const w = store.save({ name: '定时巡检', trigger: { type: 'cron', expr: '0 9 * * 1-5' }, steps: [] });
    equal(w.trigger?.type, 'cron');
    equal(w.trigger?.expr, '0 9 * * 1-5');
    ok(JSON.parse(require('node:fs').readFileSync(join(dir, 'workflows', 'workflows.json'), 'utf8')).version === 1, '字段级扩展不 bump version');
    equal(store.list()[0].trigger?.expr, '0 9 * * 1-5');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('save：非法 cron 拒绝（含 null/undefined 视为手动，可清除 trigger）', () => {
  const { store } = makeStore();
  throws(() => store.save({ name: '坏表达式', trigger: { type: 'cron', expr: '60 * * * *' }, steps: [] }), /分钟/);
  // 更新为 null → 清除 trigger
  const w = store.save({ name: '可切换', trigger: { type: 'cron', expr: '*/5 * * * *' }, steps: [] });
  const updated = store.save({ id: w.id, name: '可切换', trigger: null, steps: [] });
  equal(updated.trigger ?? null, null);
});

test('读侧容错：v1 无 trigger 字段的存量数据照常加载', () => {
  const { store, dir } = makeStore();
  try {
    mkdirSync(join(dir, 'workflows'), { recursive: true });
    writeFileSync(
      join(dir, 'workflows', 'workflows.json'),
      JSON.stringify({ version: 1, workflows: [{ id: 'legacy', name: 'v1 存量', enabled: true, steps: [], createdAt: '2026-08-31T00:00:00Z', updatedAt: '2026-08-31T00:00:00Z' }] })
    );
    const all = store.list();
    equal(all.length, 1);
    equal(all[0].id, 'legacy');
    equal(all[0].trigger ?? null, null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
