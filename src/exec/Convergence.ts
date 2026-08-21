/**
 * B3 壳重启收敛（B3 design §4.4，Q-017 冻结）
 *
 * Convergence.run() 在 KanbanStore 加载完成后、IPC 就绪前执行（防 UI 读到未收敛态）：
 *   1. running/paused/interrupted → failed（"壳重启进程中断"）+ 补 finishedAt +
 *      清 currentExecutionId + system 事件
 *   2. queued → 重跑就绪检查：依赖已收敛 failed → 转 failed（"依赖失败"）；
 *      仍满足 → 保留重调度 + system 事件"已重新排队"
 *   3. 全量收敛后 → 统一触发依赖重算（Scheduler 重算父卡派生态）
 *
 * 幂等：重复收敛对已 failed 任务无操作。
 *
 * 约束（P2-1 + 任务约束）：store 依赖构造入参注入；store 只读消费——执行态/列/依赖
 * 字段经注入的 mutation 回调落库（B3 直调 B1 store 的系统管理字段写，属 L3 引擎层）。
 */
import type { Board, ExecutionStatus, Task } from '../kanban/types';

/** 收敛过程对外可见的数据写操作（引擎层注入：B3 直调 B1 store 系统管理字段写 + system 事件） */
export interface ConvergenceMutations {
  /** 写执行态 + 补 finishedAt + 清 currentExecutionId + system 事件（一次原子语义） */
  markFailed(taskId: string, reason: string, detail: string): void;
  /** 保留 queued 重调度 + system 事件"已重新排队" */
  keepQueued(taskId: string): void;
}

/** 收敛结果报告（供 Scheduler 全量依赖重算） */
export interface ConvergenceReport {
  failed: string[];
  requeued: string[];
  recomputeDeps: boolean;
}

/** 读面（store 只读消费的最小面） */
export interface ConvergenceReadStore {
  getBoards(): Board[];
}

/**
 * 壳重启收敛。运行期不抛错（个别任务缺字段跳过，收敛要幂等可靠）。
 */
export class Convergence {
  private readonly store: ConvergenceReadStore;
  private readonly mutations: ConvergenceMutations;

  constructor(store: ConvergenceReadStore, mutations: ConvergenceMutations) {
    this.store = store;
    this.mutations = mutations;
  }

  run(): ConvergenceReport {
    const failed: string[] = [];
    const requeued: string[] = [];

    for (const board of this.store.getBoards()) {
      for (const task of board.tasks) {
        // 已收敛目标态幂等跳过
        if (task.executionStatus === 'failed' || task.executionStatus === 'succeeded') continue;
        // 收敛面：仅壳重启残留态/待重排态（cancelled/idle 非进程中断残留，跳过）
        if (task.executionStatus === 'running' || task.executionStatus === 'paused' || task.executionStatus === 'interrupted') {
          this.mutations.markFailed(task.id, '壳重启进程中断', '壳重启收敛（Q-017）');
          failed.push(task.id);
          continue;
        }
        if (task.executionStatus === 'queued') {
          // 重跑就绪检查：依赖已收敛 failed → 转 failed（"依赖失败"）；仍满足 → 保留重调度
          if (this.dependencyBlocked(board, task)) {
            this.mutations.markFailed(task.id, '依赖失败', `依赖已收敛 failed: ${task.dependencies.join(',')}`);
            failed.push(task.id);
          } else {
            this.mutations.keepQueued(task.id);
            requeued.push(task.id);
          }
        }
      }
    }

    // 全量收敛后统一触发依赖重算（父卡派生态由 Scheduler 重算）
    return { failed, requeued, recomputeDeps: failed.length > 0 || requeued.length > 0 };
  }

  /** 依赖判据（契约 §并行调度 + E19）：任一依赖 failed → 阻断（succeeded 满足；其余依赖态保留重排） */
  private dependencyBlocked(board: Board, task: Task): boolean {
    return task.dependencies.some((depId) => {
      const dep = board.tasks.find((t) => t.id === depId);
      return dep ? dep.executionStatus === 'failed' : false;
    });
  }
}

export type { ExecutionStatus };
