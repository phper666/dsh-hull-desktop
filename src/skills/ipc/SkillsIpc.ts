/**
 * Skills IPC channel 注册（S1 契约 4 通道 + S2 契约 7 通道）
 * main 侧：ipcMain.handle('skills:*') → SkillsScanner/SkillsOps。错误统一转
 * { ok:false, code, message }（skillsHandlers.toResult）。
 * 安全边界：renderer 输入一律不可信——类型强校验后透传；runner 等执行体不可经 IPC 注入；
 * 本地搜索无通道（frontend-only，Q-036）；导航走 hull:showSkills（main/index.ts 直注册）。
 */
import { ipcMain } from 'electron';

import type { SkillsOps } from '../ops/SkillsOps';
import type { SkillsScanner } from '../SkillsScanner';
import { createSkillsHandlers } from './skillsHandlers';

export function registerSkillsIpc(scanner: SkillsScanner, ops: SkillsOps): void {
  const handlers = createSkillsHandlers(scanner, ops);
  ipcMain.handle('skills:scan', () => handlers['skills:scan']());
  ipcMain.handle('skills:getSnapshot', () => handlers['skills:getSnapshot']());
  ipcMain.handle('skills:getStatus', () => handlers['skills:getStatus']());
  // renderer 输入不可信：仅接受字符串 query，其余按空串走 validation-error
  ipcMain.handle('skills:searchRemote', (_e, query: unknown) =>
    handlers['skills:searchRemote'](typeof query === 'string' ? query : '')
  );
  // ── S2 操作层（破坏性通道：类型强校验，非法入参 → validation-error）──
  ipcMain.handle('skills:remove', (_e, paths: unknown) => {
    const list = Array.isArray(paths) && paths.every((p) => typeof p === 'string') ? (paths as string[]) : [];
    return handlers['skills:remove'](list);
  });
  ipcMain.handle('skills:upgrade', (_e, path: unknown) =>
    handlers['skills:upgrade'](typeof path === 'string' ? path : '')
  );
  ipcMain.handle('skills:setEnabled', (_e, path: unknown, enabled: unknown) =>
    handlers['skills:setEnabled'](typeof path === 'string' ? path : '', enabled === true)
  );
  ipcMain.handle('skills:getDisabledList', () => handlers['skills:getDisabledList']());
  ipcMain.handle('skills:getTrashList', () => handlers['skills:getTrashList']());
  ipcMain.handle('skills:restoreFromTrash', (_e, trashId: unknown) =>
    handlers['skills:restoreFromTrash'](typeof trashId === 'string' ? trashId : '')
  );
  ipcMain.handle('skills:getOperationLog', (_e, limit: unknown) =>
    handlers['skills:getOperationLog'](typeof limit === 'number' ? limit : undefined)
  );
}
