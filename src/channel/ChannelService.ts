import { HullError } from '../shared/errors';
import { NOOP_LOGGER, type RuntimeLogger } from '../shared/types';
import { SettingsProvider, type ChannelName } from '../settings/SettingsProvider';
import {
  CHECK_TIMEOUT_MS,
  DEFAULT_REGISTRY,
  defaultHttpGet,
  fetchLatestVersion,
  type RegistryHttpGet,
} from '../updater/registry';
import { compareVersions, isValidVersion } from '../updater/semver';

/** 版本列表上限（W4：防超大 manifest 渲染压力；S4 不建分页，注记上限来源） */
export const LIST_LIMIT = 100;

/** CHANNEL_ERRORS（契约 S4 §错误集） */
export const CHANNEL_ERRORS = {
  versionInvalid: 'version-invalid',
  versionNotFound: 'version-not-found',
  registryUnreachable: 'registry-unreachable',
} as const;
export type ChannelErrorCode = (typeof CHANNEL_ERRORS)[keyof typeof CHANNEL_ERRORS];

export interface ChannelState {
  channel: ChannelName;
  pinnedVersion: string | null;
}

export interface ChannelServiceOptions {
  settings: SettingsProvider;
  /** registry 源（缺省 env HULL_REGISTRY → 默认官方，S2 偏离 3 沿袭） */
  registry?: string;
  /** HTTP GET 注入（S3 registry 同款类型；测试） */
  httpGet?: RegistryHttpGet;
  timeoutMs?: number;
  logger?: RuntimeLogger;
}

export interface VersionList {
  versions: string[];
  /** dist-tags.latest 标注（可能不在前 100 内） */
  latest: string | null;
}

/**
 * 版本通道（S4 契约 #1~#4，设计 D2/D4/D5b/D6）：
 * get/set（校验链：channel 合法 → pinned 必填 + isValidVersion → 单版本端点存在性 200/404）+
 * resolveTarget（latest → dist-tags.latest；pinned → 存在性校验后返回）+ listVersions（semver 降序截断 100）。
 * registry URL 编码复用 S3 约定（@ 字面 + %2F）；HULL_REGISTRY env。
 * 注记：离线 set('pinned') 被网络校验阻断（B8，UI 禁用归 S6）。
 */
export class ChannelService {
  private readonly settings: SettingsProvider;
  private readonly registry: string | undefined;
  private readonly httpGet: RegistryHttpGet;
  private readonly timeoutMs: number;
  private readonly logger: RuntimeLogger;

  constructor(options: ChannelServiceOptions) {
    this.settings = options.settings;
    this.registry = options.registry;
    this.httpGet = options.httpGet ?? defaultHttpGet;
    this.timeoutMs = options.timeoutMs ?? CHECK_TIMEOUT_MS;
    this.logger = options.logger ?? NOOP_LOGGER;
  }

  /** 当前通道（恒读磁盘权威，B5） */
  get(): ChannelState {
    const s = this.settings.getSettings();
    return { channel: s.channel, pinnedVersion: s.pinnedVersion };
  }

  /** 设置通道（校验链 D6；latest 忽略 version + 清 pinnedVersion 由 SettingsProvider B4 处理） */
  async set(channel: string, version?: string): Promise<void> {
    if (channel !== 'latest' && channel !== 'pinned') {
      throw new HullError(CHANNEL_ERRORS.versionInvalid, `非法 channel: ${channel}`);
    }
    if (channel === 'pinned') {
      if (!version) throw new HullError(CHANNEL_ERRORS.versionInvalid, 'pinned 通道需指定锁定版本');
      if (!isValidVersion(version)) throw new HullError(CHANNEL_ERRORS.versionInvalid, `非法版本号: ${version}`);
      const exists = await this.versionExists(version);
      if (!exists) throw new HullError(CHANNEL_ERRORS.versionNotFound, `registry 无该版本: ${version}`);
      this.settings.set({ channel: 'pinned', pinnedVersion: version });
      return;
    }
    this.settings.set({ channel: 'latest' }); // latest：忽略 version 参数（无需锁定）
  }

  /** 解析升级目标（契约 #3）：latest → dist-tags.latest；pinned → 存在性校验通过后返回 */
  async resolveTarget(): Promise<string> {
    const { channel, pinnedVersion } = this.get();
    if (channel === 'latest') {
      // 🔴-B：fetchLatestVersion 抛 check-failed（UPGRADE_ERRORS 域）→ 映射回 CHANNEL_ERRORS 域
      // （契约 #1 声明 resolveTarget 异常 = CHANNEL_ERRORS 三码，S6 设置页按三码映射）
      try {
        return await fetchLatestVersion({ registry: this.registry, httpGet: this.httpGet, timeoutMs: this.timeoutMs });
      } catch (err) {
        throw new HullError(
          CHANNEL_ERRORS.registryUnreachable,
          `registry 检查失败: ${(err as Error).message}`
        );
      }
    }
    if (!pinnedVersion) {
      throw new HullError(CHANNEL_ERRORS.versionInvalid, 'pinned 通道未设置锁定版本');
    }
    const exists = await this.versionExists(pinnedVersion);
    if (!exists) {
      // 下架（S6 UI 建议回 latest 注记）
      throw new HullError(CHANNEL_ERRORS.versionNotFound, `锁定版本已被 registry 下架: ${pinnedVersion}`);
    }
    return pinnedVersion;
  }

  /** registry 版本列表（契约 #4）：semver 降序 + 截断前 100 + dist-tags.latest 标注 */
  async listVersions(): Promise<VersionList> {
    const url = this.metadataUrl();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await this.httpGet(url, { signal: controller.signal });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const manifest = JSON.parse(res.text) as {
        versions?: Record<string, unknown>;
        'dist-tags'?: { latest?: unknown };
      };
      const versions = Object.keys(manifest.versions ?? {})
        .filter((v) => isValidVersion(v))
        .sort((a, b) => compareVersions(b, a)) // semver 降序（S3 复用）
        .slice(0, LIST_LIMIT);
      const latest = typeof manifest['dist-tags']?.latest === 'string' ? manifest['dist-tags'].latest : null;
      return { versions, latest };
    } catch (err) {
      throw new HullError(CHANNEL_ERRORS.registryUnreachable, `版本列表拉取失败: ${(err as Error).message}`);
    } finally {
      clearTimeout(timer);
    }
  }

  private metadataUrl(): string {
    // S6 B7：显式 → settings.registry → env → 默认官方（settings 优先 + env 兜底）
    const registry = (
      this.registry ??
      this.settings.getSettings().registry ??
      process.env.HULL_REGISTRY ??
      DEFAULT_REGISTRY
    ).replace(/\/+$/, '');
    return `${registry}/@${encodeURIComponent('deepseek-ai/dsh')}`;
  }

  /** 单版本端点存在性（B2）：200 = 存在 / 404 = 不存在；其他状态/网络 → registry-unreachable */
  private async versionExists(version: string): Promise<boolean> {
    const url = `${this.metadataUrl()}/${encodeURIComponent(version)}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await this.httpGet(url, { signal: controller.signal });
      if (res.status === 200) return true;
      if (res.status === 404) return false;
      throw new Error(`HTTP ${res.status}`);
    } catch (err) {
      throw new HullError(CHANNEL_ERRORS.registryUnreachable, `版本存在性检查失败: ${(err as Error).message}`);
    } finally {
      clearTimeout(timer);
    }
  }
}
