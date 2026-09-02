/**
 * 工作流执行引擎：顺序执行步骤，每步独立结果与耗时，单步失败即中止（fail-fast）。
 * 步骤处理器 DI 注入（dsh-card 需 kanban+exec；connection-action 需 invokeAction；token-budget 需 tokenUsage）——可测可替换。
 * v2：同工作流互斥（手动/定时共用）——上一次运行未结束则拒绝，防并发写同一 runs.json。
 */
import type { KanbanStore } from '../kanban/KanbanStore';
import type { ExecutionEngine } from '../exec/ExecutionEngine';
import type { WorkflowRun, WorkflowStep } from './types';

export interface WorkflowEngineDeps {
  store: WorkflowStoreShape;
  kanban: KanbanStore;
  exec: ExecutionEngine;
  notify: (title: string, body: string) => void;
  /** 工作台连接动作（v2）：main 装配 ConnectionsStore.getCredentials + invokeConnectionAction */
  invokeAction?: (connectionId: string, params: Record<string, string>) => Promise<{ ok: boolean; message: string }>;
  /** Token 用量查询（v2）：main 装配 scanAllSources + summarize（period 日历对齐语义与 tokens 视图一致） */
  tokenUsage?: (period: 'day' | 'month' | 'all') => Promise<{ totalTokens: number }>;
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
  private readonly running = new Set<string>();

  constructor(private readonly deps: WorkflowEngineDeps) {}

  async run(workflowId: string, source: 'manual' | 'cron' = 'manual'): Promise<WorkflowRun> {
    if (this.running.has(workflowId)) throw new Error('该工作流上一次运行尚未结束');
    this.running.add(workflowId);
    try {
      return await this.runInner(workflowId, source);
    } finally {
      this.running.delete(workflowId);
    }
  }

  private async runInner(workflowId: string, source: 'manual' | 'cron'): Promise<WorkflowRun> {
    const def = this.deps.store.get(workflowId);
    if (!def) throw new Error('工作流不存在（已被删除）');
    if (!def.enabled) throw new Error('工作流已停用，请先启用');
    const run: WorkflowRun = {
      id: this.deps.uuid?.() ?? this.deps.store.newRunId(),
      workflowId: def.id,
      workflowName: def.name,
      startedAt: new Date().toISOString(),
      status: 'running',
      trigger: source,
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
      case 'connection-action': {
        const connectionId = step.config.connectionId || '';
        if (!connectionId) throw new Error('connection-action 需要选择连接（connectionId）');
        if (!this.deps.invokeAction) throw new Error('工作台连接动作能力未装配');
        let params: Record<string, string> = {};
        if (step.config.params) {
          try {
            const parsed: unknown = JSON.parse(step.config.params);
            if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('非对象');
            params = parsed as Record<string, string>;
          } catch {
            throw new Error('params 需为 JSON 对象字符串');
          }
        }
        const r = await this.deps.invokeAction(connectionId, params);
        if (!r.ok) throw new Error(r.message);
        return r.message;
      }
      case 'token-budget': {
        if (!this.deps.tokenUsage) throw new Error('Token 用量能力未装配');
        const period = (step.config.period === 'month' || step.config.period === 'all' ? step.config.period : 'day') as 'day' | 'month' | 'all';
        const threshold = Number(step.config.thresholdTokens);
        if (!Number.isFinite(threshold) || threshold <= 0) throw new Error('token-budget 需要正数 thresholdTokens');
        const { totalTokens } = await this.deps.tokenUsage(period);
        const label = period === 'day' ? '今日' : period === 'month' ? '本月' : '累计';
        if (totalTokens >= threshold) {
          const msg = `Token 预算超限：${label}用量 ${totalTokens} ≥ 阈值 ${threshold}`;
          if (step.config.notifyOnExceed === 'true') this.deps.notify('Hull 工作流', msg);
          throw new Error(msg);
        }
        return `Token 预算正常：${label}用量 ${totalTokens} / 阈值 ${threshold}`;
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
