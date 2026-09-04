/**
 * B3 VerifyGate（B3 design §4.5/§4.7，CON-R028/Q-015 冻结）
 *
 * - confirmVerify（§4.5）：仅 columnId=verify 列可人工确认 → done 列；executionStatus
 *   保持 succeeded（双轨不改执行态）；非 verify 列 → ExecValidationError（validation-error）。
 *   双路径到 done：confirmVerify（把关通过）/ moveTask（人工拖拽强制通过）——本模块只管把关路径。
 * - manualComplete（契约 §5）：interrupted/failed → succeeded + 列→verify（仍走 Verify 把关，
 *   CON-R028 不绕过）；非 interrupted/failed → ExecNotCompletableError（exec-not-completable）。
 * - applyResult / applySelfCheck（§4.7 Q-015）：auto 判定——passed=true → succeeded + 列→verify
 *   （自动流转 CON-R029）；passed=false / 超时 / 异常 → failed（回写 failed 记录）。
 *   manual（无 selfCheck）→ 结果以评论回填 + 列流转手动（不自动推进，调用侧注入回填）。
 *
 * 约束（P2-1 + 任务约束）：store 只读消费；写经注入的 mutation 回调落库（B3 直调 B1 store
 * 系统管理字段写 + moveTask 语义，属 L3 引擎层）。
 */
import type { Board, Column, ExecutionStatus, Task } from '../kanban/types';
import { DONE_COLUMN_TYPE, VERIFY_COLUMN_TYPE } from './state-machine/transitions';
import { ExecNotCompletableError, ExecValidationError } from './errors';

/** 读面（store 只读消费的最小面） */
export interface VerifyGateReadStore {
  getBoard(boardId: string): Board;
}

/** 写面（引擎层注入：系统管理字段写 + 列流转 + system 事件） */
export interface VerifyGateMutations {
  /** 写执行态 + 补 finishedAt + 清 currentExecutionId + system 事件 */
  markSucceeded(taskId: string, reason: string, detail: string): void;
  /** 写执行态 failed + 补 finishedAt + 清 currentExecutionId + system 事件 + 回写 failed 记录 */
  markFailed(taskId: string, reason: string, detail: string): void;
  /** 列流转（B3 直调 store moveTask 语义：到 verify 列/到 done 列） */
  moveToColumn(taskId: string, columnId: string): void;
  /** manual 完成：结果以评论回填（agent 来源 Q-028 只读）+ system 事件（L3 注入） */
  fillManualResult(taskId: string, summary: string): void;
}

/** 执行结果判定入参（B3 契约 §ExecutionProvider ExecutionResult） */
export interface VerifyGateResult {
  /** 0=成功 */
  exitCode: number;
  /** 输出摘要 ≤4KB */
  summary: string;
  /** kanban/executions/e_<uuid>.log（相对路径） */
  outputPath: string;
  /** Q-015 自验判定信号 */
  selfCheck?: { passed: boolean; evidence?: string };
}

/** 列轨移动结果 */
export interface VerifyGateOutcome {
  taskId: string;
  executionStatus: ExecutionStatus;
  columnId: string | null;
}

/**
 * 列轨把关 + 手动完成 + selfCheck 判定（纯判定与只读消费；写经 mutations）。
 */
export class VerifyGate {
  private readonly store: VerifyGateReadStore;
  private readonly mutations: VerifyGateMutations;

  constructor(store: VerifyGateReadStore, mutations: VerifyGateMutations) {
    this.store = store;
    this.mutations = mutations;
  }

  /** 唯一模板列 id（type 匹配，默认回退 null——未找到把关失败） */
  private columnIdOf(board: Board, type: typeof VERIFY_COLUMN_TYPE | typeof DONE_COLUMN_TYPE): string | null {
    const col = board.columns.find((c: Column) => c.type === type);
    return col ? col.id : null;
  }

  /**
   * 人工确认完成（verify 列 → done 列）。仅 verify 列可确认，非 verify 列 → validation-error；
   * executionStatus 保持 succeeded（双轨不改执行态）。幂等：已 done 列 → 结果一致返回。
   */
  confirmVerify(boardId: string, taskId: string): VerifyGateOutcome {
    const board = this.store.getBoard(boardId);
    const task = board.tasks.find((t) => t.id === taskId);
    if (!task) throw new ExecValidationError('任务不存在（已删除）', 'taskId');
    const doneId = this.columnIdOf(board, DONE_COLUMN_TYPE);
    if (task.columnId === doneId) {
      // 幂等：已在 done 列 → 结果一致返回
      return { taskId, executionStatus: task.executionStatus, columnId: task.columnId };
    }
    const verifyId = this.columnIdOf(board, VERIFY_COLUMN_TYPE);
    if (task.columnId !== verifyId) {
      throw new ExecValidationError(`仅 verify 列任务可确认完成（当前列 ${task.columnId}）`, 'columnId');
    }
    if (!doneId) throw new ExecValidationError('看板无 done 模板列', 'boardId');
    this.mutations.moveToColumn(taskId, doneId);
    return { taskId, executionStatus: task.executionStatus, columnId: doneId };
  }

  /**
   * 手动完成（interrupted/failed → succeeded + 列→verify，CON-R028 仍走把关）。
   * 非 interrupted/failed → ExecNotCompletableError（exec-not-completable）。
   * 幂等：succeeded 再手动完成 → 结果一致返回。
   */
  manualComplete(boardId: string, taskId: string): VerifyGateOutcome {
    const board = this.store.getBoard(boardId);
    const task = board.tasks.find((t) => t.id === taskId);
    if (!task) throw new ExecValidationError('任务不存在（已删除）', 'taskId');
    if (task.executionStatus === 'succeeded') {
      // 幂等：已完成再手动完成 → 结果一致返回
      return { taskId, executionStatus: task.executionStatus, columnId: task.columnId };
    }
    if (task.executionStatus !== 'interrupted' && task.executionStatus !== 'failed') {
      throw new ExecNotCompletableError(`非 interrupted/failed 不可手动完成（当前 ${task.executionStatus}）`, task.executionStatus);
    }
    const verifyId = this.columnIdOf(board, VERIFY_COLUMN_TYPE);
    this.mutations.markSucceeded(taskId, '手动完成', 'manualComplete（CON-R028 把关不绕过）');
    if (verifyId) this.mutations.moveToColumn(taskId, verifyId);
    return { taskId, executionStatus: 'succeeded', columnId: verifyId };
  }

  /**
   * selfCheck 判定（§4.7 Q-015）：auto——passed=true → succeeded + 列→verify（自动流转）；
   * passed=false / 超时 / 异常 → failed。manual（无 selfCheck）→ 结果评论回填 +
   * 执行态置 succeeded（列不自动推进，CON-R029 结果手动放入，E15 不级联失败）。
   */
  applyResult(boardId: string, taskId: string, result: VerifyGateResult): VerifyGateOutcome {
    const board = this.store.getBoard(boardId);
    const task = board.tasks.find((t) => t.id === taskId);
    if (!task) throw new ExecValidationError('任务不存在（已删除）', 'taskId');

    // manual（无 selfCheck）：结果以评论回填 + 执行态 succeeded + 列不自动推进（CON-R029）
    // 🟡-1：结算为 succeeded（通道正常完成，非失败），依赖方按 succeeded 解锁、不触发 E15 级联。
    if (result.selfCheck === undefined) {
      this.mutations.fillManualResult(taskId, result.summary);
      this.mutations.markSucceeded(taskId, '执行完成', 'manual 结果回填（CON-R029 列不自动推进）');
      return { taskId, executionStatus: 'succeeded', columnId: task.columnId };
    }

    if (result.selfCheck.passed === true) {
      const verifyId = this.columnIdOf(board, VERIFY_COLUMN_TYPE);
      this.mutations.markSucceeded(taskId, '自验通过', 'selfCheck.passed=true（CON-R029 自动流转）');
      if (verifyId) this.mutations.moveToColumn(taskId, verifyId);
      return { taskId, executionStatus: 'succeeded', columnId: verifyId };
    }

    // passed=false / 超时（exitCode!=0 且 selfCheck passed=false）/ 异常 → failed
    const reason = result.exitCode === 0 ? '自验未通过' : '执行失败';
    // Q-020 失败可观测性：provider 真实失败原因（summary）并入 detail——settleTask →
    // setExecutionStatus 的 pushSystem（timeline content）与 maybeEmitExecutionNotif（通知 body）
    // 都消费 detail，此单点改动同时覆盖两条出口。此前 summary 全程被丢，timeline/通知只有
    // 通用「selfCheck.passed=false（Q-015）」，每轮排查都要读磁盘执行日志。
    // 空串/纯空白 → 保持现状文案；>500 字截断保可读（全文已在 execution 记录 selfCheck.evidence）。
    const trimmed = result.summary?.trim() ?? '';
    const detail = trimmed ? `selfCheck.passed=false（Q-015）：${truncateSummary(trimmed, 500)}` : 'selfCheck.passed=false（Q-015）';
    this.mutations.markFailed(taskId, reason, detail);
    return { taskId, executionStatus: 'failed', columnId: task.columnId };
  }
}

/** Q-020：失败摘要截断（>max 字符截断 + 标记，面向 timeline/通知可读性） */
function truncateSummary(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max)}…（截断）` : s;
}
