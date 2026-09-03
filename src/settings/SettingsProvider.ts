import { EventEmitter } from 'node:events';
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { normalizeNotifPrefs, DEFAULT_NOTIF_PREFS, type NotifPrefs } from '../notifications/prefs';

import { HullError } from '../shared/errors';
import { NOOP_LOGGER, type RuntimeLogger } from '../shared/types';
import { isValidVersion } from '../updater/semver';
import type { PkgMgrName } from '../overlay/pkgMgr/types';

// 复用 pkgMgr/types 的 PkgMgrName（P3：settings.packageManager 三选一；不重复定义）
export type { PkgMgrName } from '../overlay/pkgMgr/types';

/** 通道名（S4 契约 §Schema：latest/pinned） */
export type ChannelName = 'latest' | 'pinned';

/** 主题（T2 + 主题跟随系统：dark/light/system，默认 dark；字段级扩展不 bump schemaVersion，CON-R-theme-006） */
export type ThemeName = 'dark' | 'light' | 'system';

/** 默认 registry（S6 契约 schema：任意 npm registry，CON-R013） */
export const DEFAULT_REGISTRY = 'https://registry.npmjs.org';

/** 壳设置 schema（S1 冻结面 + S4/S5/S6 变更传播扩展） */
export interface HullSettings {
  /** 点关闭按钮 = 退出（默认 false = 隐藏到托盘） */
  closeToQuit: boolean;
  /** schema 版本：当前 3（S4 bump 2 + S5 两字段再 bump 3，B7 策略；S6 迁移以版本号为判据） */
  schemaVersion: number;
  /** 版本通道（S4：latest 默认 / pinned） */
  channel: ChannelName;
  /** 锁定版本（channel=pinned 时必填；S4） */
  pinnedVersion: string | null;
  /** dsh 自动检查开关（S5：默认 true，S3 启动自动检查门控） */
  autoCheckDsh: boolean;
  /** Hull 自动检查开关（S5：默认 true） */
  autoCheckHull: boolean;
  /** npm registry（S6：任意源，settings.registry 优先 + env 兜底） */
  registry: string;
  /** 主题（T2：dark/light，默认 dark；字段级扩展不 bump schemaVersion） */
  theme: ThemeName;
  /** 包管理器（P3：npm/pnpm，默认 pnpm；CON-R-pkgmgr-001/008；字段级扩展不 bump schemaVersion） */
  packageManager: PkgMgrName;
  /** 通知偏好（V2b：按源系统通知开关 + 免打扰时段；字段级扩展不 bump schemaVersion） */
  notifPrefs: NotifPrefs;
}

/** 当前 schema 版本（S4 bump 1→2，S5 两字段再 bump 2→3） */
export const SCHEMA_VERSION_CURRENT = 3;

const DEFAULT_SETTINGS: HullSettings = {
  closeToQuit: false,
  schemaVersion: SCHEMA_VERSION_CURRENT,
  channel: 'latest',
  pinnedVersion: null,
  autoCheckDsh: true,
  autoCheckHull: true,
  registry: DEFAULT_REGISTRY,
  theme: 'system',  // CON-R-theme-004（v1.3）：默认跟随系统——仅对「从未设置过主题」的用户生效，已保存值不受影响
  packageManager: 'pnpm',
  notifPrefs: DEFAULT_NOTIF_PREFS,
};

export interface SettingsProviderOptions {
  /** Electron userData 目录（settings.json 落点 <userData>/settings.json） */
  userDataPath: string;
  /** 日志注入（默认 no-op） */
  logger?: RuntimeLogger;
}

/** registry 地址格式校验（http/https） */
function isValidRegistry(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

/** 包管理器名校验（npm/pnpm 二选一；非法 → 默认 pnpm，CON-R-pkgmgr-008） */
function isValidPkgMgr(value: unknown): value is PkgMgrName {
  return value === 'npm' || value === 'pnpm';
}

/**
 * 壳设置（设计 S1 §3/§5.1 + S4 D2 + S6 D2/B5）：
 * S1 只读语义保持（缺失默认不建文件、损坏回退默认不覆盖、恒读磁盘无缓存）；
 * S4 变更传播——set() 原子写（temp+rename）、B4 显式清 pinnedVersion、B5 写失败无内存态；
 * S6 变更传播——registry 字段 + 校验（SETTINGS_ERRORS）+ on(changed) 广播（契约 #3 main 侧接口预留）
 * + migrate()（B5：schemaVersion < 3 字段补齐；损坏 → 告警 + 默认 + 备份）。
 */
export class SettingsProvider extends EventEmitter {
  private readonly userDataPath: string;
  private readonly logger: RuntimeLogger;
  private readonly filePath: string;

  constructor(options: SettingsProviderOptions) {
    super();
    this.userDataPath = options.userDataPath;
    this.logger = options.logger ?? NOOP_LOGGER;
    this.filePath = join(this.userDataPath, 'settings.json');
  }

  /** 变更广播（契约 #3 main 侧接口：set 成功后 emit 全量；当前无订阅者——消费方走动态读） */
  on(event: 'changed', listener: (settings: HullSettings) => void): this;
  on(event: string | symbol, listener: (...args: any[]) => void): this {
    return super.on(event, listener);
  }

  getSettings(): HullSettings {
    if (!existsSync(this.filePath)) return { ...DEFAULT_SETTINGS };
    let raw: string;
    try {
      raw = readFileSync(this.filePath, 'utf8');
    } catch (err) {
      this.logger.warn(`settings.json 读取失败: ${(err as Error).message}（回退默认值）`);
      return { ...DEFAULT_SETTINGS };
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      this.logger.warn(`settings.json 解析失败: ${(err as Error).message}（回退默认值，不覆盖原文件）`);
      return { ...DEFAULT_SETTINGS };
    }
    const obj = parsed as Record<string, unknown>;
    const closeToQuit = typeof obj.closeToQuit === 'boolean' ? obj.closeToQuit : DEFAULT_SETTINGS.closeToQuit;
    const schemaVersion = typeof obj.schemaVersion === 'number' ? obj.schemaVersion : DEFAULT_SETTINGS.schemaVersion;
    const channel: ChannelName =
      obj.channel === 'pinned' || obj.channel === 'latest' ? obj.channel : DEFAULT_SETTINGS.channel;
    const pinnedVersion = typeof obj.pinnedVersion === 'string' ? obj.pinnedVersion : DEFAULT_SETTINGS.pinnedVersion;
    const autoCheckDsh = typeof obj.autoCheckDsh === 'boolean' ? obj.autoCheckDsh : DEFAULT_SETTINGS.autoCheckDsh;
    const autoCheckHull = typeof obj.autoCheckHull === 'boolean' ? obj.autoCheckHull : DEFAULT_SETTINGS.autoCheckHull;
    const registry = typeof obj.registry === 'string' ? obj.registry : DEFAULT_SETTINGS.registry;
    const theme: ThemeName =
      obj.theme === 'dark' || obj.theme === 'light' || obj.theme === 'system' ? obj.theme : DEFAULT_SETTINGS.theme;
    const packageManager: PkgMgrName =
      obj.packageManager === 'npm' || obj.packageManager === 'pnpm' ? obj.packageManager : DEFAULT_SETTINGS.packageManager;
    if (
      typeof obj.closeToQuit !== 'boolean' ||
      typeof obj.schemaVersion !== 'number' ||
      (obj.channel !== 'latest' && obj.channel !== 'pinned') ||
      (typeof obj.pinnedVersion !== 'string' && obj.pinnedVersion !== undefined && obj.pinnedVersion !== null) ||
      (typeof obj.autoCheckDsh !== 'boolean' && obj.autoCheckDsh !== undefined) ||
      (typeof obj.autoCheckHull !== 'boolean' && obj.autoCheckHull !== undefined) ||
      (typeof obj.registry !== 'string' && obj.registry !== undefined) ||
      (typeof obj.theme !== 'string' && obj.theme !== undefined) ||
      // P3：非法 packageManager 值（非 npm/pnpm 的非 undefined 值）→ 告警
      (obj.packageManager !== undefined && !isValidPkgMgr(obj.packageManager))
    ) {
      this.logger.warn('settings.json 字段类型不符（回退默认值，不覆盖原文件）');
    }
    const notifPrefs = normalizeNotifPrefs(obj.notifPrefs);
    return { closeToQuit, schemaVersion, channel, pinnedVersion, autoCheckDsh, autoCheckHull, registry, theme, packageManager, notifPrefs };
  }

  /**
   * S4/S6 扩展：合并写盘（temp+rename 原子写）+ 校验（SETTINGS_ERRORS）+ 广播。
   * B4：channel=latest 时显式清 pinnedVersion（同事务原子写）。
   * B5：写失败 → 无内存态（get() 恒读磁盘权威）+ 告警 + 错误语义（persist-failed ≡ settings-write-failed）。
   */
  set(partial: Partial<HullSettings>): void {
    const current = this.getSettings();
    const next: HullSettings = { ...current, ...partial, schemaVersion: SCHEMA_VERSION_CURRENT };
    if (next.channel === 'latest') next.pinnedVersion = null; // B4
    // T2：非法 theme → 回退 dark（与读路径归一对称，磁盘恒存合法值）
    if (next.theme !== 'dark' && next.theme !== 'light' && next.theme !== 'system') next.theme = DEFAULT_SETTINGS.theme; // 非法 → 回退默认（system）
    // P3：非法 packageManager → 回退 pnpm（与读路径归一对称，CON-R-pkgmgr-008）
    if (!isValidPkgMgr(next.packageManager)) next.packageManager = 'pnpm';
    // V2b：notifPrefs 归一化（非法字段逐项回退默认，与读路径归一对称）
    next.notifPrefs = normalizeNotifPrefs(next.notifPrefs);
    // 校验（SETTINGS_ERRORS）
    if (partial.registry !== undefined && !isValidRegistry(partial.registry)) {
      throw new HullError('registry-invalid', `非法 registry 地址: ${partial.registry}`);
    }
    if (partial.pinnedVersion !== undefined && partial.pinnedVersion !== null && !isValidVersion(partial.pinnedVersion)) {
      throw new HullError('version-invalid', `非法版本号: ${partial.pinnedVersion}`);
    }
    if (next.channel === 'pinned' && !next.pinnedVersion) {
      throw new HullError('version-invalid', 'pinned 通道需指定锁定版本');
    }
    try {
      const tmp = `${this.filePath}.tmp`;
      writeFileSync(tmp, JSON.stringify(next), 'utf8');
      renameSync(tmp, this.filePath);
    } catch (err) {
      this.logger.warn(`settings.json 写入失败: ${(err as Error).message}`);
      // 🟡-2：契约码 persist-failed（settings-write-failed 为 S4 别名，不新建）
      throw new HullError('persist-failed', `settings.json 写入失败: ${(err as Error).message}`);
    }
    this.emit('changed', this.getSettings()); // 广播全量（契约 #3）
  }

  /**
   * schemaVersion 迁移（S6 B5）：读文件 < 3 → 1→2→3 字段补齐（缺省补默认）；
   * 损坏文件 → 告警 + 默认值 + 备份（S2 M11 先例：不覆盖，备份原文件）。
   * 设置页首次运行触发（main 装配时调）。
   */
  migrate(): void {
    if (!existsSync(this.filePath)) return; // 无文件不建（S1 语义）
    let raw: string;
    try {
      raw = readFileSync(this.filePath, 'utf8');
    } catch {
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      // 损坏 → 告警 + 备份（回退默认由 getSettings 缺文件路径承担）
      this.logger.warn(`settings.json 损坏，备份并回退默认: ${(err as Error).message}`);
      try {
        renameSync(this.filePath, `${this.filePath}.bak-${Date.now()}`);
      } catch {
        /* 备份失败无害 */
      }
      return;
    }
    const obj = parsed as Record<string, unknown>;
    const schemaVersion = typeof obj.schemaVersion === 'number' ? obj.schemaVersion : 1;
    if (schemaVersion >= SCHEMA_VERSION_CURRENT) return; // 已最新
    const next: HullSettings = {
      closeToQuit: typeof obj.closeToQuit === 'boolean' ? obj.closeToQuit : DEFAULT_SETTINGS.closeToQuit,
      schemaVersion: SCHEMA_VERSION_CURRENT,
      channel: obj.channel === 'pinned' || obj.channel === 'latest' ? obj.channel : DEFAULT_SETTINGS.channel,
      pinnedVersion: typeof obj.pinnedVersion === 'string' ? obj.pinnedVersion : DEFAULT_SETTINGS.pinnedVersion,
      autoCheckDsh: typeof obj.autoCheckDsh === 'boolean' ? obj.autoCheckDsh : DEFAULT_SETTINGS.autoCheckDsh,
      autoCheckHull: typeof obj.autoCheckHull === 'boolean' ? obj.autoCheckHull : DEFAULT_SETTINGS.autoCheckHull,
      // 🟢：旧文件 registry 格式校验（与 set() 校验链对称——非法 → 默认值）
      registry: typeof obj.registry === 'string' && isValidRegistry(obj.registry) ? obj.registry : DEFAULT_SETTINGS.registry,
      theme: obj.theme === 'dark' || obj.theme === 'light' || obj.theme === 'system' ? obj.theme : DEFAULT_SETTINGS.theme,
      // P3：旧文件 packageManager 非法 → 默认 pnpm（与 set() 校验链对称）
      packageManager: isValidPkgMgr(obj.packageManager) ? obj.packageManager : DEFAULT_SETTINGS.packageManager,
      // V2b：旧文件无 notifPrefs → 默认（迁移路径字段级补齐）
      notifPrefs: normalizeNotifPrefs(obj.notifPrefs),
    };
    try {
      const tmp = `${this.filePath}.tmp`;
      writeFileSync(tmp, JSON.stringify(next), 'utf8');
      renameSync(tmp, this.filePath);
    } catch (err) {
      this.logger.warn(`settings.json 迁移写入失败: ${(err as Error).message}`);
    }
  }
}
