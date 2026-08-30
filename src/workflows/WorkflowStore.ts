/**
 * 工作流存储：workflows.json（定义）+ runs.json（最近 50 次运行日志，环形裁剪）。
 * 落 <userData>/workflows/（不触 DSH_HOME，CON-R002）。
 */
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { WorkflowDef, WorkflowRun } from './types';

const MAX_RUNS = 50;

export class WorkflowStore {
  private readonly dir: string;
  private cache: WorkflowDef[] | null = null;

  constructor(userDataPath: string) {
    this.dir = join(userDataPath, 'workflows');
  }

  private loadDefs(): WorkflowDef[] {
    if (this.cache) return this.cache;
    const file = join(this.dir, 'workflows.json');
    if (!existsSync(file)) {
      this.cache = [];
      return this.cache;
    }
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8')) as { workflows?: WorkflowDef[] };
      this.cache = Array.isArray(parsed.workflows) ? parsed.workflows : [];
    } catch {
      this.cache = [];
    }
    return this.cache;
  }

  private persistDefs(defs: WorkflowDef[]): void {
    mkdirSync(this.dir, { recursive: true });
    writeFileSync(join(this.dir, 'workflows.json'), JSON.stringify({ version: 1, workflows: defs }, null, 2));
    this.cache = defs;
  }

  list(): WorkflowDef[] {
    return this.loadDefs().map((w) => ({ ...w, steps: w.steps.map((s) => ({ ...s })) }));
  }

  get(id: string): WorkflowDef | null {
    return this.list().find((w) => w.id === id) ?? null;
  }

  save(input: { id?: string; name: string; enabled?: boolean; steps: WorkflowDef['steps'] }): WorkflowDef {
    if (!input.name.trim()) throw new Error('工作流名称不能为空');
    const defs = this.loadDefs();
    const now = new Date().toISOString();
    if (input.id) {
      const w = defs.find((x) => x.id === input.id);
      if (!w) throw new Error('工作流不存在（已被删除）');
      w.name = input.name.trim();
      w.enabled = input.enabled ?? w.enabled;
      w.steps = input.steps;
      w.updatedAt = now;
      this.persistDefs(defs);
      return this.get(w.id) as WorkflowDef;
    }
    const w: WorkflowDef = {
      id: randomUUID(),
      name: input.name.trim(),
      enabled: input.enabled ?? true,
      steps: input.steps,
      createdAt: now,
      updatedAt: now,
    };
    defs.push(w);
    this.persistDefs(defs);
    return this.get(w.id) as WorkflowDef;
  }

  delete(id: string): boolean {
    const defs = this.loadDefs();
    const next = defs.filter((w) => w.id !== id);
    if (next.length === defs.length) return false;
    this.persistDefs(next);
    return true;
  }

  // ── 运行日志 ──

  private loadRuns(): WorkflowRun[] {
    const file = join(this.dir, 'runs.json');
    if (!existsSync(file)) return [];
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8')) as { runs?: WorkflowRun[] };
      return Array.isArray(parsed.runs) ? parsed.runs : [];
    } catch {
      return [];
    }
  }

  /** upsert：同 run.id 更新（执行中多次落盘进度），新 run 前插 */
  saveRun(run: WorkflowRun): void {
    mkdirSync(this.dir, { recursive: true });
    const runs = this.loadRuns();
    const idx = runs.findIndex((r) => r.id === run.id);
    if (idx !== -1) runs[idx] = { ...run };
    else runs.unshift({ ...run });
    writeFileSync(join(this.dir, 'runs.json'), JSON.stringify({ version: 1, runs: runs.slice(0, MAX_RUNS) }, null, 2));
  }

  runs(workflowId?: string): WorkflowRun[] {
    const runs = this.loadRuns();
    return workflowId ? runs.filter((r) => r.workflowId === workflowId) : runs;
  }

  newRunId(): string {
    return randomUUID();
  }
}
