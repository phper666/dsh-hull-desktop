/**
 * P3 插件操作门控（设计 §1.7）：复用 backup 门控语义——dsh 升级/安装中、壳自更新中、
 * 插件操作 in-flight 任一命中 → 拒绝（plugin-busy）。纯函数 + deps 注入，主进程 handler 内强制调用。
 * 反向互斥（设计 §2.4）：既有更新入口（upgradeDsh/downloadHullUpdate/rollbackDsh）前置 hasPluginInflight 检查。
 * 结果类型复用 types.ts 的 PluginGateResult（契约 §接口详情 6 门控态；拒绝码恒 plugin-busy）。
 */
import type { PluginGateResult } from './types';

export type GateResult = PluginGateResult;

export interface GateDeps {
  /** dsh 安装或升级进行中（InstallFlow / UpgradeQueue） */
  isUpgradeActive(): boolean;
  /** Hull 自更新进行中（HullUpdater.snapshot().phase） */
  isHullUpdateActive(): boolean;
  /** 插件安装/更新/卸载 in-flight（PluginInstaller.getSnapshot().inflight != null） */
  hasPluginInflight(): boolean;
}

export function canOperatePlugin(deps: GateDeps): PluginGateResult {
  if (deps.isUpgradeActive()) {
    return { ok: false, code: 'plugin-busy', message: 'dsh 安装或升级进行中，结束后再操作插件' };
  }
  if (deps.isHullUpdateActive()) {
    return { ok: false, code: 'plugin-busy', message: 'Hull 自更新进行中，结束后再操作插件' };
  }
  if (deps.hasPluginInflight()) {
    return { ok: false, code: 'plugin-busy', message: '插件安装/更新/卸载进行中，结束后再操作' };
  }
  return { ok: true };
}
