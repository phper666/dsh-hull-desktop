/**
 * Skills IPC handler 工厂（S1 契约 4 通道 + S2 契约 7 通道）
 * 纯工厂不依赖 electron——单测直调；electron 注册见 SkillsIpc.ts。
 * 响应统一包裹 { ok:true, data } | { ok:false, code, message }（对齐 KanbanIpcResult 形态）。
 */
import { HullError } from '../../shared/errors';
import { RestoreConflictError, SkillsUpgradeFailedError } from '../errors';

import type { RemoteRunner } from '../searchRemote';
import type { InstallRunner } from '../installRemote';
import type { SkillsScanner } from '../SkillsScanner';
import type { SkillsOps } from '../ops/SkillsOps';
import type { DisabledEntry, OperationLogEntry, RemoteSkillEntry, ScanSnapshot, StatusCounts, TrashEntry } from '../types';

/** 失败分支扩展字段（契约异常表：skills-upgrade-failed→method+rolledBack；restore-conflict→targetPath；io-error 带 path 则透传） */
export interface SkillsIpcErrorFields {
  method?: string;
  rolledBack?: boolean;
  targetPath?: string;
  path?: string;
}

export type SkillsIpcResult<T> = { ok: true; data: T } | ({ ok: false; code: string; message: string } & SkillsIpcErrorFields);

export interface SkillsHandlers {
  'skills:scan': () => Promise<SkillsIpcResult<ScanSnapshot>>;
  'skills:getSnapshot': () => Promise<SkillsIpcResult<ScanSnapshot>>;
  'skills:getStatus': () => Promise<SkillsIpcResult<StatusCounts>>;
  /** opts 仅测试/主进程内部可传（注入 runner）；IPC 注册层不透传（renderer 不可注入执行体） */
  'skills:searchRemote': (query: string, opts?: { runner?: RemoteRunner }) => Promise<SkillsIpcResult<{ entries: RemoteSkillEntry[] }>>;
  /** 远程安装（O-3：npx skills add <repo> -s <skill> -a <agent>） */
  'skills:installRemote': (skillRef: string, agent: string, opts?: { runner?: InstallRunner }) => Promise<SkillsIpcResult<{ installedRef: string; agent: string }>>;
  // ── S2 操作层（7 通道，feishu-s2-skills-api-contract §接口清单）──
  'skills:remove': (paths: string[]) => Promise<SkillsIpcResult<Array<{ path: string; status: string; trashId?: string; code?: string }>>>;
  'skills:upgrade': (path: string) => Promise<SkillsIpcResult<{ path: string; method: string; newHash: string }>>;
  'skills:setEnabled': (path: string, enabled: boolean) => Promise<SkillsIpcResult<{ path: string; enabled: boolean; entryId?: string }>>;
  /** 本地来源可填（O-3：写 SKILL.md frontmatter metadata.source） */
  'skills:setSource': (path: string, source: string) => Promise<SkillsIpcResult<{ path: string; source: string }>>;
  'skills:getDisabledList': () => Promise<SkillsIpcResult<{ entries: DisabledEntry[] }>>;
  'skills:getTrashList': () => Promise<SkillsIpcResult<{ entries: TrashEntry[]; totalSizeBytes: number }>>;
  'skills:restoreFromTrash': (trashId: string) => Promise<SkillsIpcResult<{ restoredPath: string }>>;
  'skills:getOperationLog': (limit?: number) => Promise<SkillsIpcResult<{ entries: OperationLogEntry[] }>>;
}

async function toResult<T>(fn: () => Promise<T>): Promise<SkillsIpcResult<T>> {
  try {
    return { ok: true, data: await fn() };
  } catch (err) {
    const base = { ok: false as const, code: err instanceof HullError ? err.code : 'unknown', message: (err as Error).message };
    if (!(err instanceof HullError)) return base;
    // 具名错误扩展字段随响应透传（P1-2：契约异常表要求达 IPC 响应，原先仅 {code,message}）
    if (err instanceof SkillsUpgradeFailedError) return { ...base, method: err.method, rolledBack: err.rolledBack };
    if (err instanceof RestoreConflictError) return { ...base, targetPath: err.targetPath };
    const p = (err as { path?: unknown }).path; // SkillsIoError 等若带 path 属性则透传
    return typeof p === 'string' ? { ...base, path: p } : base;
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
    'skills:installRemote': (skillRef: string, agent: string, opts?: { runner?: InstallRunner }) =>
      toResult(() => scanner.installRemote(skillRef, agent, opts)),
    'skills:remove': (paths: string[]) => toResult(() => ops.remove(paths)),
    'skills:upgrade': (path: string) => toResult(() => ops.upgrade(path)),
    'skills:setEnabled': (path: string, enabled: boolean) => toResult(() => ops.setEnabled(path, enabled)),
    'skills:setSource': (path: string, source: string) => toResult(() => ops.setSource(path, source)),
    'skills:getDisabledList': () => toResult(async () => ({ entries: ops.getDisabledList() })),
    'skills:getTrashList': () => toResult(() => ops.getTrashList()),
    'skills:restoreFromTrash': (trashId: string) => toResult(() => ops.restoreFromTrash(trashId)),
    'skills:getOperationLog': (limit?: number) => toResult(async () => ({ entries: ops.getOperationLog(limit) })),
  };
}
