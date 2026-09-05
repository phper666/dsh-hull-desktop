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
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { EventEmitter } from 'node:events';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

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

/**
 * ACP 请求/通知方法名（标准 ACP = Zed Agent Client Protocol；Q-017-C：dsh 0.1.2-rc.1
 * 的 acp profile 实现标准协议——真机重放实锤：自造 newSession/prompt → error -32601
 * Method not found，正确序列 = initialize → session/new → session/prompt）
 */
export const ACP_METHODS = {
  /** 握手第一步：协议版本 + 客户端能力协商 */
  initialize: 'initialize',
  /** 握手第二步：建会话（标准 ACP session/new，params 含 mcpServers） */
  newSession: 'session/new',
  /** 提交任务（标准 ACP session/prompt，params.prompt = 内容块数组） */
  prompt: 'session/prompt',
  cancel: 'session/cancel',
  /** 审批请求（server→client REQUEST，带 id 须回 response 帧） */
  requestPermission: 'session/request_permission',
  /** dsh→壳 流式通知（sessionUpdate 变体字段分派：agent_message_chunk/tool_call/plan…） */
  sessionUpdate: 'session/update',
  /** Q-018 模型选择：按会话设置模型（configId='model'，value = configOptions 的 value JSON 串） */
  setConfigOption: 'session/set_config_option',
  /** Q-022 会话复用：恢复既有会话（dsh acp 扩展方法，非标准 ACP load；cwd 必须与会话原 cwd 一致） */
  resume: 'session/resume',
} as const;

/** 握手单步超时（initialize + session/new 各 15s，合计覆盖原 30s 预算，Q-017-C） */
const HANDSHAKE_STEP_TIMEOUT_MS = 15_000;

/** Q-018 模型清单：configOptions[model].options 分组项（dsh 含自定义模型渠道，原样透传） */
export interface ModelOptionItem {
  value: string;
  name: string;
  description?: string;
}
export interface ModelOptionGroup {
  group?: string;
  name?: string;
  options: ModelOptionItem[];
}
export type ModelOption = ModelOptionGroup;

/** listModels 进程内缓存 TTL（5 分钟；overlayDir 为键） */
const MODEL_CACHE_TTL_MS = 5 * 60_000;

/** Q-018：默认 dsh 设置文件路径（~/.dsh/settings.yaml；不经 DSH_HOME env——壳红线零引用，homedir 先例同 token 扫描器） */
function defaultDshSettingsPath(): string {
  return join(homedir(), '.dsh', 'settings.yaml');
}

/** settings.yaml llm-pi-ai.providers 解析中间态（route → displayName/models） */
interface SettingsProvider {
  route: string;
  displayName?: string;
  models: Array<{ id: string; name?: string }>;
}

/** 去除 YAML 标量两侧引号（dsh 生成文件偶见引号包裹值） */
function stripYamlQuotes(v: string): string {
  const t = v.trim();
  if (t.length >= 2 && ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'")))) {
    return t.slice(1, -1);
  }
  return t;
}

/**
 * Q-018：settings.yaml 顶层 `llm-pi-ai.providers` 段最小行级解析（壳零新增依赖；
 * 只需本固定结构——route(4 缩进)/displayName,models(6)/model item(8 `- id:`)/name(10)）。
 * 结构异常/字段缺失 → 尽力提取已识别部分，绝不抛错（调用方还有 try 兜底）。
 */
export function parseLlmPiAiProviders(content: string): SettingsProvider[] {
  const out: SettingsProvider[] = [];
  let section: 'none' | 'llm' | 'providers' = 'none';
  let current: SettingsProvider | null = null;
  let inModels = false;
  for (const raw of content.split('\n')) {
    if (!raw.trim() || raw.trim().startsWith('#')) continue;
    const line = raw.replace(/\t/g, '  ');
    const indent = line.length - line.trimStart().length;
    const trimmed = line.trim();
    if (indent === 0) {
      // 顶层键：仅 llm-pi-ai: 进入目标段，其余全部退出
      section = trimmed === 'llm-pi-ai:' ? 'llm' : 'none';
      current = null;
      inModels = false;
      continue;
    }
    if (section === 'none') continue;
    if (section === 'llm') {
      if (indent >= 2 && trimmed === 'providers:') section = 'providers';
      continue;
    }
    // providers 段：route 键固定 4 缩进；<2 缩进离开（回 llm 兄弟键）
    if (indent <= 2) {
      section = 'llm';
      current = null;
      inModels = false;
      continue;
    }
    if (indent === 4) {
      // route 键固定 4 缩进；无条件切换（即使上一 route 的 models 段未显式结束——
      // 新 route 即边界，真机实锤：models 后直接跟下一 route 的 4 缩进键）
      const m = trimmed.match(/^([^:#]+):\s*$/);
      if (m) {
        current = { route: stripYamlQuotes(m[1]), models: [] };
        out.push(current);
        inModels = false;
      }
      continue;
    }
    if (!current) continue;
    if (indent === 6) {
      // route 子键：models: 进入模型列表；displayName: 记录分组显示名；其余忽略
      inModels = trimmed === 'models:';
      if (!inModels && trimmed.startsWith('displayName:')) {
        const v = stripYamlQuotes(trimmed.slice('displayName:'.length));
        if (v) current.displayName = v;
      }
      continue;
    }
    if (inModels && indent >= 8) {
      const idm = trimmed.match(/^-\s*id:\s*(.+)$/);
      if (idm) {
        const id = stripYamlQuotes(idm[1]);
        if (id) current.models.push({ id });
        continue;
      }
      const nm = trimmed.match(/^name:\s*(.+)$/);
      if (nm && current.models.length > 0) {
        const v = stripYamlQuotes(nm[1]);
        if (v) current.models[current.models.length - 1].name = v;
      }
    }
  }
  return out;
}

export interface ACPProviderOptions {
  /** spawn 实现注入（测试 seam；默认 child_process.spawn） */
  spawnFn?: typeof spawn;
  /** 日志注入 */
  logger?: RuntimeLogger;
  /** 时钟（测试 seam；权限超时 / 结果生成） */
  now?: () => Date;
  /**
   * Q-017-B：dsh overlay 目录显式注入（壳自管 dsh 在 <userData>/dsh，与 DSH_HOME/dsh
   * 结构同构）。优先于 env.DSH_HOME——壳红线 DSH_HOME 零引用（main/index.ts），用户
   * 环境通常未设，硬依赖 env 会导致每任务必然 settleFailure。缺省回退 env.DSH_HOME
   * （测试/外部环境兼容）。
   */
  overlayDir?: string;
  /** Q-018：settings.yaml 路径注入（测试 seam；缺省 ~/.dsh/settings.yaml，listModels 自定义渠道来源，只读） */
  settingsPath?: string;
  /** Q-023：listModels 整体硬超时（缺省 45s；测试 seam 注入短超时）——渲染层 await 不永久挂起 */
  listModelsTimeoutMs?: number;
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
  private readonly overlayDir?: string;
  /** Q-018：settings.yaml 路径注入（测试 seam；缺省 ~/.dsh/settings.yaml，只读 CON-R002） */
  private readonly settingsPath?: string;
  /** Q-023：listModels 整体硬超时（缺省 45s） */
  private readonly listModelsTimeoutMs: number;
  /** Q-018：listModels 进程内缓存（overlayDir → {at, groups}） */
  private readonly modelsCache = new Map<string, { at: number; data: ModelOption[] }>();

  constructor(options: ACPProviderOptions = {}) {
    super();
    this.spawnFn = options.spawnFn ?? spawn;
    this.logger = options.logger ?? NOOP_LOGGER;
    this.now = options.now ?? (() => new Date());
    this.overlayDir = options.overlayDir;
    this.settingsPath = options.settingsPath;
    this.listModelsTimeoutMs = options.listModelsTimeoutMs ?? 45_000;
  }

  execute(task: ExecutionTask, handlers: ExecutionHandlers): { cancel(): Promise<void> } {
    // 每 execute 一个执行状态容器（cancel/完成 恰好一次）
    const state = this.newState();
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
        // Q-027：有会话 → 优雅关停（cancel 是 dsh 正常流程，杀太急截断会话尾部落盘 → resume corrupt）；
        // 无会话（握手期取消）→ 立即 kill（O-11：无会话无落盘风险，进程必须终止）
        if (client && sessionId !== undefined) {
          this.shutdownGraceful(state);
        } else if (state.child && state.child.exitCode === null && state.child.pid !== undefined) {
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
        void reason; // 标准 ACP 响应帧无 reason 字段（审批文案留在壳侧 ApprovalManager 记录）
        if (state.settled) return;
        const client = state.client;
        if (!client) return;
        // Q-017-C：标准 ACP permission 是 server→client REQUEST——按业务 requestId
        //（= JSON-RPC id 字符串）找在途请求，回 response 帧 selected outcome
        const rec = state.pendingPermissions.get(requestId);
        if (!rec) return;
        state.pendingPermissions.delete(requestId);
        client.sendResponse(rec.id, { outcome: { outcome: 'selected', optionId: pickOptionId(rec.options, approved) } });
      },
    };
    void run();
    return handle;
  }

  /**
   * Q-018 模型清单：独立轻量会话拉取 configOptions[model].options（分组原样透传，
   * 含 dsh 自定义模型渠道）。spawn acp 子进程 → initialize → session/new → 提取 → kill。
   * 5 分钟进程内缓存（overlayDir 为键），避免渲染层每次打开选择器都起子进程。
   */
  async listModels(overlayDir?: string): Promise<ModelOption[]> {
    const dir =
      overlayDir ?? this.overlayDir ?? (process.env.DSH_HOME ? `${process.env.DSH_HOME}/dsh` : undefined);
    if (!dir) throw new Error('无法定位 dsh ACP 子进程（DSH_HOME 未设置且未注入 overlayDir）');
    const cached = this.modelsCache.get(dir);
    if (cached && Date.now() - cached.at < MODEL_CACHE_TTL_MS) return cached.data;
    // Q-023 探测子进程隔离：DSH_HOME 指向临时 home——探测会话落临时 sessions，不污染真实 ~/.dsh/sessions
    const tmpHome = mkdtempSync(join(tmpdir(), 'hull-probe-'));
    try {
      // Q-018 收尾：清单 = acp configOptions 内置分组 ⊕ settings.yaml llm-pi-ai.providers 自定义分组
      //（acp 会话 configOptions 实测不含自定义渠道，但 set_config_option 接受其 value——执行链路已通）
      const acpGroups = await this.fetchModels(dir, tmpHome);
      const data = this.mergeSettingsModelGroups(acpGroups);
      this.modelsCache.set(dir, { at: Date.now(), data });
      return data;
    } finally {
      rmSync(tmpHome, { recursive: true, force: true }); // 探测结束清理（返回/超时/异常三路径）
    }
  }

  /** Q-018：读 settings.yaml（缺失/解析失败 → 静默跳过）并合并自定义渠道分组（acp 在前，value 去重） */
  private mergeSettingsModelGroups(acpGroups: ModelOption[]): ModelOption[] {
    const seen = new Set<string>();
    for (const g of acpGroups) {
      for (const o of g.options) seen.add(o.value);
    }
    const merged = [...acpGroups];
    for (const provider of this.readSettingsProviders()) {
      if (provider.models.length === 0) continue;
      const options = provider.models
        .map((m) => ({ value: JSON.stringify([provider.route, m.id]), name: m.name ?? m.id }))
        .filter((o) => !seen.has(o.value));
      if (options.length === 0) continue;
      for (const o of options) seen.add(o.value);
      merged.push({ group: provider.route, name: provider.displayName ?? provider.route, options });
    }
    return merged;
  }

  /** Q-018：读 settings.yaml 提取 llm-pi-ai.providers（CON-R002 只读；任何异常 → 空数组跳过该来源） */
  private readSettingsProviders(): SettingsProvider[] {
    let content: string;
    try {
      content = readFileSync(this.settingsPath ?? defaultDshSettingsPath(), 'utf8');
    } catch {
      return []; // 文件不存在/不可读 → 静默跳过
    }
    try {
      return parseLlmPiAiProviders(content);
    } catch {
      return []; // 解析异常 → 静默跳过
    }
  }

  /** 轻量会话：握手 + session/new 读 configOptions[model]（用完即弃，kill 子进程） */
  private async fetchModels(dir: string, tmpHome: string): Promise<ModelOption[]> {
    const bin = dshBinPath(dir);
    // Q-023：DSH_HOME=临时 home（会话落临时 sessions）；bin 仍 overlayDir——内置分组来自 dsh 安装本身，
    // 不受隔离影响，清单完整性不变；自定义渠道本来走 settings.yaml 合并
    const child = this.spawnFn('node', ['--expose-internals', bin, '--profile', 'acp'], {
      cwd: dir,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, DSH_HOME: tmpHome },
    });
    this.logger.info(`[Q-023] 模型清单探测子进程已启动 pid=${child.pid ?? '?'}`);
    const client = new JsonRpcClient({ stdin: child.stdin, stdout: child.stdout, logger: this.logger });
    // Q-023 整体硬超时兜底：spawn→initialize→session/new 任一环节挂起 → reject「模型清单获取超时」
    // → IPC {ok:false} → 渲染层隐藏降级，不再永久卡「加载模型中…」；
    // 兜底在 child 可达的 finally 内——超时/异常路径同样 kill 子进程不残留
    let hardTimer: NodeJS.Timeout | undefined;
    const hardTimeout = new Promise<never>((_, reject) => {
      hardTimer = setTimeout(() => reject(new Error('模型清单获取超时')), this.listModelsTimeoutMs);
      hardTimer.unref?.();
    });
    try {
      const groups = await Promise.race([
        (async (): Promise<ModelOption[]> => {
          await client.sendRequest<unknown>(ACP_METHODS.initialize, { protocolVersion: 1, clientCapabilities: {} }, HANDSHAKE_STEP_TIMEOUT_MS);
          this.logger.info('[Q-023] 探测 initialize ok');
          const ns = await client.sendRequest<{ configOptions?: Array<{ id?: string; options?: ModelOption[] }> }>(
            ACP_METHODS.newSession,
            { cwd: dir, mcpServers: [] },
            HANDSHAKE_STEP_TIMEOUT_MS,
          );
          this.logger.info('[Q-023] 探测 session/new ok');
          const model = (ns?.configOptions ?? []).find((c) => c.id === 'model');
          const result = model?.options ?? [];
          this.logger.info(`[Q-023] 模型清单返回分组数=${result.length}`);
          return result;
        })(),
        hardTimeout,
      ]);
      return groups;
    } finally {
      if (hardTimer) clearTimeout(hardTimer);
      client.dispose();
      client.dispose();
      if (child.exitCode === null) {
        try {
          child.kill('SIGTERM');
        } catch {
          /* 已退出 */
        }
      }
    }
  }

  /** spawn + newSession；返回 sessionId；失败/崩溃/取消 → 回 failed 结果 */
  private async connect(
    task: ExecutionTask,
    handlers: ExecutionHandlers,
    state: ReturnType<typeof this.newState>,
    cancelPromise: Promise<never>,
    registerCrashReject: (reject: (err: Error) => void) => void,
  ): Promise<string | undefined> {
    // Q-017-B：注入 overlayDir 优先（壳自管 <userData>/dsh），回退 env.DSH_HOME（兼容保留）
    const overlayDir = this.overlayDir ?? (process.env.DSH_HOME ? `${process.env.DSH_HOME}/dsh` : undefined);
    if (!overlayDir) {
      this.settleFailure(task, handlers, state, '无法定位 dsh ACP 子进程（DSH_HOME 未设置且未注入 overlayDir）');
      return undefined;
    }
    // Q-019 工作目录防御：会话 cwd 必须 exists（agent 在指定目录干活 + 会话归组）；
    // 不存在 → 直接失败不 spawn（错误信息带路径，UI 可引导修正）
    if (!existsSync(task.cwd)) {
      this.settleFailure(task, handlers, state, `工作目录不存在: ${task.cwd}`);
      return undefined;
    }
    const bin = dshBinPath(overlayDir);
    let child: ReturnType<typeof spawn>;
    try {
      // spawn 参数与 M1 web 子命令同构：node --expose-internals <bin> acp
      // dsh CLI 契约（0.1.2 README「入口模式」）：ACP 是 profile 不是子命令——
      // `dsh acp` 会被当成 profile args，缺 --profile 直接 exit 1（实测 0.1.1-rc.2/0.1.2-rc.1）
      child = this.spawnFn('node', ['--expose-internals', bin, '--profile', 'acp'], {
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

    // newSession：两步握手（initialize → session/new）+ 超时（30s 总预算）→ failed
    const sessionPromise = new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('ACP 握手超时（30s 无响应）')), 30_000);
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
      // 通知订阅（Q-017-C 标准 ACP）：session/update 通知按 sessionUpdate 变体分派——
      // agent_message_chunk → text_chunk（流式心跳，Q-026），tool_call/plan 等其他变体忽略
      client.onNotification(ACP_METHODS.sessionUpdate, (params) => {
        const p = params as { update?: { sessionUpdate?: string; content?: { text?: string } } } | undefined;
        const u = p?.update;
        if (!u || u.sessionUpdate !== 'agent_message_chunk') return;
        const text = typeof u.content?.text === 'string' ? u.content.text : '';
        if (!text) return;
        state.summaryText += text; // 流式文本聚合（结算 summary 用）
        if (!state.settled) handlers.onEvent({ kind: 'text_chunk', text });
      });
      // 审批请求（Q-017-C 标准 ACP）：session/request_permission 是 server→client REQUEST
      //（带 id，须回 response 帧 {outcome:{outcome:'selected',optionId}}）——旧通知 +
      // 业务 requestId 形态废弃，业务 requestId = JSON-RPC id 字符串
      client.onRequest(ACP_METHODS.requestPermission, (params, id) => {
        if (state.settled) return;
        const p = params as { question?: string; options?: Array<{ optionId?: string; id?: string; kind?: string; name?: string }> } | undefined;
        const requestId = String(id);
        state.pendingPermissions.set(requestId, {
          id,
          options: Array.isArray(p?.options) ? p.options : [],
        });
        const message = typeof p?.question === 'string' ? p.question : '';
        handlers.onEvent({ kind: 'permission_request', id: requestId, message });
        // 审批链路收口（B4）：permission 事件 → main 装配 → ApprovalManager.handlePermission 入队
        this.emit('permission', { taskId: task.taskId, title: task.title, requestId, message } satisfies PermissionRequestContext);
      });
      // 两步握手（Q-017-C）：先 initialize（协议版本协商）成功后再 session/new（建会话）；
      // 共用上方 30s 总预算 timer，单步各 15s 兜底
      const newSession = (): Promise<{ sessionId: string }> =>
        client.sendRequest<{ sessionId: string }>(
          ACP_METHODS.newSession,
          // Q-019：cwd = task.cwd（原为 overlayDir——会话全归「未分组」且 agent 无法在任务目录干活）
          { cwd: task.cwd, mcpServers: [] },
          HANDSHAKE_STEP_TIMEOUT_MS,
        );
      // Q-022 会话复用：task 带 resumeSessionId → 先 session/resume 续用（cwd 必须一致）；
      // 任一错误（cwd mismatch / not resumable / 会话丢失）→ 优雅降级 session/new（一次重试，
      // 用户无感；降级原因 log 一行）。无 resumeSessionId → 直接 session/new
      const handshake = client
        .sendRequest<unknown>(ACP_METHODS.initialize, { protocolVersion: 1, clientCapabilities: {} }, HANDSHAKE_STEP_TIMEOUT_MS)
        .then(() => {
          if (!task.resumeSessionId) return newSession();
          return client
            .sendRequest<unknown>(
              ACP_METHODS.resume,
              { sessionId: task.resumeSessionId, cwd: task.cwd, mcpServers: [] },
              HANDSHAKE_STEP_TIMEOUT_MS,
            )
            .then(
              // Q-022 真机实测：resume 成功响应可能不带 sessionId 字段——会话 id 已知（task.resumeSessionId），
              // 兜底使用之（否则误判失败触发多余降级）
              (r) => ({ sessionId: r && typeof (r as { sessionId?: string }).sessionId === 'string' ? (r as { sessionId: string }).sessionId : task.resumeSessionId! }),
              (err: Error) => {
                // Q-025：resume 失败 → 降级 newSession；损坏会话日志（-32603 corrupt session log，
                // 真机实锤「seq gap in committed region」）单列 warn——旧引用已废，结算侧清空
                // task.acpSessionId，下次执行不再白试坏 id；其余失败（cwd mismatch 等）info 降级
                state.resumeFailed = true;
                if (err.message.includes('corrupt session log') || err.message.includes('-32603')) {
                  this.logger.warn(`[Q-025] resume 失败（损坏会话日志），已降级新建并清除会话引用: ${err.message}`);
                } else {
                  this.logger.info(`[Q-022] 会话恢复失败，降级新建会话: ${err.message}`);
                }
                return newSession();
              },
            );
        });
      handshake.then(
        (r) => {
          clearTimeout(timer);
          if (!r || typeof r.sessionId !== 'string') {
            reject(new Error('session/new 响应缺少 sessionId'));
            return;
          }
          // Q-018/Q-021 会话配置：task 带模型/推理力度 → session/new 后逐项 session/set_config_option
          //（顺序：model 先 effort 后），全部成功才进 prompt；不带 → 跳过（dsh 默认）。
          // error → 走既有失败路径（onStatus failed + onResult，错误信息带「XX设置失败」）
          const configure = (configId: string, value: string, label: string): Promise<void> =>
            client
              .sendRequest<unknown>(
                ACP_METHODS.setConfigOption,
                { sessionId: r.sessionId, configId, value },
                HANDSHAKE_STEP_TIMEOUT_MS,
              )
              .then(
                () => undefined,
                (err: Error) => {
                  clearTimeout(timer);
                  throw new Error(`${label}设置失败: ${err.message}`);
                },
              );
          let configureChain: Promise<void> = Promise.resolve();
          if (task.model) configureChain = configureChain.then(() => configure('model', task.model!, '模型'));
          if (task.reasoningEffort) configureChain = configureChain.then(() => configure('reasoning_effort', task.reasoningEffort!, '推理力度'));
          configureChain.then(
            () => {
              state.sessionId = r.sessionId; // Q-022：会话建立成功，供 onResult 回传
              resolve(r.sessionId);
            },
            (err: Error) => reject(err),
          );
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
    // Q-027：失败结算（超时/崩溃/取消）同样优雅关停——子进程可能正在 flush 会话尾部
    this.shutdownGraceful(state);
    return undefined;
  }

  /**
   * Q-027 acp 子进程优雅关停（根因：dsh 会话持久化是异步写，settle/cancel 后立即 SIGTERM
   * 打断回合尾部落盘 → seq 回退/空洞 → 下次 resume corrupt（真机会话 085d7e4b 实证）。
   * 序列：dispose 关闭 stdin → dsh 正常 flush 会话并自然退出 → grace 1500ms 轮询 exitCode →
   * 窗口内未退出才 SIGTERM 兜底。fire-and-forget：结算已 resolve，关停后台进行，不阻塞 IPC 返回。
   */
  private shutdownGraceful(state: ReturnType<typeof this.newState>): void {
    state.client?.dispose();
    const child = state.child;
    if (!child || child.exitCode !== null) return; // 无子进程/已退出 → 无事可做
    const GRACE_MS = 1500;
    const poll = setInterval(() => {
      if (child.exitCode !== null) clearInterval(poll); // 自然退出 ✓（轮询只读，不写 exitCode）
    }, 100);
    setTimeout(() => {
      clearInterval(poll);
      if (child.exitCode === null) {
        try {
          child.kill('SIGTERM');
          this.logger.info('[Q-027] 优雅关停窗口超时，SIGTERM 兜底');
        } catch {
          /* 已退出 */
        }
      }
    }, GRACE_MS);
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
    // Q-017-C 标准 ACP：session/prompt，params.prompt = 内容块数组（[{type:'text',text}]）；
    // 响应 {stopReason}——成功语义不变：收到响应 = 通道侧正常完成（exitCode 0，
    // selfCheck 缺省 → 判定归 VerifyGate）；summary 用 session/update 聚合文本
    void client
      .sendRequest<{ stopReason?: string }>(
        ACP_METHODS.prompt,
        { sessionId: state.sessionId, prompt: [{ type: 'text', text }] },
        // Q-024：session/prompt 无超时——真实回合（工具调用 + 审批等待 + 多轮 LLM）远超 30s，
        // 超时即 settleFailure 杀子进程（工具调用半途 → resume 后报 tool call interrupted）。
        // 取消走 session/cancel + cancel 句柄；壳退出/子进程退出自然终止
        0,
      )
      .then(
        (result) => {
          if (state.settled || state.cancelled) return;
          state.settled = true;
          handlers.onStatus('succeeded');
          handlers.onResult({
            exitCode: 0,
            summary: state.summaryText.slice(0, 4096),
            outputPath: '',
            // Q-022：会话已建立 → 结算回写 task.acpSessionId（重跑 resume 续用）
            ...(state.sessionId ? { sessionId: state.sessionId } : {}),
            // Q-025：resume 失败降级标记（新 id 覆盖 / new 也失败时清空引用）
            ...(state.resumeFailed ? { resumeFailed: true } : {}),
          });
          // Q-027：结算已 resolve → 后台优雅关停（dsh flush 会话尾部后自然退出；
          // 立即 SIGTERM 打断异步落盘 → seq 回退/空洞 → resume corrupt，真机实证）
          this.shutdownGraceful(state);
          void result; // stopReason 'end_turn' 等均为正常完成（不做分支，保持既有成功语义）
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
      // Q-022：失败但会话已建立（resume/new 成功后 prompt 阶段失败）→ 也回写，重跑续用
      ...(state.sessionId ? { sessionId: state.sessionId } : {}),
      // Q-025：resume 失败降级标记（含降级 new 也失败的无 sessionId 形态 → 结算清空引用）
      ...(state.resumeFailed ? { resumeFailed: true } : {}),
    });
    // Q-027：失败结算同样优雅关停（prompt 失败时子进程可能仍在 flush；崩溃已退出 → no-op）
    this.shutdownGraceful(state);
  }

  private newState() {
    return {
      cancelled: false,
      settled: false,
      sessionId: undefined as string | undefined,
      client: undefined as JsonRpcClient | undefined,
      child: undefined as ReturnType<typeof spawn> | undefined,
      // Q-017-C：session/update 流式文本聚合（结算 summary 用）
      summaryText: '',
      // Q-017-C：在途审批请求（业务 requestId=String(jsonrpcId) → jsonrpc id + 选项表）
      pendingPermissions: new Map<string, { id: number; options: Array<{ optionId?: string; id?: string; kind?: string; name?: string }> }>(),
      // Q-025：resume 失败已降级（结算侧据此清/覆盖 task.acpSessionId，损坏 id 不留）
      resumeFailed: false,
    };
  }
}

/** prompt 文本（text 携带 taskId+描述+AC，契约 §帧契约 prompt 参数） */
export function buildPromptText(task: ExecutionTask): string {
  const ac = task.ac;
  let text = `任务 ${task.taskId}：${task.title}`;
  // Q-026：描述必须进 prompt——否则 agent 只看到标题，会话自动标题也变成「任务 <id>：标题」
  if (task.description) text += `\n任务描述：${task.description}`;
  if (ac) {
    text += `\n验收标准（AC）:\n- what: ${ac.what}\n- expected: ${ac.expected}\n- verify: ${ac.verify}`;
    if (ac.context) text += `\n- context: ${ac.context}`;
  }
  return text;
}

/**
 * Q-024/Bug-B：按 approved 布尔从权限选项表选 optionId。
 * 对齐 dsh-acp 真实形态（源码实锤）：options 字段名是 **optionId**（非 id），kind 取值
 * 'allow_once'/'reject_once'，硬编码 optionId 'allow-once'/'reject-once'——此前取 hit.id
 * 恒为 undefined → dsh 按 `outcome.optionId === "allow-once" ? allowed : rejected`
 * 把批准一律当拒绝（用户实测「批准无效」根因）。兼容 id 字段名（标准 ACP 文档形态）。
 */
function pickOptionId(options: Array<{ optionId?: string; id?: string; kind?: string; name?: string }>, approved: boolean): string {
  const want = approved ? /allow/i : /reject/i;
  const hit = options.find(
    (o) => (typeof o.kind === 'string' && want.test(o.kind)) || (typeof o.name === 'string' && want.test(o.name)),
  );
  return hit?.optionId ?? hit?.id ?? (approved ? 'allow-once' : 'reject-once');
}
