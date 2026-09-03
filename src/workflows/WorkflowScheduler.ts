/**
 * 工作流定时调度器（v2）：为 enabled + cron 工作流武装 setTimeout，到点触发 WorkflowEngine.run。
 * 设计：docs/design/工作流-workflows-design.md §7.1
 * - reschedule(defs?) 全量重算（save/delete/启停/壳启动时调用）：清旧 timer → 每工作流武装一个。
 * - 超长 delay 分片：Node setTimeout 上限 2^31-1（约 24.8 天），超过按上限武装，到点未达目标分钟则继续分片。
 * - 错过策略 = 不补跑（skip missed）：休眠唤醒/漂移后由 cronNext(now) 重算未来。
 * - 触发 = engine.run(id)；引擎 per-workflow 互斥（手动/定时共用），抛错吞掉留日志，仍重排下次。
 */
import { cronNext } from './cron';
import type { WorkflowDef } from './types';

const MAX_TIMEOUT_MS = 2 ** 31 - 1;

export interface SchedulerDef {
  id: string;
  enabled: boolean;
  trigger?: WorkflowDef['trigger'];
}

export interface WorkflowSchedulerDeps {
  engine: { run(id: string, source?: 'manual' | 'cron'): Promise<unknown> };
  getDefs: () => SchedulerDef[];
  /** 调度日志（跳过/错误留痕，main 接 hull.log） */
  log?: (msg: string) => void;
  now?: () => Date;
  setTimer?: (fn: () => void, ms: number) => NodeJS.Timeout;
  clearTimer?: (t: NodeJS.Timeout) => void;
}

interface Armed {
  timer: NodeJS.Timeout;
  expr: string;
  at: number;
}

export class WorkflowScheduler {
  private readonly armed = new Map<string, Armed>();
  private readonly deps: Required<Pick<WorkflowSchedulerDeps, 'log' | 'now' | 'setTimer' | 'clearTimer'>> & WorkflowSchedulerDeps;

  constructor(deps: WorkflowSchedulerDeps) {
    this.deps = {
      ...deps,
      log: deps.log ?? ((m) => console.log(`[workflow-scheduler] ${m}`)),
      now: deps.now ?? (() => new Date()),
      setTimer: deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms)),
      clearTimer: deps.clearTimer ?? ((t) => clearTimeout(t)),
    };
  }

  /** 全量重算：清空旧 timer，为 enabled+cron 工作流重新武装（def 缺省时拉 getDefs） */
  reschedule(defs?: SchedulerDef[]): void {
    this.dispose();
    for (const def of defs ?? this.deps.getDefs()) {
      if (!def.enabled || def.trigger?.type !== 'cron') continue;
      this.arm(def.id, def.trigger.expr);
    }
  }

  /** 壳退出时清空全部 timer（before-quit 调用） */
  dispose(): void {
    for (const { timer } of this.armed.values()) this.deps.clearTimer(timer);
    this.armed.clear();
  }

  private arm(id: string, expr: string): void {
    const now = this.deps.now();
    let at: number;
    try {
      at = cronNext(expr, now).getTime();
    } catch (err) {
      this.deps.log(`工作流 ${id} cron 表达式非法，未排期: ${(err as Error).message}`);
      return;
    }
    this.armAt(id, expr, at);
  }

  private armAt(id: string, expr: string, at: number): void {
    const delay = Math.min(Math.max(at - this.deps.now().getTime(), 0), MAX_TIMEOUT_MS);
    const timer = this.deps.setTimer(() => this.fire(id, expr, at), delay);
    this.armed.set(id, { timer, expr, at });
  }

  private fire(id: string, expr: string, targetAt: number): void {
    this.armed.delete(id);
    const now = this.deps.now();
    // 对齐校验：目标分钟未到（超长 delay 分片到点 / setTimeout 漂移早触发）→ 不运行，继续武装
    if (now.getTime() < targetAt) {
      this.armAt(id, expr, targetAt);
      return;
    }
    // 触发（引擎互斥/停用等抛错吞掉），无论成败重排下次（错过不补跑）
    void this.deps.engine.run(id, 'cron').catch((err: unknown) => {
      this.deps.log(`定时触发工作流 ${id} 未执行: ${(err as Error).message}`);
    });
    this.arm(id, expr);
  }
}
