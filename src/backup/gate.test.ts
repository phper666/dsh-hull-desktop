import { test } from 'node:test';
import { deepEqual, equal } from 'node:assert/strict';

import { canBackup, canRestore, canRestart, canStartUpdate, type GateDeps } from './gate';

function deps(over: Partial<GateDeps> = {}): GateDeps {
  return {
    hasRunningExecutions: () => false,
    isInstallOrUpgradeActive: () => false,
    isSkillsUpgradeActive: () => false,
    isHullUpdateActive: () => false,
    hasPendingRestore: () => false,
    ...over,
  };
}

test('canBackup：全通过', () => deepEqual(canBackup(deps()), { ok: true }));

test('canBackup：exec 执行中 / 排队 → backup-busy', () => {
  const r = canBackup(deps({ hasRunningExecutions: () => true }));
  equal(r.ok, false);
  equal(r.code, 'backup-busy');
});

test('canBackup：dsh 安装/升级进行中 → backup-busy', () => {
  const r = canBackup(deps({ isInstallOrUpgradeActive: () => true }));
  equal(r.ok, false);
  equal(r.code, 'backup-busy');
});

test('canBackup：skills 升级进行中 → backup-busy（CON-R-backup-005 v1.1）', () => {
  const r = canBackup(deps({ isSkillsUpgradeActive: () => true }));
  equal(r.ok, false);
  equal(r.code, 'backup-busy');
});

test('canBackup：Hull 自更新进行中 → backup-busy', () => {
  const r = canBackup(deps({ isHullUpdateActive: () => true }));
  equal(r.ok, false);
  equal(r.code, 'backup-busy');
});

test('canBackup：已有 pending restore → restore-pending', () => {
  const r = canBackup(deps({ hasPendingRestore: () => true }));
  equal(r.ok, false);
  equal(r.code, 'restore-pending');
});

test('canRestore：全通过（exec 执行中不阻塞恢复）', () => {
  deepEqual(canRestore(deps({ hasRunningExecutions: () => true })), { ok: true });
});

test('canRestore：Hull 自更新 / dsh 升级进行中 → update-in-progress', () => {
  for (const over of [{ isHullUpdateActive: () => true }, { isInstallOrUpgradeActive: () => true }] as const) {
    const r = canRestore(deps(over));
    equal(r.ok, false);
    equal(r.code, 'update-in-progress');
  }
});

test('canRestore：skills 升级进行中 → update-in-progress（CON-R-backup-005 v1.1）', () => {
  const r = canRestore(deps({ isSkillsUpgradeActive: () => true }));
  equal(r.ok, false);
  equal(r.code, 'update-in-progress');
});

test('canRestore：已有 pending → restore-already-pending', () => {
  const r = canRestore(deps({ hasPendingRestore: () => true }));
  equal(r.ok, false);
  equal(r.code, 'restore-already-pending');
});

test('canStartUpdate：有 pending → restore-pending，否则放行', () => {
  const denied = canStartUpdate(deps({ hasPendingRestore: () => true }));
  equal(denied.ok, false);
  equal(denied.code, 'restore-pending');
  deepEqual(canStartUpdate(deps({ hasRunningExecutions: () => true })), { ok: true });
});

// ─────────────── hull:restart 门控矩阵（O3：pending 无/有 × 更新进行中） ───────────────

test('canRestart：无 pending → restore-source-invalid（防误用为通用重启）', () => {
  const r = canRestart(deps());
  equal(r.ok, false);
  equal(r.code, 'restore-source-invalid');
  // 即便有更新在途，无 pending 仍是「没有待执行的恢复」优先（不泄露更新态）
  const busy = canRestart(deps({ isHullUpdateActive: () => true, isSkillsUpgradeActive: () => true }));
  equal(busy.code, 'restore-source-invalid');
});

test('canRestart：pending + 全空闲 → 放行', () => {
  deepEqual(canRestart(deps({ hasPendingRestore: () => true })), { ok: true });
});

test('canRestart：pending + dsh 安装/升级 / Hull 自更新 / skills 升级 → update-in-progress', () => {
  const overrides = [
    { isInstallOrUpgradeActive: () => true },
    { isHullUpdateActive: () => true },
    { isSkillsUpgradeActive: () => true },
  ] as const;
  for (const over of overrides) {
    const r = canRestart(deps({ hasPendingRestore: () => true, ...over }));
    equal(r.ok, false);
    equal(r.code, 'update-in-progress');
  }
});

test('canRestart：pending + 执行中任务 → backup-busy（重启会中断执行）', () => {
  const r = canRestart(deps({ hasPendingRestore: () => true, hasRunningExecutions: () => true }));
  equal(r.ok, false);
  equal(r.code, 'backup-busy');
});
