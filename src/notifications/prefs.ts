/**
 * 通知偏好（V2b §八）：按源系统通知开关 + 免打扰时段（跨午夜支持）。
 * shouldSystemPush 只约束系统通知；中心存储/未读语义不受影响（error 照常入中心未读）。
 */

export interface NotifPrefs {
  /** 工作流失败系统通知开关 */
  systemPushWorkflow: boolean;
  /** 看板执行失败系统通知开关 */
  systemPushBoardExec: boolean;
  /** 免打扰时段启用 */
  dndEnabled: boolean;
  /** 起止 HH:mm（本地时区；from>to = 跨午夜区间，含头不含尾） */
  dndFrom: string;
  dndTo: string;
}

export const DEFAULT_NOTIF_PREFS: NotifPrefs = {
  systemPushWorkflow: true,
  systemPushBoardExec: true,
  dndEnabled: false,
  dndFrom: '22:00',
  dndTo: '08:00',
};

const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;

export function isValidHHmm(v: unknown): v is string {
  return typeof v === 'string' && HHMM.test(v);
}

/** 未知原始值 → 归一化偏好（非法字段逐项回退默认，theme 先例） */
export function normalizeNotifPrefs(raw: unknown): NotifPrefs {
  const o = (raw ?? {}) as Record<string, unknown>;
  return {
    systemPushWorkflow: typeof o.systemPushWorkflow === 'boolean' ? o.systemPushWorkflow : DEFAULT_NOTIF_PREFS.systemPushWorkflow,
    systemPushBoardExec: typeof o.systemPushBoardExec === 'boolean' ? o.systemPushBoardExec : DEFAULT_NOTIF_PREFS.systemPushBoardExec,
    dndEnabled: typeof o.dndEnabled === 'boolean' ? o.dndEnabled : DEFAULT_NOTIF_PREFS.dndEnabled,
    dndFrom: isValidHHmm(o.dndFrom) ? o.dndFrom : DEFAULT_NOTIF_PREFS.dndFrom,
    dndTo: isValidHHmm(o.dndTo) ? o.dndTo : DEFAULT_NOTIF_PREFS.dndTo,
  };
}

/** 分钟数 ∈ [from,to)（本地时区分钟；from>to = 跨午夜取反区间；含头不含尾） */
export function inDndWindow(nowMinutes: number, from: string, to: string): boolean {
  if (!isValidHHmm(from) || !isValidHHmm(to)) return false;
  const f = Number(from.slice(0, 2)) * 60 + Number(from.slice(3, 5));
  const t = Number(to.slice(0, 2)) * 60 + Number(to.slice(3, 5));
  if (f === t) return false; // 零长窗口 = 不启用
  if (f < t) return nowMinutes >= f && nowMinutes < t;
  return nowMinutes >= f || nowMinutes < t; // 跨午夜
}

/** 系统通知推送判定：源开关 + 免打扰；severity 过滤由调用方保证（仅 error 到达此处） */
export function shouldSystemPush(source: 'workflow' | 'board-exec', prefs: NotifPrefs, now = new Date()): boolean {
  if (source === 'workflow' && !prefs.systemPushWorkflow) return false;
  if (source === 'board-exec' && !prefs.systemPushBoardExec) return false;
  if (prefs.dndEnabled) {
    const nowMinutes = now.getHours() * 60 + now.getMinutes();
    if (inDndWindow(nowMinutes, prefs.dndFrom, prefs.dndTo)) return false;
  }
  return true;
}
