import { HullError } from '../shared/errors';
import { InstallPhase, type InstallSnapshot } from '../shared/types';
import { OverlayManager } from '../overlay/OverlayManager';

/** S3 升级错误语义码（契约 UPGRADE_ERRORS 六码 + 内部码） */
export const UPGRADE_ERRORS = {
  checkFailed: 'check-failed',
  versionInvalid: 'version-invalid',
  installFailed: 'install-failed',
  verifyFailed: 'verify-failed',
  swapBroken: 'swap-broken',
  queueBusy: 'queue-busy',
  /** 内部语义码（非契约六码） */
  cancelled: 'cancelled',
  rollbackUnavailable: 'rollback-unavailable',
  /** 内部语义码（非契约六码；🟡-1）：swap 失败但 S2 已内部回滚（phase Ready）——与用户主动取消区分，防 S6 UI 误导 */
  swapRecovered: 'swap-recovered',
} as const;
export type UpgradeErrorCode = (typeof UPGRADE_ERRORS)[keyof typeof UPGRADE_ERRORS];

/**
 * SwapManager（S3 设计 D2/B13 纯映射薄层）：
 * - 一行委托 OverlayManager.swap()/swapBack()——不承载验证/回滚决策（决策在 Updater 状态机）
 * - B6 错误码域映射：先读 overlay phase——Ready（已回滚）→「已回滚原版可用」非 swap-broken；
 *   非 Ready → swap-broken；cancelled/version-invalid 透传
 * - canRollback()：overlay 侧 previous 存在性委托
 * - 保留理由注记：契约 #6 接口兼容面；S5 复用面 = UpgradeQueue 而非本类
 */
export class SwapManager {
  private readonly overlay: OverlayManager;

  constructor(overlay: OverlayManager) {
    this.overlay = overlay;
  }

  /** 一行委托 + B6 错误码域映射 */
  async swap(): Promise<InstallSnapshot> {
    try {
      return await this.overlay.swap();
    } catch (err) {
      const original = err instanceof HullError ? err : new HullError(UPGRADE_ERRORS.swapBroken, (err as Error).message);
      if (original.code === UPGRADE_ERRORS.cancelled || original.code === 'version-invalid') {
        throw original; // 取消/中止、版本非法透传
      }
      // B6：先读 overlay phase——Ready（S2 已内部回滚）→ swap-recovered（🟡-1：非 cancelled，与用户取消区分）
      if (this.overlay.installStatus().phase === InstallPhase.Ready) {
        throw new HullError(UPGRADE_ERRORS.swapRecovered, `替换中止，已回滚原版可用: ${original.message}`);
      }
      throw new HullError(UPGRADE_ERRORS.swapBroken, original.message);
    }
  }

  /** 回滚反向原语委托（S2 契约 #10） */
  swapBack(): Promise<InstallSnapshot> {
    return this.overlay.swapBack();
  }

  /** previous 存在性（W3 前置；rollback-unavailable 避免） */
  canRollback(): boolean {
    return this.overlay.canRollback();
  }
}
