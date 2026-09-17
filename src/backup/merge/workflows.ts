/**
 * B3 工作流合并（设计 §4.4）：
 * 以包内为基底；本地工作流逐条追加；id 冲突 → 重生成 wf_<uuid>（引用无需重映射——workflowId 不存于定义内）；
 * id 冲突且内容相同 → 跳过；name 相同不合并、不覆盖（原样追加）。
 * runs.json 不入包也不并入（v1 明确排除）。
 */
import type { WorkflowDef } from '../../workflows/types';
import type { ConflictEntry } from './conflicts';

export interface WorkflowsFile {
  version: number;
  workflows: WorkflowDef[];
}

function isWorkflowDef(v: unknown): v is WorkflowDef {
  return !!v && typeof v === 'object' && typeof (v as WorkflowDef).id === 'string' && Array.isArray((v as WorkflowDef).steps);
}

/** 防御性归一：非对象/缺 workflows → 空基底（损坏不抛，恢复期由 B2 校验兜底） */
function normalizeFile(raw: unknown): WorkflowsFile {
  const obj = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const list = Array.isArray(obj.workflows) ? obj.workflows.filter(isWorkflowDef) : [];
  return { version: typeof obj.version === 'number' ? obj.version : 1, workflows: list };
}

export function mergeWorkflows(
  local: WorkflowsFile | unknown,
  incoming: unknown,
  ctx: { uuid(): string },
): { value: WorkflowsFile; conflicts: ConflictEntry[] } {
  const base = normalizeFile(incoming);
  const value: WorkflowsFile = { version: base.version, workflows: base.workflows.map((w) => structuredClone(w)) };
  const baseNames = new Set(base.workflows.map((w) => w.name));
  const conflicts: ConflictEntry[] = [];

  for (const w of normalizeFile(local).workflows) {
    const existing = value.workflows.find((x) => x.id === w.id);
    if (existing) {
      if (JSON.stringify(existing) === JSON.stringify(w)) {
        conflicts.push({ kind: 'workflow', id: w.id, resolution: 'skipped-identical', detail: 'id 冲突且内容相同，跳过' });
        continue;
      }
      const newId = `wf_${ctx.uuid()}`;
      value.workflows.push({ ...structuredClone(w), id: newId });
      conflicts.push({ kind: 'workflow', id: w.id, resolution: 'appended', detail: `id 冲突 → 重 id ${newId}` });
      continue;
    }
    value.workflows.push(structuredClone(w));
    if (baseNames.has(w.name)) {
      conflicts.push({ kind: 'workflow', id: w.id, resolution: 'appended', detail: `name「${w.name}」与包内同名，不合并/不覆盖，已追加` });
    }
  }

  return { value, conflicts };
}
