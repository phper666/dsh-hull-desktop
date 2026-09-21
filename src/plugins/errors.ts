/**
 * 插件市场错误码与错误类型（契约 §错误码，9 个 kebab；UI 直接展示）。
 */

export type PluginErrorCode =
  | 'plugin-registry-unreachable'
  | 'plugin-not-whitelisted'
  | 'plugin-install-failed'
  | 'plugin-update-failed'
  | 'plugin-uninstall-failed'
  | 'plugin-profile-missing'
  | 'plugin-busy'
  | 'plugin-not-installed'
  | 'plugin-version-too-old';

export class PluginError extends Error {
  readonly code: PluginErrorCode;

  constructor(code: PluginErrorCode, message: string) {
    super(message);
    this.name = 'PluginError';
    this.code = code;
  }
}
