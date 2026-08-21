/**
 * AcEditor（B4 AC 修订入口，design §4.5 / 契约 §3，CON-R021/Q-022）——full 实现
 *
 * P2-B4-3 状态分流（按 executionStatus）：
 * - running → 本入口（editAcceptanceCriteria 语义）：
 *     终止当前 ACP 进程（session/cancel 或 kill）→ executionStatus=interrupted
 *     → 旧 execution record partial 标"已废弃（AC 修订）" → AC diff 写 timeline（system 事件）
 *     → 新 AC 落 Task.acceptanceCriteria（B1 updateTask 字段）
 *     → 两选一接线（重跑 executeTask / 手动完成 manualComplete）由 B4Ipc 层完成，本类不实现
 * - 非 running → B1 updateTask 普通编辑（无中断、无 diff 要求）
 *
 * 注入面（不硬依赖 ExecutionEngine 具体类，B4Ipc 后续接线）：
 * - readStore：B1 store 只读面（executionStatus / currentExecutionId / 旧 AC）
 * - mutations：B1 updateTask 写面（非 running 编辑 + running 路径新 AC 落字段）
 * - executionBridge：B3 引擎桥（终止 ACP / 写 interrupted / execution 记录标废弃）
 * - timelineStore：B1 timeline 写原语（AC diff system 事件，B4 AcEditor 写权，P1-1）
 *
 * timeline 写入归属（design §4.2 P1-1）：AC 修订 diff / partial 标"已废弃（AC 修订）" → B4
 * AcEditor 写 system 事件（变更前后对照/操作人，CON-R021）；executionStatus 迁移与 execution
 * 记录（type=execution，B1 P1-1 ② 层）仍经 B3 引擎桥写，不绕过 B3 写权。
 */
import { ExecNotRunningError, ExecValidationError } from '../errors';

/** AC 修订入参（契约 §3 editAcceptanceCriteria body；what/expected/verify 必填） */
export interface AcceptanceCriteriaInput {
  what: string;
  expected: string;
  verify: string;
  context?: string;
}

/** editAcceptanceCriteria 成功响应（契约 §3：running 中断 / 非 running 普通编辑） */
export type EditAcResult =
  | { taskId: string; executionStatus: 'interrupted'; previousExecutionId: string | null }
  | { taskId: string; executionStatus: 'updated'; previousExecutionId: null };

/** B1 store 只读面（executionStatus 分流 + running 路径旧值读取） */
export interface AcEditorReadStore {
  getExecutionStatus(boardId: string, taskId: string): string;
  /** 当前执行记录 id（e_<uuid>；partial 废弃目标 + previousExecutionId 来源） */
  getCurrentExecutionId(boardId: string, taskId: string): string | null;
  /** 旧 AC（diff 对照源；running 路径必用） */
  getAcceptanceCriteria(boardId: string, taskId: string): AcceptanceCriteriaInput | null;
}

/** B1 updateTask 写面（非 running 普通编辑 + running 路径新 AC 落字段） */
export interface AcEditorMutations {
  updateAcceptanceCriteria(boardId: string, taskId: string, ac: AcceptanceCriteriaInput): void;
}

/** B3 引擎桥（running 路径；终止 ACP / 中断 / execution 记录标废弃——B4Ipc 接线 ExecutionEngine） */
export interface AcEditorExecutionBridge {
  /** 终止当前 ACP 进程 + 从调度池移除（B3 scheduler.cancel 语义；幂等；无会话则 kill） */
  cancelExecution(boardId: string, taskId: string): Promise<void>;
  /** 写 executionStatus=interrupted + system 事件"执行已中断（AC 修订）"（B3 引擎层执行态写权） */
  markInterrupted(boardId: string, taskId: string, reason: string, detail: string): void;
  /** 旧 execution record（type=execution）标"已废弃（AC 修订）"（execution 类条目仅 B3 调度层写，P1-1 ②） */
  markExecutionDeprecated(boardId: string, taskId: string, executionId: string): void;
}

/** B1 timeline 写原语注入面（B4 AcEditor 写 AC diff system 事件，P1-1） */
export interface AcEditorTimelineStore {
  appendSystemEvent(boardId: string, taskId: string, content: string): void;
}

export interface AcEditorOptions {
  readStore: AcEditorReadStore;
  mutations: AcEditorMutations;
  executionBridge: AcEditorExecutionBridge;
  timelineStore: AcEditorTimelineStore;
}

/**
 * AC 修订入口（P2-B4-3 状态分流）：
 * - running → 终止 ACP + interrupted + partial 废弃 + AC diff 留痕 + 新 AC 落字段（返回 previousExecutionId）
 * - 非 running → B1 updateTask 普通编辑（不中断、无 diff）
 */
export class AcEditor {
  private readonly readStore: AcEditorReadStore;
  private readonly mutations: AcEditorMutations;
  private readonly executionBridge: AcEditorExecutionBridge;
  private readonly timelineStore: AcEditorTimelineStore;

  constructor(options: AcEditorOptions) {
    this.readStore = options.readStore;
    this.mutations = options.mutations;
    this.executionBridge = options.executionBridge;
    this.timelineStore = options.timelineStore;
  }

  async editAcceptanceCriteria(boardId: string, taskId: string, ac: AcceptanceCriteriaInput): Promise<EditAcResult> {
    this.validate(ac);
    const status = this.readStore.getExecutionStatus(boardId, taskId);
    // 非 running → B1 updateTask 普通编辑（P2-B4-3；不中断、无 diff 要求）
    if (status !== 'running') {
      this.mutations.updateAcceptanceCriteria(boardId, taskId, ac);
      return { taskId, executionStatus: 'updated', previousExecutionId: null };
    }

    const oldAc = this.readStore.getAcceptanceCriteria(boardId, taskId);
    const executionId = this.readStore.getCurrentExecutionId(boardId, taskId);
    // 终止进程前复核 executionStatus 仍 running（design §7 竞态防护：已完成任务不被误中断）
    const recheck = this.readStore.getExecutionStatus(boardId, taskId);
    if (recheck !== 'running') {
      throw new ExecNotRunningError(`执行已结束（当前 ${recheck}），AC 修订中止`, recheck);
    }
    // 终止当前 ACP 进程（session/cancel 或 kill；B3 scheduler.cancel 语义）
    await this.executionBridge.cancelExecution(boardId, taskId);
    // 执行 interrupted + 审计 system 事件"执行已中断（AC 修订）"
    this.executionBridge.markInterrupted(boardId, taskId, '执行已中断', 'AC 修订');
    // 旧 execution record partial 标"已废弃（AC 修订）"
    if (executionId) this.executionBridge.markExecutionDeprecated(boardId, taskId, executionId);
    // AC diff 写 timeline（system 事件：变更前后对照/操作人，CON-R021）
    this.timelineStore.appendSystemEvent(boardId, taskId, this.buildDiff(oldAc, ac));
    // 新 AC 落 Task.acceptanceCriteria（B1 updateTask 字段）
    this.mutations.updateAcceptanceCriteria(boardId, taskId, ac);
    return { taskId, executionStatus: 'interrupted', previousExecutionId: executionId };
  }

  /** 校验 AC 必填（契约 §3 validation-error；what/expected/verify 非空） */
  private validate(ac: AcceptanceCriteriaInput): void {
    for (const field of ['what', 'expected', 'verify'] as const) {
      if (!ac[field] || !String(ac[field]).trim()) {
        throw new ExecValidationError(`acceptanceCriteria.${field} 必填`, field);
      }
    }
  }

  /** AC diff 文本（变更前后对照/操作人，CON-R021；仅列变化字段） */
  private buildDiff(oldAc: AcceptanceCriteriaInput | null, newAc: AcceptanceCriteriaInput): string {
    const parts: string[] = [];
    for (const field of ['what', 'expected', 'verify', 'context'] as const) {
      const before = oldAc?.[field] ?? '';
      const after = newAc[field] ?? '';
      if (before !== after) parts.push(`${field}: ${before} → ${after}`);
    }
    const body = parts.length > 0 ? parts.join('；') : '（无字段变化）';
    return `AC 修订（操作人 user）：${body}`;
  }
}
