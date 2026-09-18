/**
 * B1 备份错误码与错误类型（设计 §1.3）。
 * 全部 kebab（CON-R-backup-015）；B1 实际产生 backup-busy / backup-target-* / backup-failed / io-error，
 * 其余码为 B2/B4 预留（同一联合类型跨 lane 冻结）。
 */

export type BackupErrorCode =
  // 备份（B1）
  | 'backup-busy' | 'backup-target-unwritable' | 'backup-target-inside-userdata'
  | 'backup-failed' | 'io-error'
  // 恢复：运行期（B2）
  | 'restore-source-invalid' | 'restore-manifest-missing' | 'restore-manifest-invalid'
  | 'restore-version-newer' | 'restore-version-too-old'
  | 'restore-migrate-preview-failed' | 'restore-already-pending' | 'restore-busy'
  // 恢复：启动期（B2）
  | 'restore-source-missing' | 'restore-apply-failed' | 'restore-verify-failed'
  | 'restore-rolled-back' | 'restore-manual-required'
  // 互斥（B4）
  | 'update-in-progress' | 'restore-pending';

export class BackupError extends Error {
  readonly code: BackupErrorCode;

  constructor(code: BackupErrorCode, message: string) {
    super(message);
    this.name = 'BackupError';
    this.code = code;
  }
}
