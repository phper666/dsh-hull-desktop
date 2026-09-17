/**
 * B3 通知与 dismiss 合并（设计 §4.5）：
 * - 通知：基底 = 包内；本地条目按 id 去重追加；合并后按 NotificationService 的 ring cap 裁剪（最旧先裁）。
 * - dismiss：{dsh?, hull?} 逐键取较新 ISO 日期（旧单键 date 视作 dsh，对齐 DismissStore 读兼容）。
 */
import { NOTIF_RETENTION, type NotifRow, type NotifSource } from '../../notifications/types';
import type { ConflictEntry } from './conflicts';

export interface NotificationsFile {
  version: number;
  notifications: NotifRow[];
}

export interface DismissFile {
  dsh?: string;
  hull?: string;
}

function isNotifRow(v: unknown): v is NotifRow {
  return !!v && typeof v === 'object' && typeof (v as NotifRow).id === 'string' && typeof (v as NotifRow).ts === 'string';
}

function normalizeRows(raw: unknown): NotifRow[] {
  const obj = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  return Array.isArray(obj.notifications) ? obj.notifications.filter(isNotifRow) : [];
}

export function mergeNotifications(local: unknown, incoming: unknown): { value: NotificationsFile; conflicts: ConflictEntry[] } {
  const baseRows = normalizeRows(incoming);
  const merged = baseRows.map((r) => ({ ...r }));
  const seen = new Set(baseRows.map((r) => r.id));
  const conflicts: ConflictEntry[] = [];

  for (const r of normalizeRows(local)) {
    if (seen.has(r.id)) {
      conflicts.push({ kind: 'notif', id: r.id, resolution: 'skipped-identical', detail: '通知 id 去重（包内优先）' });
      continue;
    }
    seen.add(r.id);
    merged.push({ ...r });
  }

  // ring cap：按源分组，ts 新在前保留 cap 条（对齐 NotificationService.persist）
  const bySource = new Map<string, NotifRow[]>();
  for (const r of merged) {
    const list = bySource.get(r.source) ?? [];
    list.push(r);
    bySource.set(r.source, list);
  }
  const kept: NotifRow[] = [];
  for (const [source, list] of bySource) {
    const cap = NOTIF_RETENTION[source as NotifSource] ?? Number.MAX_SAFE_INTEGER;
    list.sort((a, b) => (a.ts < b.ts ? 1 : a.ts > b.ts ? -1 : 0));
    for (const r of list.slice(cap)) {
      conflicts.push({ kind: 'notif', id: r.id, resolution: 'skipped-identical', detail: `通知超出 ${source} ring cap（${cap}）被裁剪` });
    }
    kept.push(...list.slice(0, cap));
  }

  const version = (incoming && typeof incoming === 'object' && typeof (incoming as { version?: unknown }).version === 'number'
    ? (incoming as { version: number }).version
    : 1);
  return { value: { version, notifications: kept }, conflicts };
}

function asString(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

function newest(...values: Array<string | undefined>): string | undefined {
  let best: string | undefined;
  for (const v of values) {
    if (v !== undefined && (best === undefined || v > best)) best = v;
  }
  return best;
}

export function mergeDismiss(local: unknown, incoming: unknown): DismissFile {
  const lo = (local && typeof local === 'object' ? local : {}) as Record<string, unknown>;
  const inc = (incoming && typeof incoming === 'object' ? incoming : {}) as Record<string, unknown>;
  const out: DismissFile = {};
  const dsh = newest(asString(lo.dsh), asString(lo.date), asString(inc.dsh), asString(inc.date));
  const hull = newest(asString(lo.hull), asString(inc.hull));
  if (dsh !== undefined) out.dsh = dsh;
  if (hull !== undefined) out.hull = hull;
  return out;
}
