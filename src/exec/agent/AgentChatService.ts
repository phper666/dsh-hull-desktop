/**
 * Agent 对话服务（M1：壳内长驻外部 ACP agent 会话 + 流式 + 审批）
 *
 * 与 execute()（一次性任务）的区别：本服务 spawn 一次 → initialize → session/new 一次 →
 * 多次 session/prompt（同一会话多轮，上下文在 agent 侧累积）。单实例单会话；close 后 start 可重开。
 *
 * 传输复用 JsonRpcClient（NDJSON 帧 / 请求响应分发 / server→client REQUEST 回帧）；
 * 事件形状 = IPC 契约（agent:onEvent 推送），由 main 转发 webContents.send。
 *
 * 生命周期：
 *   start() → spawn(launch, cwd=homedir) → initialize → session/new → status connected
 *   send(text) → session/prompt（无超时）→ 流式 message_chunk → turn_end{stopReason}
 *   cancel() → session/cancel 通知（agent 回 stopReason cancelled）
 *   approve(requestId, approved) → 回 REQUEST 响应帧 {requestId, approved, reason}（契约 §3.6）
 *   close() → SIGTERM → 5s → SIGKILL；崩溃（非主动关闭）→ error 事件 + status error，下次 start 可重来
 */
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { homedir } from 'node:os';
import { dirname } from 'node:path';

import { augmentPathEnv } from '../../runtime/spawnArgs';
import { NOOP_LOGGER, type RuntimeLogger } from '../../shared/types';
import { ACP_METHODS } from '../provider/ACPProvider';
import { JsonRpcClient } from '../provider/JsonRpcClient';
import type { LaunchSpec } from '../provider/launchCommand';

/** 会话事件（agent:onEvent 推送载荷；渲染层按 kind 分派） */
export type AgentChatEvent =
  | { kind: 'status'; state: AgentChatState; message?: string }
  | { kind: 'message_chunk'; text: string }
  | { kind: 'tool_call'; id: string; title: string; toolKind?: string; status: string }
  | { kind: 'tool_call_update'; id: string; status: string; content?: unknown }
  | { kind: 'permission_request'; requestId: string; message: string }
  | { kind: 'turn_end'; stopReason: string }
  | { kind: 'error'; message: string };

export type AgentChatState = 'starting' | 'connected' | 'busy' | 'idle' | 'closed' | 'error';

/** 对外状态快照（agent:status 返回 payload） */
export interface AgentChatStatus {
  connected: boolean;
  busy: boolean;
  sessionId?: string;
  agentName?: string;
  lastError?: string;
}

export interface AgentChatDeps {
  /** 启动命令（settings.externalAgent.command 经 parseLaunchCommand 解析） */
  launch: LaunchSpec;
  /** spawn 环境（缺省：PATH 补全；测试可注入） */
  spawnEnv?: () => NodeJS.ProcessEnv;
  logger?: RuntimeLogger;
  /** 测试注入 spawn */
  spawnFn?: typeof spawn;
  /** 握手单步超时（initialize / session-new 各一次；默认 15000） */
  handshakeTimeoutMs?: number;
}

interface PendingPermission {
  /** JSON-RPC 请求 id（回响应帧用） */
  id: number;
  /** 业务 requestId（响应 result.requestId 回显） */
  businessRequestId: string;
}

const DEFAULT_HANDSHAKE_TIMEOUT_MS = 15_000;
/** close 优雅窗口：SIGTERM 后等进程自行退出，超时 SIGKILL 兜底 */
const CLOSE_GRACE_MS = 5_000;
/** SIGKILL 后等 exit 事件的兜底窗口 */
const KILL_WAIT_MS = 1_000;
/** stderr 单行日志上限（防 agent 吐巨型行淹没日志） */
const STDERR_LINE_MAX = 2048;

/** 简单字符串错误码（不新建错误体系；IPC 透传 code） */
function chatError(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}

/** 缺省 spawn 环境：PATH 补全（打包版 PATH 精简，否则 agent 内子命令找不到 java/node 等） */
function defaultSpawnEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.toUpperCase() === 'PATH') delete env[key];
  }
  env.PATH = augmentPathEnv({
    basePath: process.env.PATH ?? process.env.Path,
    nodePath: dirname(process.execPath),
    home: homedir(),
  });
  return env;
}

/** 审批文案提取（契约 §3.6：question 优先，其次 message.content 文本块） */
function permissionText(
  p: { question?: string; message?: { content?: Array<{ type?: string; text?: string }> } } | undefined,
): string {
  if (typeof p?.question === 'string') return p.question;
  const blocks = p?.message?.content;
  if (!Array.isArray(blocks)) return '';
  return blocks
    .filter((b) => typeof b?.text === 'string' && (b.type === undefined || b.type === 'text'))
    .map((b) => b.text)
    .join('\n');
}

export class AgentChatService extends EventEmitter {
  private readonly launch: LaunchSpec;
  private readonly spawnEnv: () => NodeJS.ProcessEnv;
  private readonly logger: RuntimeLogger;
  private readonly spawnFn: typeof spawn;
  private readonly handshakeTimeoutMs: number;

  private child: ReturnType<typeof spawn> | null = null;
  private client: JsonRpcClient | null = null;
  private starting: Promise<{ sessionId: string; agent: { name: string; version: string } }> | null = null;
  private sessionId: string | undefined;
  private agentName: string | undefined;
  private agentVersion = '';
  private connected = false;
  private busy = false;
  private closing = false;
  private errored = false;
  private lastError: string | undefined;
  private stderrBuffer = '';
  private readonly pendingPermissions = new Map<string, PendingPermission>();

  constructor(deps: AgentChatDeps) {
    super();
    this.launch = deps.launch;
    this.spawnEnv = deps.spawnEnv ?? defaultSpawnEnv;
    this.logger = deps.logger ?? NOOP_LOGGER;
    this.spawnFn = deps.spawnFn ?? spawn;
    this.handshakeTimeoutMs = deps.handshakeTimeoutMs ?? DEFAULT_HANDSHAKE_TIMEOUT_MS;
  }

  /** spawn + initialize + session/new；已连接 → 返回当前会话（幂等） */
  async start(): Promise<{ sessionId: string; agent: { name: string; version: string } }> {
    if (this.starting) return this.starting;
    if (this.connected && this.sessionId) {
      return { sessionId: this.sessionId, agent: { name: this.agentName ?? '', version: this.agentVersion } };
    }
    if (this.child) await this.close(); // 上次握手半途失败残留进程 → 先清干净
    const p = this.doStart();
    this.starting = p;
    try {
      return await p;
    } finally {
      if (this.starting === p) this.starting = null;
    }
  }

  /** 同一会话提交一轮（busy/未连接拒绝；流式走事件） */
  async send(text: string): Promise<void> {
    if (!this.connected || !this.client || !this.sessionId) {
      throw chatError('chat-not-connected', '外部 Agent 未连接，请先 start');
    }
    if (this.busy) throw chatError('chat-busy', '外部 Agent 正在回复，请等待本轮结束');
    const client = this.client;
    const sessionId = this.sessionId;
    this.busy = true;
    // 回合结束才清 busy（prompt 无超时：真实回合含工具调用 + 审批等待）
    try {
      const result = await client.sendRequest<{ stopReason?: string }>(
        ACP_METHODS.prompt,
        { sessionId, prompt: [{ type: 'text', text }] },
        0,
      );
      const stopReason = typeof result?.stopReason === 'string' ? result.stopReason : 'end_turn';
      this.emitEvent({ kind: 'turn_end', stopReason });
    } finally {
      this.busy = false;
      this.pendingPermissions.clear();
      if (this.connected) this.emitEvent({ kind: 'status', state: 'idle' });
    }
  }

  /** session/cancel 通知（agent 侧结束当前回合，prompt 回 stopReason cancelled） */
  cancel(): void {
    if (!this.client || !this.sessionId) return;
    this.client.sendNotification(ACP_METHODS.cancel, { sessionId: this.sessionId });
  }

  /** 回审批 REQUEST 响应帧（契约 §3.6：{requestId, approved, reason}） */
  approve(requestId: string, approved: boolean, reason?: string): void {
    const rec = this.pendingPermissions.get(requestId);
    if (!rec) return;
    if (!this.client) return;
    this.pendingPermissions.delete(requestId);
    this.client.sendResponse(rec.id, { requestId: rec.businessRequestId, approved, reason: reason ?? '' });
  }

  /** 优雅关停：SIGTERM → 5s → SIGKILL；幂等 */
  async close(): Promise<void> {
    this.closing = true;
    this.connected = false;
    this.busy = false;
    this.pendingPermissions.clear();
    this.client?.dispose(new Error('外部 Agent 会话已关闭'));
    this.client = null;
    const child = this.child;
    if (child && child.exitCode === null) {
      await new Promise<void>((resolve) => {
        let settled = false;
        let killTimer: NodeJS.Timeout | undefined;
        const finish = (): void => {
          if (settled) return;
          settled = true;
          if (killTimer) clearTimeout(killTimer);
          resolve();
        };
        child.once('exit', finish);
        try {
          child.kill('SIGTERM');
        } catch {
          finish();
          return;
        }
        killTimer = setTimeout(() => {
          try {
            child.kill('SIGKILL');
          } catch {
            /* 已退出 */
          }
          setTimeout(finish, KILL_WAIT_MS).unref?.();
        }, CLOSE_GRACE_MS);
      });
    }
    this.reset();
    this.closing = false;
    this.emitEvent({ kind: 'status', state: 'closed' });
  }

  status(): AgentChatStatus {
    return {
      connected: this.connected,
      busy: this.busy,
      ...(this.sessionId ? { sessionId: this.sessionId } : {}),
      ...(this.agentName ? { agentName: this.agentName } : {}),
      ...(this.lastError ? { lastError: this.lastError } : {}),
    };
  }

  private async doStart(): Promise<{ sessionId: string; agent: { name: string; version: string } }> {
    this.reset();
    this.lastError = undefined;
    this.emitEvent({ kind: 'status', state: 'starting' });
    let child: ReturnType<typeof spawn>;
    try {
      child = this.spawnFn(this.launch.command, this.launch.args, {
        cwd: homedir(),
        stdio: ['pipe', 'pipe', 'pipe'],
        env: this.spawnEnv(),
      });
    } catch (err) {
      this.fail(`外部 Agent 子进程启动失败: ${(err as Error).message}`);
      throw chatError('chat-not-connected', this.lastError!);
    }
    this.child = child;
    child.stderr?.on('data', (chunk: Buffer | string) => this.logStderr(chunk));
    // 崩溃（spawn error / 非主动关闭的 exit）→ error 事件 + status error
    child.once('error', (err: Error) => this.fail(`外部 Agent 子进程异常: ${err.message}`));
    child.once('exit', (code, signal) => {
      if (this.closing) return;
      this.fail(`外部 Agent 子进程意外退出 (code=${code ?? 'null'}, signal=${signal ?? 'null'})`);
    });
    if (!child.stdin || !child.stdout) {
      this.fail('外部 Agent 子进程 stdio 不可用');
      throw chatError('chat-not-connected', this.lastError!);
    }

    const client = new JsonRpcClient({ stdin: child.stdin, stdout: child.stdout, logger: this.logger });
    this.client = client;
    this.subscribe(client);

    try {
      const init = await client.sendRequest<{ agentInfo?: { name?: string; version?: string } }>(
        ACP_METHODS.initialize,
        { protocolVersion: 1, clientCapabilities: {} },
        this.handshakeTimeoutMs,
      );
      const session = await client.sendRequest<{ sessionId?: string }>(
        ACP_METHODS.newSession,
        { cwd: homedir(), mcpServers: [] },
        this.handshakeTimeoutMs,
      );
      if (!session || typeof session.sessionId !== 'string' || session.sessionId === '') {
        throw new Error('session/new 响应缺少 sessionId');
      }
      this.sessionId = session.sessionId;
      this.agentName = typeof init?.agentInfo?.name === 'string' ? init.agentInfo.name : '';
      this.agentVersion = typeof init?.agentInfo?.version === 'string' ? init.agentInfo.version : '';
      this.connected = true;
      this.errored = false;
      this.emitEvent({ kind: 'status', state: 'connected' });
      return { sessionId: this.sessionId, agent: { name: this.agentName, version: this.agentVersion } };
    } catch (err) {
      // 崩溃路径已由 fail() 落 error 事件；此处只兜协议/超时失败
      if (!this.errored) this.fail(`外部 Agent 握手失败: ${(err as Error).message}`);
      throw chatError('chat-not-connected', this.lastError ?? (err as Error).message);
    }
  }

  private subscribe(client: JsonRpcClient): void {
    client.onNotification(ACP_METHODS.sessionUpdate, (params) => {
      const p = params as {
        update?: {
          sessionUpdate?: string;
          content?: { text?: string };
          toolCallId?: unknown;
          title?: unknown;
          kind?: unknown;
          status?: unknown;
        };
      } | undefined;
      const u = p?.update;
      if (!u) return;
      if (u.sessionUpdate === 'agent_message_chunk') {
        const text = typeof u.content?.text === 'string' ? u.content.text : '';
        if (text) this.emitEvent({ kind: 'message_chunk', text });
        return;
      }
      if (u.sessionUpdate === 'tool_call') {
        if (typeof u.toolCallId !== 'string') return;
        this.emitEvent({
          kind: 'tool_call',
          id: u.toolCallId,
          title: typeof u.title === 'string' ? u.title : '',
          ...(typeof u.kind === 'string' ? { toolKind: u.kind } : {}),
          status: typeof u.status === 'string' ? u.status : 'pending',
        });
        return;
      }
      if (u.sessionUpdate === 'tool_call_update') {
        if (typeof u.toolCallId !== 'string') return;
        this.emitEvent({
          kind: 'tool_call_update',
          id: u.toolCallId,
          status: typeof u.status === 'string' ? u.status : 'pending',
          ...(u.content !== undefined ? { content: u.content } : {}),
        });
      }
    });
    client.onRequest(ACP_METHODS.requestPermission, (params, id) => {
      const p = params as { requestId?: unknown; question?: string; message?: { content?: Array<{ type?: string; text?: string }> } } | undefined;
      const businessRequestId = typeof p?.requestId === 'string' ? p.requestId : String(id);
      this.pendingPermissions.set(businessRequestId, { id, businessRequestId });
      this.emitEvent({
        kind: 'permission_request',
        requestId: businessRequestId,
        message: permissionText(p),
      });
    });
  }

  /** 记录失败 + 一次性 error 事件（崩溃/协议失败共用；主动 close 不触发） */
  private fail(message: string): void {
    if (this.closing || this.errored) return;
    this.errored = true;
    this.lastError = message;
    this.connected = false;
    this.busy = false;
    this.sessionId = undefined;
    this.pendingPermissions.clear();
    this.client?.dispose(new Error(message));
    this.client = null;
    this.logger.error(`[agent-chat] ${message}`);
    this.emitEvent({ kind: 'error', message });
    this.emitEvent({ kind: 'status', state: 'error', message });
  }

  private reset(): void {
    this.child = null;
    this.client = null;
    this.sessionId = undefined;
    this.agentName = undefined;
    this.agentVersion = '';
    this.connected = false;
    this.busy = false;
    this.errored = false;
    this.stderrBuffer = '';
  }

  /** stderr → logger（stdout 只归 client；单行截断 2KB） */
  private logStderr(chunk: Buffer | string): void {
    this.stderrBuffer += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    let idx: number;
    while ((idx = this.stderrBuffer.indexOf('\n')) >= 0) {
      const line = this.stderrBuffer.slice(0, idx).trimEnd();
      this.stderrBuffer = this.stderrBuffer.slice(idx + 1);
      if (!line) continue;
      const shown = line.length > STDERR_LINE_MAX ? `${line.slice(0, STDERR_LINE_MAX)}…` : line;
      this.logger.info(`[agent-chat] ${shown}`);
    }
    if (this.stderrBuffer.length > STDERR_LINE_MAX) {
      this.logger.info(`[agent-chat] ${this.stderrBuffer.slice(0, STDERR_LINE_MAX)}…`);
      this.stderrBuffer = '';
    }
  }

  private emitEvent(ev: AgentChatEvent): void {
    this.emit('event', ev);
  }
}
