/**
 * NotificationService（通知中心 V2a 底座）：统一 emit → 独立存储 → 按源保留 → 事件推送。
 * 设计：docs/design/通知中心v2a-notify-service-design.md §二
 * - 存储 <userData>/notifications/notifications.json（version 1，原子写；不触 DSH_HOME，CON-R002）。
 * - 语义：error 默认未读（角标数据），info 默认已读（进中心不挂角标）；系统推送由 main 注入的
 *   systemChannel 按 severity==='error' 决定（emitter 不碰系统通知）。
 * - 迁移 migrateFromWorkflowRuns：V1 数据平移（runs.json → workflow 通知，failed 未读/success 已读）；
 *   notifications.json 已存在即跳过；runs.json 原样保留（工作流卡片徽标仍读它）。
 */
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { NOTIF_RETENTION, type NotifInput, type NotifRow, type NotifSource } from './types';

interface WorkflowRunLike {
  id: string;
  workflowId: string;
  workflowName: string;
  startedAt: string;
  finishedAt?: string;
  status: string;
  trigger?: string;
  log?: Array<{ stepId: string; type: string; ok: boolean; message: string; durationMs: number }>;
}

export interface NotificationServiceDeps {
  userDataPath: string;
  uuid?: () => string;
  now?: () => Date;
  /** 存储变更回调（main 接 webContents.send('notifs:changed')） */
  onChanged?: () => void;
}

export class NotificationService {
  private readonly dir: string;
  private cache: NotifRow[] | null = null;
  private readonly deps: Required<Pick<NotificationServiceDeps, 'uuid' | 'now'>> & NotificationServiceDeps;

  constructor(deps: NotificationServiceDeps) {
    this.dir = join(deps.userDataPath, 'notifications');
    this.deps = {
      ...deps,
      uuid: deps.uuid ?? (() => randomUUID()),
      now: deps.now ?? (() => new Date()),
    };
  }

  /** 发射一条通知：落盘 + 按源保留裁剪 + onChanged */
  emit(input: NotifInput): NotifRow {
    const now = this.deps.now().toISOString();
    const row: NotifRow = {
      ...input,
      id: this.deps.uuid(),
      ts: input.ts ?? now,
      readAt: input.readAt !== undefined ? input.readAt : input.severity === 'error' ? null : now,
    };
    const rows = this.load();
    rows.unshift(row);
    this.persist(rows);
    this.deps.onChanged?.();
    return row;
  }

  /** 未读在前、时间倒序 */
  list(): NotifRow[] {
    return this.load()
      .slice()
      .sort((a, b) => {
        const ua = a.readAt === null ? 0 : 1;
        const ub = b.readAt === null ? 0 : 1;
        if (ua !== ub) return ua - ub;
        return a.ts < b.ts ? 1 : a.ts > b.ts ? -1 : 0;
      })
      .map((n) => ({ ...n, meta: n.meta ? { ...n.meta } : undefined }));
  }

  /** 标记已读：缺省全量；带 source 只读本源 */
  markAllRead(source?: NotifSource): void {
    const now = this.deps.now().toISOString();
    const rows = this.load();
    let dirty = false;
    for (const n of rows) {
      if (n.readAt === null && (!source || n.source === source)) {
        n.readAt = now;
        dirty = true;
      }
    }
    if (dirty) {
      this.persist(rows);
      this.deps.onChanged?.();
    }
  }

  /** V1 → V2a 平移：导入 runs.json 为 workflow 通知（幂等：已有任何通知则跳过） */
  migrateFromWorkflowRuns(): void {
    if (this.cache && this.cache.length > 0) return;
    const file = join(this.deps.userDataPath, 'workflows', 'runs.json');
    if (!existsSync(file)) return;
    let runs: WorkflowRunLike[] = [];
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8')) as { runs?: WorkflowRunLike[] };
      runs = Array.isArray(parsed.runs) ? parsed.runs : [];
    } catch {
      return;
    }
    if (!runs.length || (this.cache !== null && this.cache.length > 0)) return;
    for (const r of runs) {
      const failed = r.status === 'failed';
      const firstFail = (r.log ?? []).find((l) => !l.ok)?.message ?? '运行失败';
      const lastMsg = (r.log ?? [])[(r.log ?? []).length - 1]?.message ?? '';
      this.emit({
        source: 'workflow',
        severity: failed ? 'error' : 'info',
        title: failed ? `工作流 · ${r.workflowName}【失败】` : `工作流 · ${r.workflowName}`,
        body: failed ? firstFail : lastMsg,
        link: { kind: 'workflow', workflowId: r.workflowId },
        ts: r.startedAt,
        readAt: failed ? null : r.startedAt,
        meta: { trigger: r.trigger ?? 'manual', durationMs: (r.log ?? []).reduce((a, l) => a + (l.durationMs || 0), 0), log: r.log ?? [] },
      });
    }
  }

  // ── 存储 ──

  private load(): NotifRow[] {
    if (this.cache) return this.cache;
    const file = join(this.dir, 'notifications.json');
    if (!existsSync(file)) {
      this.cache = [];
      return this.cache;
    }
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8')) as { notifications?: NotifRow[] };
      this.cache = Array.isArray(parsed.notifications) ? parsed.notifications : [];
    } catch {
      this.cache = [];
    }
    return this.cache;
  }

  private persist(rows: NotifRow[]): void {
    // 按源环形保留（最旧先裁）
    const bySource = new Map<NotifSource, NotifRow[]>();
    for (const n of rows) {
      const list = bySource.get(n.source) ?? [];
      list.push(n);
      bySource.set(n.source, list);
    }
    const kept: NotifRow[] = [];
    for (const [source, list] of bySource) {
      const sorted = list.sort((a, b) => (a.ts < b.ts ? 1 : -1)); // 新在前
      kept.push(...sorted.slice(0, NOTIF_RETENTION[source]));
    }
    mkdirSync(this.dir, { recursive: true });
    writeFileSync(join(this.dir, 'notifications.json'), JSON.stringify({ version: 1, notifications: kept }, null, 2));
    this.cache = kept;
  }
}
