/**
 * Agent 对话 IPC 注册（8 通道：7 invoke + 1 推送）
 *
 * 响应包裹与既有 IPC 惯例一致：{ ok:true, data } | { ok:false, code, message }。
 * service 未配置（settings.externalAgent 未启用/命令解析失败）→ chat-not-configured；
 * agent:status 降级为「未连接」快照（UI 首载不报错）；cancel/close 幂等（无 service 也 ok）。
 * 推送 agent:onEvent 由 main 转发（webContents.send，不在此文件持有窗口）。
 */
import { ipcMain } from 'electron';

import type { AgentChatService, AgentChatStatus } from './AgentChatService';

/** 推送通道（main → 渲染层；preload onEvent 订阅） */
export const AGENT_PUSH_CHANNEL = 'agent:onEvent';

export interface AgentChatIpcDeps {
  /** 当前可用 service（未配置 → null） */
  getService: () => AgentChatService | null;
}

export type AgentChatIpcResult<T = void> =
  | (T extends void ? { ok: true } : { ok: true; data: T })
  | { ok: false; code: string; message: string };

function notConfigured(): { ok: false; code: string; message: string } {
  return { ok: false, code: 'chat-not-configured', message: '未配置外部 Agent（设置 → 外部 Agent 命令）' };
}

function failure(err: unknown): { ok: false; code: string; message: string } {
  const code = (err as { code?: unknown })?.code;
  return {
    ok: false,
    code: typeof code === 'string' ? code : 'unknown',
    message: (err as Error).message,
  };
}

export function registerAgentChatIpc(deps: AgentChatIpcDeps): void {
  ipcMain.handle(
    'agent:start',
    async (): Promise<AgentChatIpcResult<{ sessionId: string; agent: { name: string; version: string } }>> => {
      const service = deps.getService();
      if (!service) return notConfigured();
      try {
        return { ok: true, data: await service.start() };
      } catch (err) {
        return failure(err);
      }
    },
  );

  ipcMain.handle('agent:send', async (_e, text: unknown): Promise<AgentChatIpcResult> => {
    if (typeof text !== 'string' || text === '') {
      return { ok: false, code: 'invalid-params', message: 'text 必须是非空字符串' };
    }
    const service = deps.getService();
    if (!service) return notConfigured();
    try {
      await service.send(text);
      return { ok: true };
    } catch (err) {
      return failure(err);
    }
  });

  ipcMain.handle('agent:cancel', async (): Promise<AgentChatIpcResult> => {
    deps.getService()?.cancel();
    return { ok: true };
  });

  ipcMain.handle('agent:close', async (): Promise<AgentChatIpcResult> => {
    await deps.getService()?.close();
    return { ok: true };
  });

  ipcMain.handle(
    'agent:approve',
    async (_e, requestId: unknown, approved: unknown, reason?: unknown): Promise<AgentChatIpcResult> => {
      if (typeof requestId !== 'string' || typeof approved !== 'boolean') {
        return { ok: false, code: 'invalid-params', message: 'requestId 字符串 + approved boolean 必填' };
      }
      const service = deps.getService();
      if (!service) return notConfigured();
      service.approve(requestId, approved, typeof reason === 'string' ? reason : undefined);
      return { ok: true };
    },
  );

  ipcMain.handle('agent:status', async (): Promise<AgentChatIpcResult<AgentChatStatus>> => {
    const service = deps.getService();
    return { ok: true, data: service ? service.status() : { connected: false, busy: false } };
  });
}
