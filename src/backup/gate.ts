/**
 * B1/B4 门控（设计 §1.4 / §5）：纯函数 + deps 注入，主进程 handler 内强制调用。
 * v1.1（CON-R-backup-005）：skills 升级在途与 dsh/Hull 更新同列——备份/恢复/重启一律拒绝。
 */
import type { BackupErrorCode } from './errors';

export interface GateResult {
  ok: boolean;
  code?: BackupErrorCode;
  message?: string;
}

export interface GateDeps {
  /** 执行引擎 running/queued 任一非空（ExecutionEngine.getExecutionSnapshot） */
  hasRunningExecutions(): boolean;
  /** dsh 安装或升级进行中（InstallFlow / UpgradeQueue） */
  isInstallOrUpgradeActive(): boolean;
  /** skills 升级进行中（UpgradeExecutor 在途计数器 isSkillsUpgradeInFlight，CON-R-backup-005 v1.1） */
  isSkillsUpgradeActive(): boolean;
  /** Hull 自更新进行中（HullUpdater.snapshot().phase） */
  isHullUpdateActive(): boolean;
  /** `.restore/pending.json` 存在（result.readPending != null） */
  hasPendingRestore(): boolean;
}

const denied = (code: BackupErrorCode, message: string): GateResult => ({ ok: false, code, message });

export function canBackup(deps: GateDeps): GateResult {
  if (deps.hasRunningExecutions()) return denied('backup-busy', '有执行中或排队的任务，结束后再备份');
  if (deps.isInstallOrUpgradeActive()) return denied('backup-busy', 'dsh 安装或升级进行中，结束后再备份');
  if (deps.isSkillsUpgradeActive()) return denied('backup-busy', 'skills 升级进行中，结束后再备份');
  if (deps.isHullUpdateActive()) return denied('backup-busy', 'Hull 自更新进行中，结束后再备份');
  if (deps.hasPendingRestore()) return denied('restore-pending', '存在未完成的恢复，重启生效或先取消');
  return { ok: true };
}

export function canRestore(deps: GateDeps): GateResult {
  if (deps.isHullUpdateActive()) return denied('update-in-progress', 'Hull 自更新进行中，暂不能恢复');
  if (deps.isInstallOrUpgradeActive()) return denied('update-in-progress', 'dsh 安装或升级进行中，暂不能恢复');
  if (deps.isSkillsUpgradeActive()) return denied('update-in-progress', 'skills 升级进行中，暂不能恢复');
  if (deps.hasPendingRestore()) return denied('restore-already-pending', '已有待执行的恢复，重启生效或先取消');
  return { ok: true };
}

/** 更新器入口前置：有 pending 恢复时禁用 Hull/dsh 更新（CON-R-backup-007 互斥） */
export function canStartUpdate(deps: GateDeps): GateResult {
  if (deps.hasPendingRestore()) return denied('restore-pending', '存在未完成的恢复，先完成或取消后再更新');
  return { ok: true };
}

/**
 * `hull:restart` 前置（O3 定版）：pending 必须存在（防误用为通用重启），
 * 且与 canRestore 同一拒绝集（更新进行中）+ 无执行中/排队任务（重启会中断执行）。
 */
export function canRestart(deps: GateDeps): GateResult {
  if (!deps.hasPendingRestore()) return denied('restore-source-invalid', '没有待执行的恢复');
  if (deps.isHullUpdateActive()) return denied('update-in-progress', 'Hull 自更新进行中，暂不能重启');
  if (deps.isInstallOrUpgradeActive()) return denied('update-in-progress', 'dsh 安装或升级进行中，暂不能重启');
  if (deps.isSkillsUpgradeActive()) return denied('update-in-progress', 'skills 升级进行中，暂不能重启');
  if (deps.hasRunningExecutions()) return denied('backup-busy', '有执行中或排队的任务，结束后再重启');
  return { ok: true };
}
