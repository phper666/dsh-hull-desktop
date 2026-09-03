/** 通知中心 V2a 类型（docs/design/通知中心v2a-notify-service-design.md §二） */

export type NotifSource = 'workflow' | 'board-exec';

export type NotifSeverity = 'error' | 'info';

/** 判别联合：点击路由（workflow → 工作流视图；task → 看板视图+任务详情） */
export type NotifLink =
  | { kind: 'workflow'; workflowId: string }
  | { kind: 'task'; boardId: string; taskId: string };

export interface NotifInput {
  source: NotifSource;
  severity: NotifSeverity;
  title: string;
  body: string;
  link: NotifLink;
  /** 缺省 now() */
  ts?: string;
  /** 缺省：error=null（未读）、info=now（已读）——角标只数未读 error */
  readAt?: string | null;
  meta?: Record<string, unknown>;
}

export interface NotifRow extends NotifInput {
  id: string;
  ts: string;
  readAt: string | null;
}

/** 每源保留上限（环形按 ts，最旧先裁） */
export const NOTIF_RETENTION: Record<NotifSource, number> = {
  workflow: 50,
  'board-exec': 100,
};
