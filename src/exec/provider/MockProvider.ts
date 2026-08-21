/**
 * B3 接口级内存桩（MockProvider，B3 契约 §两级 mock 桩 ①，冻结）
 *
 * - 实现 ExecutionProvider 接口：确定性事件注入（权限/超时/cancel/流式/selfCheck passed=false）
 * - 可控执行延迟（resolve 前 hold N ms，P2-B3-1）：保证并行上限用例（E13）在 ≤3 并发
 *   窗口内出现稳定 ≥2 峰值并发——mock 即时完成（0 延迟）会导致 5 子任务逐个瞬时完成、
 *   永远观察不到峰值 ≥2，用例假通过。
 * - HULL_EXEC_PROVIDER=mock 生效（仅 debug/test，判定在 ProviderManager L2）。
 */
import {
  type ExecutionEvent,
  type ExecutionHandlers,
  type ExecutionProvider,
  type ExecutionResult,
  type ExecutionTask,
  type ProviderStatus,
} from './ExecutionProvider';

export type MockOutcome =
  | { kind: 'success'; selfCheck: { passed: boolean; evidence?: string }; exitCode?: number }
  | { kind: 'permission'; events?: ExecutionEvent[] }
  | { kind: 'stream'; chunks: string[] }
  | { kind: 'timeout' }
  | { kind: 'cancel' };

export interface MockProviderOptions {
  /** 完成前 hold 毫秒（可控延迟，P2-B3-1；默认 0 即时完成） */
  delayMs?: number;
  /** 确定性事件注入（默认 success/selfCheck passed=true） */
  outcome?: MockOutcome;
  /** 流式事件发射间隔（stream 场景；默认 5ms） */
  streamIntervalMs?: number;
}

/**
 * 接口级内存桩：确定性事件注入 + 可控延迟。
 * 状态推进：onStatus('running') 同步 → delayMs 后按 outcome 回执。
 * cancel() 幂等：已 cancel 后完成事件不再触发（结果丢弃）。
 */
export class MockProvider implements ExecutionProvider {
  private readonly delayMs: number;
  private readonly outcome: MockOutcome;
  private readonly streamIntervalMs: number;
  private cancelled = false;

  constructor(options: MockProviderOptions = {}) {
    this.delayMs = options.delayMs ?? 0;
    this.outcome = options.outcome ?? { kind: 'success', selfCheck: { passed: true } };
    this.streamIntervalMs = options.streamIntervalMs ?? 5;
  }

  /** 注入配置只读暴露（测试断言用） */
  get spec(): { delayMs: number; outcome: MockOutcome } {
    return { delayMs: this.delayMs, outcome: this.outcome };
  }

  execute(task: ExecutionTask, handlers: ExecutionHandlers): { cancel(): Promise<void> } {
    // 调度就绪即 running（同步；L2 Scheduler 侧判定 provider 可执行）
    handlers.onStatus('running');
    const outcome = this.outcome;
    const cancelledRef: { v: boolean } = { v: false };

    // 确定性事件注入：先按 outcome 类型发射前置事件，再回执结果
    const run = async (): Promise<void> => {
      await sleep(this.delayMs);
      if (outcome.kind === 'stream') {
        for (const chunk of outcome.chunks) {
          if (cancelledRef.v) return;
          handlers.onEvent({ kind: 'text_chunk', text: chunk });
          await sleep(this.streamIntervalMs);
        }
      } else if (outcome.kind === 'permission') {
        for (const ev of outcome.events ?? []) {
          if (cancelledRef.v) return;
          handlers.onEvent(ev);
        }
      }
      if (cancelledRef.v) return;
      switch (outcome.kind) {
        case 'success':
          // mock kind='success' = 通道运行成功（exitCode 0）；selfCheck 数据原样回传——
          // passed=false→failed 是引擎 VerifyGate 判定（L2），非 mock 职责（通道侧状态≠任务执行态，Q-013）
          handlers.onResult(makeResult(0, outcome.selfCheck));
          handlers.onStatus('succeeded');
          break;
        case 'permission':
          handlers.onResult(makeResult(0, { passed: true }));
          handlers.onStatus('succeeded');
          break;
        case 'stream':
          handlers.onResult(makeResult(0, { passed: true }));
          handlers.onStatus('succeeded');
          break;
        case 'timeout':
          // 超时=疑似卡死：failed + 非 0 exitCode（心跳超时语义，L3 Heartbeat 用）
          handlers.onResult(makeResult(1, { passed: false }));
          handlers.onStatus('failed');
          break;
        case 'cancel':
          // 被取消：无结果回执（结果丢弃），通道态 cancelled
          handlers.onStatus('cancelled');
          break;
      }
    };
    void run();

    return {
      cancel: async () => {
        this.cancelled = true;
        cancelledRef.v = true;
      },
    };
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function makeResult(exitCode: number, selfCheck: ExecutionResult['selfCheck']): ExecutionResult {
  return { exitCode, summary: `mock 执行完成 exit=${exitCode}`, outputPath: '', selfCheck };
}
