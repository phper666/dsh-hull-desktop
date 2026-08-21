/**
 * ProviderRegistry（B4 多 agent 注册表，design §4.4 / 契约 §多 agent 注册表，CON-R030，P1-B4-2）
 *
 * - register(provider, factory)：幂等——同 provider 重复注册 = 覆盖旧 factory + 写日志，不报错；
 *   M2 仅 'dsh' 注册（U-002 预留第二平台，零改动接入）
 * - resolve(provider)：双重判定——① 未注册（registry 无键）→ ExecProviderUnavailableError
 *   （exec-provider-unavailable）；② 已注册但 factory 就绪检查失败 → 同样 exec-provider-unavailable
 * - list()/getAgentProviders 快照：available = resolve 双判能否通过（注册+就绪口径一致，P1-B4-2）
 * - subagentPolicy（CON-R030）：'auto'（默认，允许 dsh 内部调子 agent 含跨平台）/ 'restricted'
 *   （仅 dsh 自身）——B4 透传 agentSpec 语义，不实现子 agent 编排本身
 */
import { ExecProviderUnavailableError } from '../errors';

/** 平台标识（M2 仅 'dsh'，CON-R030 预留其他平台） */
export const DEFAULT_PROVIDER = 'dsh';

/** 子 agent 策略（CON-R030；契约 §多 agent 注册表 subagentPolicy） */
export type SubagentPolicy = 'auto' | 'restricted';

/** provider 注册项（factory：构造执行实现；isReady：就绪检查，可 spawn） */
export interface ProviderRegistration {
  /** 平台标识 */
  provider: string;
  /** UI 展示名 */
  displayName: string;
  /** 是否支持 subagentPolicy='auto' 编排（dsh ACP client 原生能力；缺省 true） */
  supportsSubagent?: boolean;
  /** 构造执行实现（default 为 B4 ACPProvider；U-002 第二平台接入点） */
  factory: () => unknown;
  /** 就绪检查（resolve 双判 ②：可 spawn 判定） */
  isReady?: () => boolean;
}

/** getAgentProviders 响应（契约 §ProviderInfo：available = 注册+就绪双判） */
export interface ProviderInfo {
  provider: string;
  displayName: string;
  available: boolean;
  supportsSubagent: boolean;
}

/** 按 agentSpec 分发的执行通道解析结果 */
export interface ResolvedProvider {
  provider: string;
  displayName: string;
  supportsSubagent: boolean;
  factory: () => unknown;
  /** agentSpec.subagentPolicy（默认 'auto'） */
  subagentPolicy: SubagentPolicy;
}

/**
 * 多 agent 注册表：register 幂等 / resolve 双判 / available 口径一致（P1-B4-2）。
 * M2 仅 'dsh' 注册；第二平台（U-002）后续 register 即接入，不改本体。
 */
export class ProviderRegistry {
  private readonly registrations = new Map<string, ProviderRegistration>();

  /**
   * 注册执行平台。幂等：同 provider 重复注册 = 覆盖旧 factory（写日志），不报错。
   */
  register(reg: ProviderRegistration, logger?: { warn: (m: string) => void }): void {
    const prev = this.registrations.get(reg.provider);
    if (prev) {
      (logger ?? console).warn(`ProviderRegistry: provider '${reg.provider}' 重复注册，覆盖旧 factory`);
    }
    this.registrations.set(reg.provider, {
      ...reg,
      supportsSubagent: reg.supportsSubagent ?? true,
      isReady: reg.isReady ?? (() => true),
    });
  }

  /**
   * 解析 agentSpec.provider → 对应执行实现。双重判定（P1-B4-2）：
   * ① 未注册 → ExecProviderUnavailableError；② 已注册但 isReady() 失败 → 同样错误。
   */
  resolve(provider: string, subagentPolicy: SubagentPolicy = 'auto'): ResolvedProvider {
    const reg = this.registrations.get(provider);
    if (!reg) {
      throw new ExecProviderUnavailableError(`执行通道未就绪，请检查 dsh：provider '${provider}' 未注册`);
    }
    if (!reg.isReady?.()) {
      throw new ExecProviderUnavailableError(`执行通道未就绪，请检查 dsh：provider '${provider}' 就绪检查失败`);
    }
    return {
      provider: reg.provider,
      displayName: reg.displayName,
      supportsSubagent: reg.supportsSubagent ?? true,
      factory: reg.factory,
      subagentPolicy,
    };
  }

  /** 注册表快照（available = resolve 双判能否通过，与 executeTask 口径一致） */
  list(): ProviderInfo[] {
    return [...this.registrations.values()].map((reg) => ({
      provider: reg.provider,
      displayName: reg.displayName,
      available: reg.isReady?.() ?? true,
      supportsSubagent: reg.supportsSubagent ?? true,
    }));
  }
}
