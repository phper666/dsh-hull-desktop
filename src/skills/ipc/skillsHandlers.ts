/**
 * Skills IPC handler 工厂（S1 契约 4 通道 + S2 契约 7 通道）
 * 纯工厂不依赖 electron——单测直调；electron 注册见 SkillsIpc.ts。
 * 响应统一包裹 { ok:true, data } | { ok:false, code, message }（对齐 KanbanIpcResult 形态）。
 */
import { HullError } from '../../shared/errors';

import type { RemoteRunner } from '../searchRemote';
import type { SkillsScanner } from '../SkillsScanner';
import type { SkillsOps } from '../ops/SkillsOps';
import type { DisabledEntry, OperationLogEntry, RemoteSkillEntry, ScanSnapshot, StatusCounts, TrashEntry } from '../types';

export type SkillsIpcResult<T> = { ok: true; data: T } | { ok: false; code: string; message: string };

export interface SkillsHandlers {
  'skills:scan': () => Promise<SkillsIpcResult<ScanSnapshot>>;
  'skills:getSnapshot': () => Promise<SkillsIpcResult<ScanSnapshot>>;
  'skills:getStatus': () => Promise<SkillsIpcResult<StatusCounts>>;
  /** opts 仅测试/主进程内部可传（注入 runner）；IPC 注册层不透传（renderer 不可注入执行体） */
  'skills:searchRemote': (query: string, opts?: { runner?: RemoteRunner }) => Promise<SkillsIpcResult<{ entries: RemoteSkillEntry[] }>>;
  // ── S2 操作层（7 通道，feishu-s2-skills-api-contract §接口清单）──
  'skills:remove': (paths: string[]) => Promise<SkillsIpcResult<Array<{ path: string; status: string; trashId?: string; code?: string }>>>;
  'skills:upgrade': (path: string) => Promise<SkillsIpcResult<{ path: string; method: string; newHash: string }>>;
  'skills:setEnabled': (path: string, enabled: boolean) => Promise<SkillsIpcResult<{ path: string; enabled: boolean; entryId?: string }>>;
  'skills:getDisabledList': () => Promise<SkillsIpcResult<{ entries: DisabledEntry[] }>>;
  'skills:getTrashList': () => Promise<SkillsIpcResult<{ entries: TrashEntry[]; totalSizeBytes: number }>>;
  'skills:restoreFromTrash': (trashId: string) => Promise<SkillsIpcResult<{ restoredPath: string }>>;
  'skills:getOperationLog': (limit?: number) => Promise<SkillsIpcResult<{ entries: OperationLogEntry[] }>>;
}

async function toResult<T>(fn: () => Promise<T>): Promise<SkillsIpcResult<T>> {
  try {
    return { ok: true, data: await fn() };
  } catch (err) {
    return { ok: false, code: err instanceof HullError ? err.code : 'unknown', message: (err as Error).message };
  }
}

export function createSkillsHandlers(scanner: SkillsScanner, ops?: SkillsOps): SkillsHandlers {
  if (!ops) throw new Error('createSkillsHandlers 需要 SkillsOps（S2 起操作层必装配）');
  return {
    'skills:scan': () => toResult(() => scanner.scan()),
    'skills:getSnapshot': () => toResult(async () => scanner.snapshot()),
    'skills:getStatus': () => toResult(async () => scanner.statusCounts()),
    'skills:searchRemote': (query: string, opts?: { runner?: RemoteRunner }) =>
      toResult(async () => ({ entries: await scanner.searchRemote(query, opts) })),
    'skills:remove': (paths: string[]) => toResult(() => ops.remove(paths)),
    'skills:upgrade': (path: string) => toResult(() => ops.upgrade(path)),
    'skills:setEnabled': (path: string, enabled: boolean) => toResult(() => ops.setEnabled(path, enabled)),
    'skills:getDisabledList': () => toResult(async () => ({ entries: ops.getDisabledList() })),
    'skills:getTrashList': () => toResult(() => ops.getTrashList()),
    'skills:restoreFromTrash': (trashId: string) => toResult(() => ops.restoreFromTrash(trashId)),
    'skills:getOperationLog': (limit?: number) => toResult(async () => ({ entries: ops.getOperationLog(limit) })),
  };
}
