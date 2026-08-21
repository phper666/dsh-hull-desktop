/**
 * B3 ProviderManager（design §4.7 / §5 技术栈，冻结）
 *
 * 两级桩/真实 provider 切换：`HULL_EXEC_PROVIDER=mock` 仅 debug/test 生效（复用 M1
 * HULL_PROBE_TARGET env 注入先例），生产忽略回落 ACP（真实实现）。
 *
 * - provider 只读暴露（getProvider()）：每次 execute() 由 ExecutionProvider 自身
 *   维护独立执行状态，ProviderManager 无跨执行共享态，返回单例即可。
 * - B4 ProviderRegistry（多 agent 注册表）后续消费本模块做 provider 生命周期。
 */
import type { ExecutionProvider } from './ExecutionProvider';
import { ACPProvider } from './ACPProvider';
import { MockProvider } from './MockProvider';

export interface ProviderManagerOptions {
  /** env 读取注入（测试 seam；默认 process.env） */
  env?: NodeJS.ProcessEnv;
  /** ACP provider 工厂（默认 new ACPProvider()） */
  acpFactory?: () => ExecutionProvider;
}

/**
 * provider 选择管理器：HULL_EXEC_PROVIDER=mock → MockProvider（仅 debug/test）；
 * 否则 → ACPProvider（真实 dsh ACP，B3 execute() 默认实现，B4 深化）。
 */
export class ProviderManager {
  private readonly provider: ExecutionProvider;
  private readonly mode: 'mock' | 'acp';

  constructor(options: ProviderManagerOptions = {}) {
    const env = options.env ?? process.env;
    const isMock = env.HULL_EXEC_PROVIDER === 'mock';
    this.mode = isMock ? 'mock' : 'acp';
    if (isMock) {
      this.provider = new MockProvider();
    } else {
      this.provider = options.acpFactory ? options.acpFactory() : new ACPProvider();
    }
  }

  /** 当前生效 provider 实现 */
  getProvider(): ExecutionProvider {
    return this.provider;
  }

  /** 当前模式（测试/日志） */
  get modeName(): 'mock' | 'acp' {
    return this.mode;
  }
}
