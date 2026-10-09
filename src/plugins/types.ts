/**
 * 插件市场类型（设计 §3.1 / 契约 §Schema）：字段与契约一致，单点定义（src/plugins/types.ts）。
 */

import type { PluginErrorCode } from './errors';

/** RegistryEntry（plugins.json 条目，契约 §Schema） */
export interface RegistryEntry {
  /** 插件名（展示；白名单逐字命中标识，设计 §1.4） */
  name: string;
  /** 作者/仓库 owner */
  owner: string;
  /** 安装源（npm / github:owner/repo / tgz；必须 https，白名单校验） */
  url: string;
  /** 分类（市场 tab 筛选） */
  category?: string;
  /** 安装命令提示（dsh-market 兼容字段） */
  install?: string;
  /** 弃用标记（缺省 false；UI 禁用安装 + 提示） */
  deprecated?: boolean;
  /** 最低 dsh 版本（semver；低于当前 → 安装前提示，不拦截） */
  minDshVersion?: string;
}

/** InstalledPlugin.status（契约 §Schema） */
export type PluginStatus = 'installed' | 'updatable' | 'deprecated';

/**
 * 稳定标识（设计 §1.4 v2）：name#owner 复合键（真实 registry 182 组重名 → 防装错）。
 * owner 缺省 '' → `${name}#`（稳定兜底，旧数据兼容）。
 */
export function entryId(entry: Pick<RegistryEntry, 'name' | 'owner'>): string {
  return `${entry.name}#${entry.owner ?? ''}`;
}

/** InstalledPlugin（reconcile 结果，契约 §Schema） */
export interface InstalledPlugin {
  /** bundle id（dsh 列表解析） */
  id: string;
  /** 名称 */
  name: string;
  /** 已装版本 */
  version: string;
  /** registry 对应版本（可更新判定；v1 registry 无版本字段 → null，R6 v2 严格映射） */
  registryVersion: string | null;
  /** 状态徽标 */
  status: PluginStatus;
}

/** PluginPreview（安装前预览，契约 §Schema / 设计 §1.5 Q-106） */
export interface PluginPreview {
  /** bundle id */
  id: string;
  /** 待装版本 */
  version: string;
  /** cordis.patch.yml 摘要（解析失败 → null + previewUnavailable，不阻断） */
  patchSummary: string | null;
  /** 来源 URL（信任明示展示） */
  sourceUrl: string;
  /** 预览不可用标记（manifest 解析失败 = true，安装仍可继续；缺省 = 可预览） */
  previewUnavailable?: boolean;
  /** 当前 dsh 版本低于 minDshVersion（提示用，不拦截；确认弹窗展示） */
  versionTooOld?: boolean;
}

/**
 * dsh CLI 失败类别码（DshCliRunner，设计 §1.1）：进程退出码 / 运行期失败类别，
 * 或契约级插件错误码（设计 §1.1 超时路径即产出 plugin-install-failed；调用方透传/映射均可）。
 */
export type DshCliFailureCode = PluginErrorCode | number | 'timeout' | 'spawn-failed' | 'killed';

/** DshCliRunner.run 结果（设计 §1.1）：成功 JSON 优先解析；失败 code + message + stderr 截断 2KB */
export type DshCliResult =
  | { ok: true; stdout: string; parsed?: unknown }
  | { ok: false; code: DshCliFailureCode; message: string; stderrTail: string };

/** 插件操作门控结果（设计 §1.7 gate，P3 接线用；拒绝码 = plugin-busy） */
export interface PluginGateResult {
  ok: boolean;
  code?: PluginErrorCode;
  message?: string;
}
