/**
 * N1 IPC 注册（契约 §接口清单：10 invoke 通道闭合 + 1 推送；对齐 KanbanIpc/SkillsHandlers 惯例）
 * toResult 统一包裹 + HullError code 透传 + 失败分支扩展字段（detected/targetPath/path）随响应透传
 * （对齐 src/skills/ipc/skillsHandlers.ts:15）。路径守卫单点：所有收路径参数通道第一步 pathGuard（设计 §4.7）。
 */
import { ipcMain } from 'electron';

import { HullError } from '../shared/errors';

import { isValidTrashId, resolveSafeNotePath } from './pathGuard';
import { NOTES_ERRORS, type SaveInput } from './types';
import type { NotesService } from './NotesService';

/** 11 invoke 通道白名单（notes:indexChanged 为 M→R 推送，不注册 handle） */
export const NOTES_IPC_HANDLERS = [
  'notes:index',
  'notes:get',
  'notes:save',
  'notes:create',
  'notes:mkdir',
  'notes:rmdir',
  'notes:move',
  'notes:delete',
  'notes:trashList',
  'notes:restore',
  'notes:purge',
  'notes:search',
] as const;

/** 推送通道（main 经 webContents.send） */
export const NOTES_PUSH_CHANNEL = 'notes:indexChanged';

/** IPC 统一响应包裹 + 扩展字段（detected/targetPath/path，契约 §错误与异常） */
export type NotesIpcResult<T> =
  | { ok: true; data: T }
  | ({ ok: false; code: string; message: string } & {
      detected?: { diskMtime: string };
      targetPath?: string;
      path?: string;
    });

async function toResult<T>(fn: () => T | Promise<T>): Promise<NotesIpcResult<T>> {
  try {
    return { ok: true, data: await fn() };
  } catch (err) {
    const base = {
      ok: false as const,
      code: err instanceof HullError ? err.code : 'unknown',
      message: (err as Error).message,
    };
    if (!(err instanceof HullError)) return base;
    const e = err as HullError & { detected?: { diskMtime: string }; targetPath?: string; path?: string };
    if (e.detected) return { ...base, detected: e.detected };
    if (typeof e.targetPath === 'string') return { ...base, targetPath: e.targetPath };
    if (typeof e.path === 'string') return { ...base, path: e.path };
    return base;
  }
}

/** path 参数守卫：安全校验后回传相对路径（resolveSafeNotePath 产绝对路径仅用于校验；
 *  Store/Trash 以 notes.dir 相对路径为事实源自行 join——直传绝对路径会双重拼接致 ENOENT，wave-1 集成修复） */
function validatePathParam(path: unknown, service: NotesService): string {
  if (typeof path !== 'string') throw new HullError(NOTES_ERRORS.pathInvalid, `路径非法: ${String(path)}`);
  resolveSafeNotePath(service.getNotesDir(), path);
  return path;
}

export function registerNotesIpc(service: NotesService): void {
  // 1 notes:index：仅读快照，不触发扫描
  ipcMain.handle('notes:index', () => toResult(() => service.index()));
  // 2 notes:get
  ipcMain.handle('notes:get', (_e, path: unknown) =>
    toResult(() => service.get(validatePathParam(path, service)))
  );
  // 3 notes:save（乐观锁 + 冲突分流；saveAsCopy 副本名在 Store 派生）
  ipcMain.handle('notes:save', (_e, input: SaveInput) =>
    toResult(() => {
      validatePathParam(input?.path, service);
      return service.save(input);
    })
  );
  // 4 notes:create（dir 缺省 = notes.dir 根）
  ipcMain.handle('notes:create', (_e, dir?: unknown, title?: unknown) =>
    toResult(() => service.create(validateDirParam(dir, service), typeof title === 'string' ? title : undefined))
  );
  // 4b notes:mkdir（v1.1 集成期补获，Q-075「+ 新建目录」；幂等）
  ipcMain.handle('notes:mkdir', (_e, dir: unknown) =>
    toResult(() => {
      if (typeof dir !== 'string' || dir === '') {
        throw new HullError(NOTES_ERRORS.pathInvalid, `目录名非法: ${String(dir)}`);
      }
      return service.mkdir(dir);
    })
  );
  // 4c notes:rmdir（v1.2，CON-R-notes-015：仅空目录可删，不进回收站）
  ipcMain.handle('notes:rmdir', (_e, dir: unknown) =>
    toResult(() => {
      if (typeof dir !== 'string' || dir === '' || dir === '.') {
        throw new HullError(NOTES_ERRORS.pathInvalid, `目录名非法: ${String(dir)}`);
      }
      return service.rmdir(dir);
    })
  );
  // 5 notes:move（targetDir 须为已存在真实子目录，Service 内复核存在性）
  ipcMain.handle('notes:move', (_e, path: unknown, targetDir: unknown) =>
    toResult(() => service.move(validatePathParam(path, service), validateDirParam(targetDir, service) ?? '.'))
  );
  // 6 notes:delete
  ipcMain.handle('notes:delete', (_e, path: unknown) =>
    toResult(() => service.delete(validatePathParam(path, service)))
  );
  // 7 notes:trashList（惰性清理在 Service 内）
  ipcMain.handle('notes:trashList', () => toResult(() => service.trashList()));
  // 8 notes:restore（trashId 白名单校验）
  ipcMain.handle('notes:restore', (_e, trashId: unknown) =>
    toResult(() => {
      if (!isValidTrashId(trashId)) throw new HullError(NOTES_ERRORS.notFound, `trashId 非法: ${String(trashId)}`);
      return service.restore(trashId);
    })
  );
  // 9 notes:purge
  ipcMain.handle('notes:purge', (_e, trashId: unknown) =>
    toResult(() => {
      if (!isValidTrashId(trashId)) throw new HullError(NOTES_ERRORS.notFound, `trashId 非法: ${String(trashId)}`);
      return service.purge(trashId);
    })
  );
  // 10 notes:search（标题+全文子串，空串 = 全部）
  ipcMain.handle('notes:search', (_e, query: unknown) => toResult(() => service.search(String(query ?? ''))));
}

/** dir 参数守卫：空/undefined = 根；否则按路径安全解析（拒 ../绝对/隐藏段） */
function validateDirParam(dir: unknown, service: NotesService): string | undefined {
  if (dir === undefined || dir === '') return undefined;
  resolveSafeNotePath(service.getNotesDir(), dir);
  return dir as string;
}
