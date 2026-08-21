/**
 * ACPProvider（B4 执行集成，design §4.1 / 契约 §ACP 连接生命周期）
 *
 * B3 ExecutionProvider 的默认实现：spawn dsh ACP 子进程（JSON-RPC over stdio，
 * 可执行路径复用 M1 spawnArgs.ts）+ 连接生命周期（newSession/prompt/session.cancel/
 * agent_message_chunk/session/request_permission）+ 事件流到 ExecutionEvent。
 *
 * 实现约束（契约 §ExecutionProvider）：实现必须保证最终恰好一次 onResult（成功或
 * 失败路径）；异常/进程崩溃经 onResult 回传失败结果（exitCode!=0），不抛错逃逸。
 * cancel() 幂等（O-11：无会话则 kill 进程兜底）。
 *
 * 生命周期：
 *   execute() → spawn dsh ACP（dsh ACP 子命令已具备，若 spawn 失败 → failed）
 *             → newSession(cwd) → { sessionId }（超时/无响应 → failed）
 *             → prompt(sessionId, text=taskId+AC) → 流式
 *             ← agent_message_chunk（仅已提交文本）→ onEvent text_chunk
 *             ← session/request_permission { requestId, message } → onEvent permission_request
 *             → session/request_permission 响应 { requestId, approved, reason? }（用户决策）
 *             完成 → onResult { exitCode, summary, outputPath, selfCheck }
 *             取消 → session/cancel；无会话 → kill 进程
 *             子进程意外退出 → onResult failed（exec-provider-unavailable，P2-B4-2）
 */
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';

import { NOOP_LOGGER, type RuntimeLogger } from '../../shared/types';
import { dshBinPath } from '../../runtime/spawnArgs';
import type {
  ExecutionEvent,
  ExecutionHandlers,
  ExecutionProvider,
  ExecutionResult,
  ExecutionTask,
} from './ExecutionProvider';
import { JsonRpcClient } from './JsonRpcClient';

/** ACP 请求/通知方法名（契约 §ACP JSON-RPC 帧契约，集中收敛 JsonRpcClient 单一修改点） */
export const ACP_METHODS = {
  newSession: 'newSession',
  prompt: 'prompt',
  cancel: 'session/cancel',
  requestPermission: 'session/request_permission',
  /** dsh→壳 通知 */
  messageChunk: 'agent_message_chunk',
  /** dsh→壳 通知（审批请求） */
  permissionRequest: 'session/request_permission',
} as const;

export interface ACPProviderOptions {
  /** spawn 实现注入（测试 seam；默认 child_process.spawn） */
  spawnFn?: typeof spawn;
  /** 日志注入 */
  logger?: RuntimeLogger;
  /** 时钟（测试 seam；权限超时 / 结果生成） */
  now?: () => Date;
}

/** ACP 完成帧（dsh→壳）：result 结构对齐契约 selfCheck 回传（Q-015） */
interface AcpCompletion {
  summary?: string;
  outputPath?: string;
  selfCheck?: { passed: boolean; evidence?: string };
}

/** 权限请求上下文（ApprovalManager 消费；B2 非阻塞弹窗数据源） */
export interface PermissionRequestContext {
  taskId: string;
  title: string;
  requestId: string;
  message: string;
}

/**
 * ACP Provider：spawn dsh ACP 子进程 + JSON-RPC 帧收发 → ExecutionProvider 事件流。
 * 每个 execute() 独享一个 ACP 会话（无会话恢复/列表，O-11）。
 *
 * 🟡-3 收口：dsh 发 session/request_permission 通知时，在发 handlers.onEvent 的同时
 * emit `permission` 事件（载荷 PermissionRequestContext）——main 装配订阅此事件接入
 * ApprovalManager.handlePermission 入队（真实审批弹窗链路，收口 🟢-4 注记）。
 */
export class ACPProvider extends EventEmitter implements ExecutionProvider {
  private readonly spawnFn: typeof spawn;
  private readonly logger: RuntimeLogger;
  private readonly now: () => Date;

  constructor(options: ACPProviderOptions = {}) {
    super();
    this.spawnFn = options.spawnFn ?? spawn;
    this.logger = options.logger ?? NOOP_LOGGER;
    this.now = options.now ?? (() => new Date());
  }

  execute(task: ExecutionTask, handlers: ExecutionHandlers): { cancel(): Promise<void> } {
    // 每 execute 一个执行状态容器（cancel/完成 恰好一次）
    const state = {
      cancelled: false,
      settled: false,
      sessionId: undefined as string | undefined,
      client: undefined as JsonRpcClient | undefined,
      child: undefined as ReturnType<typeof spawn> | undefined,
    };
    // 崩溃拒绝回调：先于任何 client 构造注册（同步可能失败）
    let rejectCrash: (err: Error) => void = () => {};
    // 取消竞争：handle.cancel 触发（connect 期间无会话 → 取消走失败路径）
    let signalCancel: (() => void) | undefined;
    const cancelPromise = new Promise<never>((_resolve, reject) => {
      signalCancel = () => reject(new Error('执行已取消'));
    });

    const run = async (): Promise<void> => {
      try {
        const sessionId = await this.connect(task, handlers, state, cancelPromise, (reject) => (rejectCrash = reject));
        if (sessionId === undefined) return; // 已 settle（超时/崩溃/取消）
        state.sessionId = sessionId;
        handlers.onStatus('running');
        this.prompt(task, state, handlers);
      } catch (err) {
        this.settleFailure(task, handlers, state, (err as Error).message);
      }
    };

    const handle = {
      cancel: async () => {
        if (state.settled) return; // 幂等
        state.cancelled = true;
        signalCancel?.();
        const { client, sessionId } = state;
        if (client && sessionId !== undefined) {
          try {
            client.sendNotification(ACP_METHODS.cancel, { sessionId });
          } catch {
            /* 通道已断 → kill 兜底 */
          }
        }
        // 进程 kill 兜底（O-11 无会话 / 通道异常）
        if (state.child && state.child.exitCode === null && state.child.pid !== undefined) {
          try {
            state.child.kill('SIGTERM');
          } catch {
            /* 已退出 */
          }
        }
      },
      onCrash: (err: Error) => rejectCrash(err),
      /**
       * 回 ACP 审批响应（契约 §4.2：session/request_permission 响应 { requestId, approved, reason? }）。
       * 经 JsonRpcClient 发通知帧到 dsh 子进程；通道已断/无会话 → 静默（超时兜底由 ApprovalManager deny）。
       */
      respondPermission: (requestId: string, approved: boolean, reason?: string) => {
        if (state.settled) return;
        const client = state.client;
        if (!client || state.sessionId === undefined) return;
        const params: Record<string, unknown> = { sessionId: state.sessionId, requestId, approved };
        if (reason) params.reason = reason;
        try {
          client.sendNotification(ACP_METHODS.requestPermission, params);
        } catch {
          /* 通道已断 → 超时兜底 deny */
        }
      },
    };
    void run();
    return handle;
  }

  /** spawn + newSession；返回 sessionId；失败/崩溃/取消 → 回 failed 结果 */
  private async connect(
    task: ExecutionTask,
    handlers: ExecutionHandlers,
    state: ReturnType<typeof this.newState>,
    cancelPromise: Promise<never>,
    registerCrashReject: (reject: (err: Error) => void) => void,
  ): Promise<string | undefined> {
    const overlayDir = process.env.DSH_HOME ? `${process.env.DSH_HOME}/dsh` : undefined;
    if (!overlayDir) {
      this.settleFailure(task, handlers, state, 'DSH_HOME 未设置，无法定位 dsh ACP 子进程');
      return undefined;
    }
    const bin = dshBinPath(overlayDir);
    let child: ReturnType<typeof spawn>;
    try {
      // spawn 参数与 M1 web 子命令同构：node --expose-internals <bin> acp
      child = this.spawnFn('node', ['--expose-internals', bin, 'acp'], {
        cwd: overlayDir,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (err) {
      this.settleFailure(task, handlers, state, `dsh ACP 子进程启动失败: ${(err as Error).message}`);
      return undefined;
    }
    state.child = child;

    // 崩溃拒绝：任意错误（spawn error / exit 非 0 / 流断开）→ failed（exec-provider-unavailable，P2-B4-2）
    const crashPromise = new Promise<Error>((resolve) => {
      const onError = (err: Error) => resolve(new Error(`dsh ACP 通道异常: ${err.message}`));
      const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
        // 正常取消 kill 后退出不判崩溃
        if (state.cancelled) return;
        if (code === 0 && state.sessionId === undefined) return; // 未建会话前正常退出 → 走 newSession 失败路径
        resolve(new Error(`dsh ACP 子进程意外退出 (code=${code ?? 'null'}, signal=${signal ?? 'null'})`));
      };
      registerCrashReject(resolve);
      child.on('error', onError);
      child.on('exit', onExit);
    });
    const crashTask = crashPromise.then((err) => {
      if (!state.settled) this.settleFailure(task, handlers, state, err.message);
    });

    // newSession：超时（30s）→ failed
    const sessionPromise = new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('newSession 超时（30s 无响应）')), 30_000);
      void crashTask.then(() => reject(new Error('dsh ACP 连接已断开')));
      if (!child.stdin || !child.stdout) {
        clearTimeout(timer);
        reject(new Error('dsh ACP 子进程 stdio 不可用'));
        return;
      }
      const client = new JsonRpcClient({
        stdin: child.stdin,
        stdout: child.stdout,
        logger: this.logger,
      });
      state.client = client;
      // 通知订阅：agent_message_chunk → text_chunk；session/request_permission → permission_request
      client.onNotification(ACP_METHODS.messageChunk, (params) => {
        const p = params as { sessionId?: string; content?: string } | undefined;
        if (!p || typeof p.content !== 'string') return;
        if (!state.settled) handlers.onEvent({ kind: 'text_chunk', text: p.content });
      });
      client.onNotification(ACP_METHODS.permissionRequest, (params) => {
        const p = params as { requestId?: string; message?: string } | undefined;
        if (!p || typeof p.requestId !== 'string') return;
        if (state.settled) return;
        const ctx: PermissionRequestContext = {
          taskId: task.taskId,
          title: task.title,
          requestId: p.requestId,
          message: typeof p.message === 'string' ? p.message : '',
        };
        handlers.onEvent({
          kind: 'permission_request',
          id: p.requestId,
          message: ctx.message,
        });
        // 审批链路收口（B4）：permission 事件 → main 装配 → ApprovalManager.handlePermission 入队
        this.emit('permission', ctx);
      });
      void client
        .sendRequest<{ sessionId: string }>(ACP_METHODS.newSession, { cwd: overlayDir })
        .then(
          (r) => {
            clearTimeout(timer);
            if (r && typeof r.sessionId === 'string') resolve(r.sessionId);
            else reject(new Error('newSession 响应缺少 sessionId'));
          },
          (err: Error) => {
            clearTimeout(timer);
            reject(err);
          },
        );
    });

    // 三路竞争：newSession 完成 / 崩溃 / 取消
    const result = await Promise.race([
      sessionPromise.then((id) => ({ ok: true as const, id })),
      crashPromise.then((err) => ({ ok: false as const, err })),
      cancelPromise.then(
        () => ({ ok: false as const, err: new Error('执行已取消') }),
        (err: Error) => ({ ok: false as const, err }),
      ),
    ]);
    if (result.ok) return result.id;
    // 失败路径（超时/崩溃/取消）
    if (!state.settled) {
      state.settled = true;
      handlers.onStatus('failed');
      const errMsg = result.err.message;
      handlers.onResult({
        exitCode: 1,
        summary: errMsg.length > 4096 ? errMsg.slice(0, 4096) : errMsg,
        outputPath: '',
        selfCheck: { passed: false, evidence: errMsg },
      });
    }
    state.client?.dispose(result.err);
    if (state.child && state.child.exitCode === null) {
      try {
        state.child.kill('SIGTERM');
      } catch {
        /* 已退出 */
      }
    }
    return undefined;
  }

  /** prompt 提交 + 完成帧回执（onResult 恰好一次；崩溃经 connect 的 crashPromise 处理） */
  private prompt(
    task: ExecutionTask,
    state: ReturnType<typeof this.newState>,
    handlers: ExecutionHandlers,
  ): void {
    const client = state.client;
    if (!client) return;
    const text = buildPromptText(task);
    void client.sendRequest<AcpCompletion>(ACP_METHODS.prompt, { sessionId: state.sessionId, text }).then(
      (result) => {
        if (state.settled || state.cancelled) return;
        state.settled = true;
        handlers.onStatus('succeeded');
        const selfCheck = result?.selfCheck;
        handlers.onResult({
          exitCode: 0,
          summary: (result?.summary ?? '').slice(0, 4096),
          outputPath: result?.outputPath ?? '',
          ...(selfCheck ? { selfCheck } : {}),
        });
      },
      (err: Error) => {
        this.settleFailure(task, handlers, state, `ACP prompt 失败: ${err.message}`);
      },
    );
  }

  private settleFailure(
    _task: ExecutionTask,
    handlers: ExecutionHandlers,
    state: ReturnType<typeof this.newState>,
    message: string,
  ): void {
    if (state.settled) return;
    state.settled = true;
    state.cancelled = true;
    handlers.onStatus('failed');
    const summary = message.length > 4096 ? message.slice(0, 4096) : message;
    handlers.onResult({
      exitCode: 1,
      summary,
      outputPath: '',
      selfCheck: { passed: false, evidence: summary },
    });
  }

  private newState() {
    return {
      cancelled: false,
      settled: false,
      sessionId: undefined as string | undefined,
      client: undefined as JsonRpcClient | undefined,
      child: undefined as ReturnType<typeof spawn> | undefined,
    };
  }
}

/** prompt 文本（text 携带 taskId+AC，契约 §帧契约 prompt 参数） */
export function buildPromptText(task: ExecutionTask): string {
  const ac = task.ac;
  let text = `任务 ${task.taskId}：${task.title}`;
  if (ac) {
    text += `\n验收标准（AC）:\n- what: ${ac.what}\n- expected: ${ac.expected}\n- verify: ${ac.verify}`;
    if (ac.context) text += `\n- context: ${ac.context}`;
  }
  return text;
}
