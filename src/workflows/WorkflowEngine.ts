/**
 * 工作流执行引擎：顺序执行步骤，每步独立结果与耗时，单步失败即中止（fail-fast）。
 * 步骤处理器 DI 注入（dsh-card 需 kanban+exec；notification 需通知器）——可测可替换。
 */
import type { KanbanStore } from '../kanban/KanbanStore';
import type { ExecutionEngine } from '../exec/ExecutionEngine';
import type { WorkflowDef, WorkflowRun, WorkflowStep } from './types';

export interface WorkflowEngineDeps {
  store: WorkflowStoreShape;
  kanban: KanbanStore;
  exec: ExecutionEngine;
  notify: (title: string, body: string) => void;
  now?: () => number;
  uuid?: () => string;
}

/** 最小接口（避免与 KanbanStore 具体类强耦合的双向依赖） */
export interface WorkflowStoreShape {
  get(id: string): { id: string; name: string; enabled: boolean; steps: WorkflowStep[] } | null;
  saveRun(run: WorkflowRun): void;
  newRunId(): string;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class WorkflowEngine {
  constructor(private readonly deps: WorkflowEngineDeps) {}

  async run(workflowId: string): Promise<WorkflowRun> {
    const def = this.deps.store.get(workflowId);
    if (!def) throw new Error('工作流不存在（已被删除）');
    if (!def.enabled) throw new Error('工作流已停用，请先启用');
    const run: WorkflowRun = {
      id: this.deps.uuid?.() ?? this.deps.store.newRunId(),
      workflowId: def.id,
      workflowName: def.name,
      startedAt: new Date().toISOString(),
      status: 'running',
      log: [],
    };
    this.deps.store.saveRun(run);
    for (const step of def.steps) {
      const t0 = this.deps.now?.() ?? Date.now();
      let ok = true;
      let message = '';
      try {
        message = await this.runStep(step);
      } catch (err) {
        ok = false;
        message = (err as Error).message;
      }
      const durationMs = (this.deps.now?.() ?? Date.now()) - t0;
      run.log.push({ stepId: step.id, type: step.type, ok, message, durationMs });
      this.deps.store.saveRun(run);
      if (!ok) {
        run.status = 'failed';
        run.finishedAt = new Date().toISOString();
        this.deps.store.saveRun(run);
        return run;
      }
    }
    run.status = 'success';
    run.finishedAt = new Date().toISOString();
    this.deps.store.saveRun(run);
    return run;
  }

  private async runStep(step: WorkflowStep): Promise<string> {
    switch (step.type) {
      case 'dsh-card': {
        const boardId = step.config.boardId;
        const title = step.config.title || '';
        if (!boardId || !title) throw new Error('dsh-card 需要配置看板与卡片标题');
        const created = this.deps.kanban.createTask(boardId, {
          title,
          description: step.config.description || '',
          priority: (step.config.priority as 'P0' | 'P1' | 'P2') || 'P2',
          labels: ['工作流'],
        });
        const task = (created as unknown as { data?: unknown; id?: string }) as { data?: { id?: string }; id?: string };
        const taskId = task.data?.id ?? task.id;
        if (!taskId) throw new Error('卡片创建失败（未返回 id）');
        if (step.config.execute === 'true') {
          const r = this.deps.exec.executeTask(boardId, taskId) as unknown as { ok?: boolean; message?: string };
          if (r && r.ok === false) throw new Error(r.message || '执行派发失败');
          return `已创建卡片「${title}」并派发执行`;
        }
        return `已创建卡片「${title}」`;
      }
      case 'http': {
        const url = step.config.url || '';
        if (!/^https?:\/\//.test(url)) throw new Error('http 步骤需要合法 URL（http/https）');
        const method = (step.config.method || 'GET').toUpperCase();
        const res = await fetch(url, {
          method,
          headers: step.config.headers ? JSON.parse(step.config.headers) : undefined,
          body: method === 'GET' || method === 'HEAD' ? undefined : step.config.body || undefined,
          signal: AbortSignal.timeout(15_000),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return `${method} ${url} → HTTP ${res.status}`;
      }
      case 'notification': {
        const message = step.config.message || '工作流通知';
        this.deps.notify('Hull 工作流', message);
        return `已发送通知: ${message}`;
      }
      case 'delay': {
        const sec = Math.min(Math.max(Number(step.config.seconds) || 1, 1), 3600);
        await sleep(sec * 1000);
        return `已等待 ${sec}s`;
      }
      default:
        throw new Error(`未知步骤类型: ${(step as WorkflowStep).type}`);
    }
  }
}
