/**
 * 工作流（Workflows）——类型与步骤定义。
 * 设计：docs/design/工作流-workflows-design.md
 * 模型（n8n/Dify 共性提炼）：触发器 → 顺序动作节点 → 每步执行日志。
 * v1 步骤类型：dsh-card（看板卡片+执行）/ http（通用集成底座）/ notification（壳通知）/ delay。
 * v2 步骤类型：connection-action（工作台连接联动：发短信/邮件）/ token-budget（Token 预算告警）。
 * v2 触发：手动（缺省 trigger）+ cron 定时（WorkflowScheduler）；事件触发留 v3。
 */

export type WorkflowStepType = 'dsh-card' | 'http' | 'notification' | 'delay' | 'connection-action' | 'token-budget';

export interface WorkflowStep {
  id: string;
  type: WorkflowStepType;
  config: Record<string, string>;
}

/** 定时触发器（v2）：5 字段 cron（分 时 日 月 周，本地时区） */
export interface WorkflowTriggerCron {
  type: 'cron';
  expr: string;
}

export interface WorkflowDef {
  id: string;
  name: string;
  enabled: boolean;
  steps: WorkflowStep[];
  /** 触发器：缺省/undefined = 手动运行；字段级扩展，workflows.json version 不 bump */
  trigger?: WorkflowTriggerCron | null;
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
  /** 触发来源：manual（列表按钮）| cron（定时调度，v2） */
  trigger?: 'manual' | 'cron';
  /** 每步执行日志（type/ok/message/耗时） */
  log: Array<{ stepId: string; type: WorkflowStepType; ok: boolean; message: string; durationMs: number }>;
}

export const WORKFLOW_STEP_TYPES: Array<{ type: WorkflowStepType; name: string; description: string }> = [
  { type: 'dsh-card', name: 'dsh 任务卡片', description: '在看板创建卡片并可立即执行（dsh + 面板联动）' },
  { type: 'http', name: 'HTTP 请求', description: '调用任意 webhook/API（通用集成底座）' },
  { type: 'connection-action', name: '工作台连接动作', description: '用已连接凭据执行平台动作（发短信/发邮件）' },
  { type: 'token-budget', name: 'Token 预算检查', description: '按周期检查 Token 用量阈值，超限告警并中止' },
  { type: 'notification', name: '系统通知', description: '弹出系统通知（进度/结果提醒）' },
  { type: 'delay', name: '延时等待', description: '等待 N 秒后继续（步骤间节拍）' },
];
