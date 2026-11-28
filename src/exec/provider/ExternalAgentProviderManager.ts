/**
 * 外部 ACP agent provider 生命周期管理器（U-002 第二平台插槽）
 *
 * 语义对齐 dsh 侧 ProviderManager 的「单例 + 只读暴露」，差异在设置可变：
 * - sync() 按当前 settings.externalAgent 解析启动命令；仅当命令签名变化才重建实例
 *   （name/PATH 变化不重建，PATH 直接 setPathSettings 下次 spawn 生效）
 * - 设置为关闭/命令不可解析 → provider 置空，旧实例后台 killAllChildren 断开
 * - registry.factory 闭包读 getProvider()：重建在「下次 resolve」生效，不打断在跑任务
 */
import type { RuntimeLogger } from '../../shared/types';
import type { ExternalAgentSettings } from '../../settings/SettingsProvider';
import { ACPProvider, type PermissionRequestContext } from './ACPProvider';
import { parseLaunchCommand } from './launchCommand';

export interface ExternalAgentProviderManagerOptions {
  /** 当前外部 agent 设置（每次 sync 动态读） */
  getExternalAgent: () => ExternalAgentSettings;
  /** 当前 PATH 设置（external agent spawn 环境补全） */
  getPathSettings: () => { extraPath: string[]; preferExtraPath: boolean };
  logger: RuntimeLogger;
  /** permission 事件接线（ApprovalManager.handlePermission） */
  onPermission: (ctx: PermissionRequestContext) => void;
  /** 模型清单探测硬超时（缺省 45s） */
  listModelsTimeoutMs?: number;
  /** node 可执行路径（PATH 补全同源解析） */
  nodePath?: string;
}

export class ExternalAgentProviderManager {
  private provider: ACPProvider | undefined;
  /** 被替换的旧实例（不立即 kill：在跑任务继续用旧配置跑完；退出编排统一断开） */
  private retired: ACPProvider[] = [];
  /** 当前实例的 launch 签名（command + args）；'' = 未启用/不可解析 */
  private signature = '';

  constructor(private readonly options: ExternalAgentProviderManagerOptions) {}

  /** 设置变化后同步：命令签名变化才重建；旧实例退役（下次 resolve 用新实例，不打断在跑任务）。 */
  sync(): void {
    const cfg = this.options.getExternalAgent();
    const launch = cfg.enabled ? parseLaunchCommand(cfg.command) : null;
    const signature = launch ? JSON.stringify([launch.command, launch.args]) : '';
    const path = this.options.getPathSettings();
    if (signature === this.signature) {
      this.provider?.setPathSettings(path.extraPath, path.preferExtraPath);
      return;
    }
    this.signature = signature;
    if (this.provider) this.retired.push(this.provider);
    this.provider = undefined;
    if (launch) {
      const provider = new ACPProvider({
        launch,
        logger: this.options.logger,
        listModelsTimeoutMs: this.options.listModelsTimeoutMs ?? 45_000,
        extraPath: path.extraPath,
        preferExtraPath: path.preferExtraPath,
        ...(this.options.nodePath ? { nodePath: this.options.nodePath } : {}),
      });
      provider.on('permission', this.options.onPermission);
      this.provider = provider;
    }
  }

  /** 当前实例（未启用/不可解析 → undefined；注册表 isReady 据此判定） */
  getProvider(): ACPProvider | undefined {
    return this.provider;
  }

  isReady(): boolean {
    return this.provider !== undefined;
  }

  /** 退出编排：断开当前 + 退役实例的全部子进程（防孤儿） */
  async killAllChildren(): Promise<void> {
    const all = [...this.retired, ...(this.provider ? [this.provider] : [])];
    this.retired = [];
    await Promise.all(all.map((p) => p.killAllChildren()));
  }
}
