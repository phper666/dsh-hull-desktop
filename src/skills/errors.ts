/**
 * Skills 具名错误集（S1 §SKILL_SCAN_ERROR + S2 §SKILLS_OP_ERROR，kebab 对齐 B1/B3 先例）
 */
import { HullError } from '../shared/errors';

export const SKILLS_ERRORS = {
  scanError: 'scan-error',
  remoteSearchFailed: 'remote-search-failed',
  remoteInstallFailed: 'remote-install-failed',
  validation: 'validation-error',
} as const;

/** S2 操作层错误码（feishu-s2-skills-api-contract §公共异常集，8 码） */
export const SKILLS_OP_ERRORS = {
  validation: 'validation-error',
  notFound: 'skills-not-found',
  conflict: 'skills-conflict',
  opInProgress: 'skills-op-in-progress',
  restoreConflict: 'restore-conflict',
  upgradeUndetectable: 'skills-upgrade-undetectable',
  upgradeFailed: 'skills-upgrade-failed',
  ioError: 'skills-io-error',
} as const;

/** 参数校验失败（searchRemote query 空 / 路径穿越 / 白名单外 / 状态类目错） */
export class SkillValidationError extends HullError {
  constructor(message: string, readonly field?: string) {
    super(SKILLS_ERRORS.validation, message);
  }
}

/** npx skills find 失败/超时/远端不可用（本地列表不受影响） */
export class RemoteSearchFailedError extends HullError {
  constructor(message: string) {
    super(SKILLS_ERRORS.remoteSearchFailed, message);
  }
}

/** npx skills add 安装失败/超时（仅远程安装路径） */
export class RemoteInstallFailedError extends HullError {
  constructor(message: string) {
    super(SKILLS_ERRORS.remoteInstallFailed, message);
  }
}

/** 扫描管线致命失败（userData 不可写/缓存损坏不可重建） */
export class ScanError extends HullError {
  constructor(message: string) {
    super(SKILLS_ERRORS.scanError, message);
  }
}

/** 目标路径不存在（已被外部删除/已移除） */
export class SkillsNotFoundError extends HullError {
  constructor(message: string) {
    super(SKILLS_OP_ERRORS.notFound, message);
  }
}

/** 写前 mtime 冲突（壳与 agent 同时操作，外部修改）——刷新后可重试 */
export class SkillsConflictError extends HullError {
  constructor(message: string) {
    super(SKILLS_OP_ERRORS.conflict, message);
  }
}

/** 同一物理路径已有写操作进行中（壳内单飞互斥） */
export class SkillsOpInProgressError extends HullError {
  constructor(message: string) {
    super(SKILLS_OP_ERRORS.opInProgress, message);
  }
}

/** 恢复/启用目标路径被占用——不覆盖 */
export class RestoreConflictError extends HullError {
  constructor(message: string, readonly targetPath: string) {
    super(SKILLS_OP_ERRORS.restoreConflict, message);
  }
}

/** 无 source+无 lock，远端哈希 unknown（Q-033）——升级入口禁用语义的主进程强制面 */
export class SkillsUpgradeUndetectableError extends HullError {
  constructor(message: string) {
    super(SKILLS_OP_ERRORS.upgradeUndetectable, message);
  }
}

/** 升级执行失败（已自动回滚） */
export class SkillsUpgradeFailedError extends HullError {
  constructor(
    message: string,
    readonly method?: string,
    readonly rolledBack = false
  ) {
    super(SKILLS_OP_ERRORS.upgradeFailed, message);
  }
}

/** fs 操作失败（权限不足/磁盘满/回滚也失败）——提示 open 手动处理不静默 */
export class SkillsIoError extends HullError {
  constructor(message: string) {
    super(SKILLS_OP_ERRORS.ioError, message);
  }
}
