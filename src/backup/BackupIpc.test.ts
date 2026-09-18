/**
 * BackupIpc handler 单测（node:test；createBackupHandlers 纯函数工厂，不需要 Electron 运行时）：
 * 覆盖 4 handler 的门控拒绝 / payload 校验 / E2E 显式路径门控 / 错误码映射 / restart 调用。
 * registerBackupIpc（ipcMain 薄壳）与 main 装配不在本文件覆盖范围。
 */
import { deepEqual, equal, ok } from 'node:assert/strict';
import { test } from 'node:test';

import {
  createBackupHandlers,
  type BackupHandlerPayload,
  type BackupIpcDeps,
  type BackupIpcResult,
  type BackupStatus,
} from './BackupIpc';
import type { BackupResult, BackupService } from './backupService';
import { BackupError } from './errors';
import type { GateDeps } from './gate';
import type { PendingFile } from './result';
import type { RestorePreview, RestoreService } from './restoreService';

function gateDeps(over: Partial<GateDeps> = {}): GateDeps {
  return {
    hasRunningExecutions: () => false,
    isInstallOrUpgradeActive: () => false,
    isSkillsUpgradeActive: () => false,
    isHullUpdateActive: () => false,
    hasPendingRestore: () => false,
    ...over,
  };
}

const STATUS: BackupStatus = {
  canBackup: { ok: true },
  canRestore: { ok: true },
  pending: null,
  lastResult: null,
  lastBackupDir: null,
  restoreBackupDir: null,
};

const RUN_RESULT = {
  backupDir: '/bak/Hull备份-2026',
  manifest: { items: [{ id: 'settings' }, { id: 'kanban' }], counts: { bytes: 42 } },
} as unknown as BackupResult;

const PREVIEW = { mode: 'replace', warnings: [] } as unknown as RestorePreview;

interface Calls {
  pick: string[];
  run: Array<{ targetDir: string }>;
  cleanup: Array<{ parentDir: string; keep: number }>;
  request: Array<{ sourceDir: string; mode: 'replace' | 'merge' }>;
  cancel: number;
  restart: number;
}

interface HarnessOpts {
  isE2E?: boolean;
  gate?: Partial<GateDeps>;
  pick?: string | null | (() => Promise<string | null>);
  runError?: unknown;
  cleanupRemoved?: number;
  requestError?: unknown;
  cancelResult?: boolean;
  status?: () => BackupStatus;
  restartError?: unknown;
}

function harness(o: HarnessOpts = {}) {
  const calls: Calls = { pick: [], run: [], cleanup: [], request: [], cancel: 0, restart: 0 };
  const deps: BackupIpcDeps = {
    backupService: {
      run: async (input: { targetDir: string }) => {
        calls.run.push(input);
        if (o.runError !== undefined) throw o.runError;
        return RUN_RESULT;
      },
      cleanupOrphans: (parentDir: string, keep: number) => {
        calls.cleanup.push({ parentDir, keep });
        return o.cleanupRemoved ?? 0;
      },
    } as unknown as BackupService,
    restoreService: {
      request: async (input: { sourceDir: string; mode: 'replace' | 'merge' }) => {
        calls.request.push(input);
        if (o.requestError !== undefined) throw o.requestError;
        return { pending: {} as PendingFile, preview: PREVIEW };
      },
      cancel: () => {
        calls.cancel += 1;
        return o.cancelResult ?? false;
      },
    } as unknown as RestoreService,
    gate: gateDeps(o.gate),
    status: () => {
      if (o.status) return o.status();
      return STATUS;
    },
    pickDirectory: async (title: string) => {
      calls.pick.push(title);
      if (typeof o.pick === 'function') return o.pick();
      return o.pick === undefined ? null : o.pick;
    },
    restartApp: () => {
      calls.restart += 1;
      if (o.restartError !== undefined) throw o.restartError;
    },
    isE2E: o.isE2E ?? false,
  };
  return { deps, calls, h: createBackupHandlers(deps) };
}

/** 断言失败响应并取回 code/message（判别联合收窄） */
function denied(r: BackupIpcResult<unknown>): { code: string; message: string } {
  ok(!r.ok, `expected failure, got ok: ${JSON.stringify(r)}`);
  return r;
}

// ─────────────────────────── hull:backup ───────────────────────────

test('backup：门控不通过 → backup-busy，不弹目录不执行服务', async () => {
  const { calls, h } = harness({ gate: { hasRunningExecutions: () => true } });
  const f = denied(await h.backup({ action: 'run' }));
  equal(f.code, 'backup-busy');
  equal(calls.pick.length, 0);
  equal(calls.run.length, 0);
});

test('backup：E2E=false 且无 targetDir → 走 pickDirectory 注入并按其结果执行', async () => {
  const { calls, h } = harness({ isE2E: false, pick: '/picked/bak' });
  const r = await h.backup();
  deepEqual(r, {
    ok: true,
    data: { backupDir: '/bak/Hull备份-2026', items: ['settings', 'kanban'], bytes: 42 },
  });
  deepEqual(calls.pick, ['选择备份目标目录']);
  deepEqual(calls.run, [{ targetDir: '/picked/bak' }]);
});

test('backup：E2E=false 时显式 targetDir 被忽略（生产语义）', async () => {
  const { calls, h } = harness({ isE2E: false, pick: '/picked/bak' });
  ok((await h.backup({ action: 'run', targetDir: '/explicit/bak' })).ok);
  deepEqual(calls.run, [{ targetDir: '/picked/bak' }]);
});

test('backup：E2E=true 且显式 targetDir → 直通不弹目录', async () => {
  const { calls, h } = harness({ isE2E: true, pick: '/picked/bak' });
  ok((await h.backup({ action: 'run', targetDir: '/explicit/bak' })).ok);
  equal(calls.pick.length, 0);
  deepEqual(calls.run, [{ targetDir: '/explicit/bak' }]);
});

test('backup：取消目录选择 → backup-failed（run 不执行）', async () => {
  const { calls, h } = harness({ pick: null });
  const f = denied(await h.backup());
  equal(f.code, 'backup-failed');
  equal(f.message, '未选择备份目录（已取消）');
  equal(calls.run.length, 0);
});

test('backup：服务抛 BackupError → code/message 透传', async () => {
  const { h } = harness({ isE2E: true, runError: new BackupError('backup-target-unwritable', '目标不可写') });
  const f = denied(await h.backup({ targetDir: '/x' }));
  equal(f.code, 'backup-target-unwritable');
  equal(f.message, '目标不可写');
});

test('backup：服务抛非 BackupError → backup-failed 兜底', async () => {
  const { h } = harness({ isE2E: true, runError: new Error('disk full') });
  const f = denied(await h.backup({ targetDir: '/x' }));
  equal(f.code, 'backup-failed');
  equal(f.message, 'disk full');
});

test('backup：action=cleanup → cleanupOrphans(parentDir, keep=3) 并返回 removed', async () => {
  const { calls, h } = harness({ isE2E: true, cleanupRemoved: 2 });
  deepEqual(await h.backup({ action: 'cleanup', targetDir: '/old' }), { ok: true, data: { removed: 2 } });
  deepEqual(calls.cleanup, [{ parentDir: '/old', keep: 3 }]);
  equal(calls.run.length, 0);
});

test('backup：cleanup 取消目录选择 → backup-failed（cleanupOrphans 不调用）', async () => {
  const { calls, h } = harness({ pick: null });
  const f = denied(await h.backup({ action: 'cleanup' }));
  equal(f.code, 'backup-failed');
  equal(f.message, '未选择目录（已取消）');
  equal(calls.cleanup.length, 0);
});

test('backup：payload 防御——未知 action / 非对象 payload 均按 run 处理', async () => {
  const a = harness({ isE2E: true });
  ok((await a.h.backup({ action: 'bogus' as 'run', targetDir: '/x' })).ok);
  deepEqual(a.calls.run, [{ targetDir: '/x' }]);
  const b = harness({ isE2E: true });
  equal((await b.h.backup('oops' as unknown as BackupHandlerPayload)).ok, false); // 非对象 → 无 targetDir → 未选目录
  equal(b.calls.run.length, 0);
});

// ─────────────────────────── hull:restore ───────────────────────────

test('restore：mode 缺失/非法 → restore-source-invalid（门控/目录/服务均不触达）', async () => {
  for (const mode of [undefined, 'full', 42]) {
    const { calls, h } = harness({ gate: { isHullUpdateActive: () => true } });
    const f = denied(await h.restore({ mode }));
    equal(f.code, 'restore-source-invalid');
    equal(calls.pick.length, 0);
    equal(calls.request.length, 0);
  }
});

test('restore：canRestore 拒绝 → update-in-progress', async () => {
  const { calls, h } = harness({ gate: { isHullUpdateActive: () => true } });
  const f = denied(await h.restore({ mode: 'replace' }));
  equal(f.code, 'update-in-progress');
  equal(calls.pick.length, 0);
});

test('restore：canRestore 拒绝 → restore-already-pending', async () => {
  const { h } = harness({ gate: { hasPendingRestore: () => true } });
  const f = denied(await h.restore({ mode: 'merge' }));
  equal(f.code, 'restore-already-pending');
});

test('restore：E2E=true 显式 sourceDir → request 成功 shape（restartRequired + preview）', async () => {
  const { calls, h } = harness({ isE2E: true });
  const r = await h.restore({ action: 'request', mode: 'merge', sourceDir: '/bak/pkg' });
  deepEqual(r, { ok: true, data: { restartRequired: true, preview: PREVIEW } });
  deepEqual(calls.request, [{ sourceDir: '/bak/pkg', mode: 'merge' }]);
  equal(calls.pick.length, 0);
});

test('restore：E2E=false 无 sourceDir → pickDirectory 结果作为 sourceDir', async () => {
  const { calls, h } = harness({ pick: '/picked/pkg' });
  const r = await h.restore({ mode: 'replace' });
  deepEqual(r, { ok: true, data: { restartRequired: true, preview: PREVIEW } });
  deepEqual(calls.pick, ['选择备份包目录']);
  deepEqual(calls.request, [{ sourceDir: '/picked/pkg', mode: 'replace' }]);
});

test('restore：取消目录选择 → restore-source-invalid', async () => {
  const { calls, h } = harness({ pick: null });
  const f = denied(await h.restore({ mode: 'replace' }));
  equal(f.code, 'restore-source-invalid');
  equal(calls.request.length, 0);
});

test('restore：cancel 幂等（有/无 pending 均 ok，不触达目录与服务 request）', async () => {
  const yes = harness({ cancelResult: true, pick: null });
  deepEqual(await yes.h.restore({ action: 'cancel' }), { ok: true, data: { cancelled: true } });
  equal(yes.calls.pick.length, 0);
  const no = harness({ cancelResult: false });
  deepEqual(await no.h.restore({ action: 'cancel' }), { ok: true, data: { cancelled: false } });
});

test('restore：request 抛 BackupError → code/message 透传', async () => {
  const { h } = harness({ isE2E: true, requestError: new BackupError('restore-manifest-missing', '缺 manifest') });
  const f = denied(await h.restore({ mode: 'replace', sourceDir: '/x' }));
  equal(f.code, 'restore-manifest-missing');
  equal(f.message, '缺 manifest');
});

test('restore：request 抛非 BackupError → io-error 兜底', async () => {
  const { h } = harness({ isE2E: true, requestError: 'boom' });
  const f = denied(await h.restore({ mode: 'replace', sourceDir: '/x' }));
  equal(f.code, 'io-error');
  equal(f.message, 'boom');
});

test('restore：payload 防御——未知 action 按 request 处理', async () => {
  const { calls, h } = harness({ isE2E: true });
  ok((await h.restore({ action: 'bogus' as 'request', mode: 'replace', sourceDir: '/x' })).ok);
  deepEqual(calls.request, [{ sourceDir: '/x', mode: 'replace' }]);
});

// ─────────────────────── hull:getBackupStatus ───────────────────────

test('getBackupStatus：透传 status()', async () => {
  const { h } = harness();
  deepEqual(await h.getBackupStatus(), { ok: true, data: STATUS });
});

test('getBackupStatus：status() 抛错 → io-error（BackupError 亦映射其 code）', async () => {
  const generic = harness({
    status: () => {
      throw new Error('read failed');
    },
  });
  const f = denied(await generic.h.getBackupStatus());
  equal(f.code, 'io-error');
  equal(f.message, 'read failed');

  const known = harness({
    status: () => {
      throw new BackupError('io-error', 'pending 损坏');
    },
  });
  const g = denied(await known.h.getBackupStatus());
  equal(g.code, 'io-error');
  equal(g.message, 'pending 损坏');
});

// ─────────────────────────── hull:restart ───────────────────────────

test('restart：无 pending → restore-source-invalid，restartApp 不调用', async () => {
  const { calls, h } = harness();
  const f = denied(await h.restart());
  equal(f.code, 'restore-source-invalid');
  equal(calls.restart, 0);
});

test('restart：有 pending 但更新进行中 → update-in-progress', async () => {
  for (const gate of [
    { isHullUpdateActive: () => true },
    { isInstallOrUpgradeActive: () => true },
    { isSkillsUpgradeActive: () => true },
  ] as const) {
    const { calls, h } = harness({ gate: { hasPendingRestore: () => true, ...gate } });
    const f = denied(await h.restart());
    equal(f.code, 'update-in-progress');
    equal(calls.restart, 0);
  }
});

test('restart：有 pending 但有执行中任务 → backup-busy', async () => {
  const { calls, h } = harness({ gate: { hasPendingRestore: () => true, hasRunningExecutions: () => true } });
  const f = denied(await h.restart());
  equal(f.code, 'backup-busy');
  equal(calls.restart, 0);
});

test('restart：门控通过 → restartApp 恰调用一次 + { restarted:true }', async () => {
  const { calls, h } = harness({ gate: { hasPendingRestore: () => true } });
  deepEqual(await h.restart(), { ok: true, data: { restarted: true } });
  equal(calls.restart, 1);
});

test('restart：restartApp 抛错 → io-error', async () => {
  const { h } = harness({ gate: { hasPendingRestore: () => true }, restartError: new Error('quit failed') });
  const f = denied(await h.restart());
  equal(f.code, 'io-error');
  equal(f.message, 'quit failed');
});
