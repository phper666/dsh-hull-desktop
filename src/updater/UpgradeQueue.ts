import { EventEmitter } from 'node:events';

export interface UpgradeQueueInFlight {
  channel: string | null;
}

/**
 * 双通道互斥单槽队列（S3 设计 D8 / 契约 #5，S5 HullUpdater 复用）：
 * in-memory 单槽锁（S1 单实例锁保证仅一个壳进程，无跨进程需求）；
 * acquire 失败 = queue-busy 语义（T3-07）；release 仅占用者有效，无占用/非占用者释放无害。
 * changed 事件：acquire/release 时广播——托盘 busy 禁用依赖 inFlight 快照，
 * 而升级状态机的 Idle 迁移事件在 release 之前发出（e2e E2E-06 暴露：不订阅则升级完成后菜单永久禁用）。
 */
export class UpgradeQueue extends EventEmitter {
  private holder: string | null = null;

  /** 占用成功 → true；已占用（任意通道）→ false = queue-busy */
  acquire(channel: string): boolean {
    if (this.holder !== null) return false;
    this.holder = channel;
    this.emit('changed');
    return true;
  }

  /** 仅占用者释放；无占用/非占用者 → 无害 */
  release(channel: string): void {
    if (this.holder === channel) {
      this.holder = null;
      this.emit('changed');
    }
  }

  inFlight(): UpgradeQueueInFlight {
    return { channel: this.holder };
  }

  /** 队列状态变化（acquire/release）通知（托盘 busy 刷新数据源） */
  on(event: 'changed', listener: () => void): this;
  on(event: string | symbol, listener: (...args: any[]) => void): this {
    return super.on(event, listener);
  }
}
