/**
 * 具名错误集（W1 落地，设计 §3 shared/errors.ts）
 *
 * 错误码与契约 §接口详情 #1 异常清单一致：
 * start-timeout / spawn-failed / dsh-missing / child-exited。
 * 命名风格向 S2/S3 看齐：HullError 基类 + 具名子类。
 */

export class HullError extends Error {
  /** 机器可读错误码（契约值） */
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = new.target.name;
    this.code = code;
  }
}

/** 就绪判定超时（就绪行 60s 预算 / 探测 15s 窗口耗尽） */
export class StartTimeoutError extends HullError {
  constructor(message: string) {
    super('start-timeout', message);
  }
}

/** dsh 子进程 spawn 失败（含 node 解析器缺失/不可执行） */
export class SpawnFailedError extends HullError {
  constructor(message: string) {
    super('spawn-failed', message);
  }
}

/** overlay 目录缺失（<userData>/dsh，交 S2 首装） */
export class DshMissingError extends HullError {
  constructor(message: string) {
    super('dsh-missing', message);
  }
}

/** 子进程在 starting 阶段非预期退出（立即 failed，不等超时） */
export class ChildExitedError extends HullError {
  constructor(message: string) {
    super('child-exited', message);
  }
}
