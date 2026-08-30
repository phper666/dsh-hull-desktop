/**
 * 工作流（Workflows）——类型与步骤定义。
 * 设计：docs/design/工作流-workflows-design.md
 * 模型（n8n/Dify 共性提炼）：手动触发 → 顺序动作节点 → 每步执行日志。
 * v1 步骤类型：dsh-card（看板卡片+执行）/ http（通用集成底座）/ notification（壳通知）/ delay。
 * v2 规划：定时触发（cron）、事件触发（dsh 事件）、步骤间变量传递、新平台步骤（工作台连接联动）。
 */

export type WorkflowStepType = 'dsh-card' | 'http' | 'notification' | 'delay';

export interface WorkflowStep {
  id: string;
  type: WorkflowStepType;
  config: Record<string, string>;
}

export interface WorkflowDef {
  id: string;
  name: string;
  enabled: boolean;
  steps: WorkflowStep[];
  createdAt: string;
  updatedAt: string;
}

export interface WorkflowRun {
  id: string;
  workflowId: string;
  workflowName: string;
  startedAt: string;
  finishedAt?: string;
  status: 'running' | 'success' | 'failed';
  /** 每步执行日志（type/ok/message/耗时） */
  log: Array<{ stepId: string; type: WorkflowStepType; ok: boolean; message: string; durationMs: number }>;
}

export const WORKFLOW_STEP_TYPES: Array<{ type: WorkflowStepType; name: string; description: string }> = [
  { type: 'dsh-card', name: 'dsh 任务卡片', description: '在看板创建卡片并可立即执行（dsh + 面板联动）' },
  { type: 'http', name: 'HTTP 请求', description: '调用任意 webhook/API（通用集成底座）' },
  { type: 'notification', name: '系统通知', description: '弹出系统通知（进度/结果提醒）' },
  { type: 'delay', name: '延时等待', description: '等待 N 秒后继续（步骤间节拍）' },
];
