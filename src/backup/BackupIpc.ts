/**
 * B4 备份/恢复 IPC 注册（设计 §1.6 / §5.2；契约 feishu-backup-api-contract §1~§3）：
 *   4 channel：hull:backup / hull:restore / hull:getBackupStatus / hull:restart（通道常量在 src/shared/ipc-channels.ts）。
 *   - 统一返回 { ok:true, data } | { ok:false, code, message }（BackupError 码透传，未知错误按 handler 语义兜底）
 *   - targetDir / sourceDir 生产一律走原生目录选择（主进程注入 pickDirectory）；仅 HULL_E2E=1 接受显式入参（CON-R-backup-009/014）
 *   - 主进程强制门控：backup → canBackup；restore(request) → canRestore（渲染层禁用只是 UX，CON-R-backup-005）
 *   - hull:restart 安全约束：canRestart（pending 必须存在 + 无更新进行中 + 无执行中任务，防误用为通用重启）；
 *     重启走 main 注入的 restartApp（复用退出编排：quitting 标记/runtime 收尾/updater in-flight await → relaunch+exit），
 *     不在本文件裸调 app.relaunch/app.exit
 *   - 注册见 src/main/index.ts bootstrap（服务就绪后）
 */
import { ipcMain } from 'electron';

import type { BackupService } from './backupService';
import { BackupError } from './errors';
import { canBackup, canRestore, canRestart, type GateDeps, type GateResult } from './gate';
import type { RestoreResult } from './result';
import type { RestoreService } from './restoreService';

/** 4 通道常量唯一事实源在 src/shared/ipc-channels.ts（BACKUP_IPC_CHANNELS）；此处转出供主进程注册面消费 */
export { BACKUP_IPC_CHANNELS } from '../shared/ipc-channels';

/** 契约统一响应包裹（BackupIpcResult 联合；code 为 kebab 错误码） */
export type BackupIpcResult<T> = { ok: true; data: T } | { ok: false; code: string; message: string };

/** 待恢复标记摘要（BackupStatus.pending；完整 PendingFile 见 result.ts） */
export interface PendingSummary {
  mode: 'replace' | 'merge';
  sourceDir: string;
  createdAt: string;
}

/** 契约 §BackupStatus（数据区块初始化/刷新；lastBackupDir 由渲染层自持久化，主进程恒 null） */
export interface BackupStatus {
  canBackup: GateResult;
  canRestore: GateResult;
  pending: PendingSummary | null;
  lastResult: RestoreResult | null;
  lastBackupDir: string | null;
  restoreBackupDir: string | null;
}

export interface BackupIpcDeps {
  backupService: BackupService;
  restoreService: RestoreService;
  /** 门控 deps（handler 内强制 canBackup/canRestore，设计 §5.2） */
  gate: GateDeps;
  /** 状态组装（主进程持有 gateDeps/readPending/readResult，见 main buildBackupStatus） */
  status(): BackupStatus;
  /** 生产目录选择（父窗口 dialog；取消 → null）。E2E 显式入参经 resolveDir 短路，不调用 */
  pickDirectory(title: string): Promise<string | null>;
  /**
   * 重启执行恢复（O3 定版）：main 注入 = 复用退出编排（quitting 标记/runtime 收尾/updater in-flight await）
   * 收尾后 app.relaunch() + app.exit(0)；本文件不直接触碰 Electron app 生命周期
   */
  restartApp(): void;
}

/** 显式目录入参仅 HULL_E2E=1 接受；生产忽略并弹选择器（CON-R-backup-009/014） */
async function resolveDir(explicit: unknown, title: string, pick: BackupIpcDeps['pickDirectory']): Promise<string | null> {
  if (process.env.HULL_E2E === '1' && typeof explicit === 'string' && explicit.length > 0) return explicit;
  return pick(title);
}

function fail(err: unknown, fallbackCode: string): BackupIpcResult<never> {
  const code = err instanceof BackupError ? err.code : fallbackCode;
  return { ok: false, code, message: err instanceof Error ? err.message : String(err) };
}

/** 清理旧备份保留数量（v1 数据卡未暴露 keep 入参；契约未定义 data 形状，返回 { removed }） */
const CLEANUP_KEEP = 3;

export function registerBackupIpc(deps: BackupIpcDeps): void {
  // hull:backup：{ action?: 'run'|'cleanup', targetDir? }
  ipcMain.handle('hull:backup', async (_e, payload?: { action?: 'run' | 'cleanup'; targetDir?: unknown }) => {
    const action = payload?.action ?? 'run';
    try {
      const gate = canBackup(deps.gate);
      if (!gate.ok) return { ok: false, code: gate.code, message: gate.message } as BackupIpcResult<never>;

      if (action === 'cleanup') {
        const parentDir = await resolveDir(payload?.targetDir, '选择要清理旧备份的目录', deps.pickDirectory);
        if (!parentDir) return { ok: false, code: 'backup-failed', message: '未选择目录（已取消）' };
        const removed = deps.backupService.cleanupOrphans(parentDir, CLEANUP_KEEP);
        return { ok: true, data: { removed } };
      }

      const targetDir = await resolveDir(payload?.targetDir, '选择备份目标目录', deps.pickDirectory);
      if (!targetDir) return { ok: false, code: 'backup-failed', message: '未选择备份目录（已取消）' };
      const r = await deps.backupService.run({ targetDir });
      return {
        ok: true,
        data: { backupDir: r.backupDir, items: r.manifest.items.map((i) => i.id), bytes: r.manifest.counts.bytes },
      };
    } catch (err) {
      return fail(err, 'backup-failed');
    }
  });

  // hull:restore：{ action?: 'request'|'cancel', mode?, sourceDir? }
  ipcMain.handle(
    'hull:restore',
    async (_e, payload?: { action?: 'request' | 'cancel'; mode?: unknown; sourceDir?: unknown }) => {
      const action = payload?.action ?? 'request';
      try {
        if (action === 'cancel') {
          // cancel 幂等：无标记 → { ok:true, cancelled:false }（契约 §2 幂等与并发）
          return { ok: true, data: { cancelled: deps.restoreService.cancel() } };
        }
        const mode = payload?.mode;
        if (mode !== 'replace' && mode !== 'merge') {
          return {
            ok: false,
            code: 'restore-source-invalid',
            message: '恢复模式无效（replace/merge）',
          } as BackupIpcResult<never>;
        }
        const gate = canRestore(deps.gate);
        if (!gate.ok) return { ok: false, code: gate.code, message: gate.message } as BackupIpcResult<never>;

        const sourceDir = await resolveDir(payload?.sourceDir, '选择备份包目录', deps.pickDirectory);
        if (!sourceDir) return { ok: false, code: 'restore-source-invalid', message: '未选择备份包目录（已取消）' };
        const r = await deps.restoreService.request({ sourceDir, mode });
        return { ok: true, data: { restartRequired: true, preview: r.preview } };
      } catch (err) {
        return fail(err, 'io-error');
      }
    }
  );

  // hull:getBackupStatus：{} → BackupStatus（只读；异常 → io-error 不阻塞）
  ipcMain.handle('hull:getBackupStatus', () => {
    try {
      return { ok: true, data: deps.status() };
    } catch (err) {
      return fail(err, 'io-error');
    }
  });

  // hull:restart：canRestart 前置（pending 必须存在 + 无 dsh/skills 更新 + 无 Hull 自更新 + 无执行中任务）；
  // 通过后交 main 的 restartApp 走既有退出编排（先回 IPC 响应，编排收尾后 relaunch+exit）
  ipcMain.handle('hull:restart', async () => {
    try {
      const gate = canRestart(deps.gate);
      if (!gate.ok) return { ok: false, code: gate.code, message: gate.message } as BackupIpcResult<never>;
      deps.restartApp();
      return { ok: true, data: { restarted: true } };
    } catch (err) {
      return fail(err, 'io-error');
    }
  });
}
