/**
 * P3 安装编排状态机（设计 §1.6 / 契约 §状态转换）：idle → validating → preview-ready → installing → verifying → done。
 * 两段式安装：
 *   install(entryId)            白名单反查 → npm pack 预览（只读，不持锁）→ {stage:'preview', preview}
 *   install(entryId, confirm)   dsh add → verify（list 含 bundle + profile 就位）→ {stage:'done', installed}
 * 失败清理：add/verify 失败 → dsh remove 该次痕迹 → 回 idle → 抛 PluginError（install-failed，透传 stderr 摘要）。
 * 单飞：in-flight 期间任何互斥操作 → plugin-busy；门控（升级/自更新）前置。
 * 不变量：URL 一律由主进程从白名单条目反查（渲染层只传 entryId，防绕过）；不直写 DSH_HOME。
 */
import { existsSync } from 'node:fs';

import { NOOP_LOGGER, type RuntimeLogger } from '../shared/types';

import type { DshCliRunner } from './cli';
import { PluginError, type PluginErrorCode } from './errors';
import { canOperatePlugin, type GateDeps } from './gate';
import { previewBundle } from './manifest';
import { ensureProfile as ensureProfileImpl } from './profile';
import type { DshCliResult, InstalledPlugin, PluginPreview, RegistryEntry } from './types';
import { compareVersions } from '../updater/semver';
import { isWhitelisted } from './whitelist';

export type InstallStep = 'idle' | 'validating' | 'preview-ready' | 'installing' | 'verifying' | 'done';
export type PluginOpKind = 'install' | 'update' | 'uninstall';

export interface Inflight {
  kind: PluginOpKind;
  id: string;
}

export interface InstallerDeps {
  /** dsh CLI 单一通道（P1；--profile 由 runner 统一注入 'hull'） */
  runner: DshCliRunner;
  /** registry 条目（白名单反查；安装请求只收 entryId） */
  entries: RegistryEntry[];
  /** profile 'hull' 根目录（verify 就位检查） */
  profileDir: string;
  /** npm pack 临时根（预览目录用完即清） */
  tmpRoot: string;
  /** 插件门控（升级/自更新/in-flight） */
  gate: GateDeps;
  /** 注入可测；缺省 previewBundle(url, tmpRoot) */
  preview?: (url: string) => Promise<PluginPreview>;
  /** 当前 dsh 版本（minDshVersion 提示链；main 从 overlay 当前版本取；缺省不比较） */
  dshVersion?: () => Promise<string | null>;
  /** profile 就位前置校验（安装执行前调用；dsh 缺失 → plugin-profile-missing，契约口径） */
  ensureProfile?: () => Promise<void>;
  logger?: RuntimeLogger;
}

export type InstallResult =
  | { stage: 'preview'; preview: PluginPreview }
  | { stage: 'done'; installed: InstalledPlugin };

export class PluginInstaller {
  private readonly logger: RuntimeLogger;
  private step: InstallStep = 'idle';
  private inflight: Inflight | null = null;
  /** 上一段预览缓存（confirm 复用，避免二次 npm pack 网络开销）；entryId 不匹配则重算 */
  private lastPreview: { entryId: string; entry: RegistryEntry; preview: PluginPreview } | null = null;

  constructor(private readonly deps: InstallerDeps) {
    this.logger = deps.logger ?? NOOP_LOGGER;
  }

  /** P4 getPluginStatus 数据源（契约 §接口详情 6）：进行中操作 + 状态步骤 */
  getSnapshot(): { step: InstallStep; inflight: Inflight | null } {
    return { step: this.step, inflight: this.inflight };
  }

  /** 两段式第一段：白名单 → 预览（解析失败不阻断，返回 previewUnavailable 标记） */
  async install(entryId: string): Promise<InstallResult>;
  /** 两段式第二段：用户确认后执行安装（契约 §接口详情 3） */
  async install(entryId: string, confirm: true): Promise<InstallResult>;
  async install(entryId: string, confirm?: true): Promise<InstallResult> {
    if (confirm) return this.confirmInstall(entryId);

    if (this.inflight) throw new PluginError('plugin-busy', '已有插件操作进行中');
    const gate = canOperatePlugin(this.deps.gate);
    if (!gate.ok) throw new PluginError(gate.code ?? 'plugin-busy', gate.message ?? '当前不能操作插件');

    const entry = this.lookupEntry(entryId);
    this.step = 'validating';
    try {
      const preview = await this.previewFor(entry);
      await this.markVersionTooOld(entry, preview); // minDshVersion 提示链（🟠-2，提示用不拦截）
      this.lastPreview = { entryId, entry, preview };
      this.step = 'preview-ready';
      this.logger.info(`[plugins] preview ready id=${entryId}`);
      return { stage: 'preview', preview };
    } catch (err) {
      this.step = 'idle';
      throw err;
    }
  }

  /** 更新：委托 dsh update；未安装 → plugin-not-installed（契约 §接口详情 4） */
  async update(id: string): Promise<{ updated: InstalledPlugin }> {
    this.begin('update', id);
    try {
      if (!(await this.isInstalled(id))) {
        throw new PluginError('plugin-not-installed', `插件未安装：${id}`);
      }
      const r = await this.deps.runner.run('update', [id]);
      if (!r.ok) throw this.failed('plugin-update-failed', `更新失败：${id}`, r);
      this.logger.info(`[plugins] updated id=${id}`);
      return { updated: { id, name: id, version: extractVersion(r), registryVersion: null, status: 'installed' } };
    } finally {
      this.finish();
    }
  }

  /** 卸载：委托 dsh remove；未安装 → plugin-not-installed（契约 §接口详情 5） */
  async uninstall(id: string): Promise<{ removed: true }> {
    this.begin('uninstall', id);
    try {
      if (!(await this.isInstalled(id))) {
        throw new PluginError('plugin-not-installed', `插件未安装：${id}`);
      }
      const r = await this.deps.runner.run('remove', [id]);
      if (!r.ok) throw this.failed('plugin-uninstall-failed', `卸载失败：${id}`, r);
      this.logger.info(`[plugins] removed id=${id}`);
      return { removed: true };
    } finally {
      this.finish();
    }
  }

  // ── 内部 ──

  private async confirmInstall(entryId: string): Promise<{ stage: 'done'; installed: InstalledPlugin }> {
    this.begin('install', entryId);
    try {
      const cached = this.lastPreview?.entryId === entryId ? this.lastPreview : null;
      const entry = cached?.entry ?? this.lookupEntry(entryId);
      const preview = cached?.preview ?? (await this.previewFor(entry));

      // 安装前置：profile 'hull' 就位校验（dsh 缺失/失败 → plugin-profile-missing，契约口径）
      const ensure = this.deps.ensureProfile ?? (() => ensureProfileImpl(this.deps.runner, this.logger));
      await ensure();

      this.step = 'installing';
      const add = await this.deps.runner.run('add', [entry.url]);
      if (!add.ok) {
        await this.cleanup(entry.url);
        throw this.failed('plugin-install-failed', `安装失败：${entry.name}`, add);
      }

      this.step = 'verifying';
      if (!(await this.verifyInstalled(preview.id, entry.name))) {
        await this.cleanup(entry.url);
        throw new PluginError('plugin-install-failed', `安装验证失败：${entry.name} 未在 dsh 列表就位`);
      }

      this.step = 'done';
      this.logger.info(`[plugins] installed id=${entry.name} v=${preview.version}`);
      return {
        stage: 'done',
        installed: {
          id: preview.id,
          name: entry.name,
          version: preview.version,
          registryVersion: null,
          status: 'installed',
        },
      };
    } finally {
      this.finish();
    }
  }

  /** 互斥入口：门控（升级/自更新）→ in-flight 单飞 → 占用 */
  private begin(kind: PluginOpKind, id: string): void {
    const gate = canOperatePlugin(this.deps.gate);
    if (!gate.ok) throw new PluginError(gate.code ?? 'plugin-busy', gate.message ?? '当前不能操作插件');
    if (this.inflight) throw new PluginError('plugin-busy', '已有插件操作进行中');
    this.inflight = { kind, id };
    this.step = 'validating';
  }

  private finish(): void {
    this.inflight = null;
    this.step = 'idle';
  }

  /** 白名单反查（逐字命中；渲染层传 entryId 主进程反查 URL，防注入） */
  private lookupEntry(entryId: string): RegistryEntry {
    const entry = isWhitelisted(entryId, this.deps.entries);
    if (!entry) throw new PluginError('plugin-not-whitelisted', `插件不在白名单：${entryId}`);
    return entry;
  }

  private previewFor(entry: RegistryEntry): Promise<PluginPreview> {
    const doPreview = this.deps.preview ?? ((url: string) => previewBundle(url, this.deps.tmpRoot));
    return doPreview(entry.url);
  }

  /** minDshVersion 提示链（🟠-2）：当前 dsh 版本低于要求 → preview.versionTooOld=true（提示用，不拦截） */
  private async markVersionTooOld(entry: RegistryEntry, preview: PluginPreview): Promise<void> {
    if (!this.deps.dshVersion) return;
    preview.versionTooOld = false;
    if (!entry.minDshVersion) return;
    try {
      const current = await this.deps.dshVersion();
      if (current !== null && versionBelow(entry.minDshVersion, current)) {
        preview.versionTooOld = true;
      }
    } catch {
      // dsh 版本读取失败 → 不提示（不阻断）
    }
  }

  /** 验证：profile 文件就位 + dsh list 含 bundle（设计 §1.6 / §2.1） */
  private async verifyInstalled(bundleId: string, name: string): Promise<boolean> {
    if (!existsSync(this.deps.profileDir)) return false;
    const list = await this.deps.runner.run('list', []);
    if (!list.ok) return false;
    // ponytail: P1 parsed 结构落地后按字段精化；当前 stdout+parsed 全文含 bundle 名即视为就位
    const haystack = listHaystack(list);
    return haystack.includes(bundleId) || haystack.includes(name);
  }

  /** 已安装判定（update/uninstall 前置；dsh 不可达 → plugin-profile-missing） */
  private async isInstalled(id: string): Promise<boolean> {
    const list = await this.deps.runner.run('list', []);
    if (!list.ok) throw this.failed('plugin-profile-missing', '无法读取已安装插件列表', list);
    return listHaystack(list).includes(id);
  }

  /** 失败痕迹清理：best-effort dsh remove（设计 §2.1；dsh 侧状态为准，失败不掩盖原错误） */
  private async cleanup(spec: string): Promise<void> {
    try {
      await this.deps.runner.run('remove', [spec]);
      this.logger.warn(`[plugins] cleaned failed install trace: ${spec}`);
    } catch {
      // ignore
    }
  }

  private failed(code: PluginErrorCode, prefix: string, r: DshCliResult): PluginError {
    const tail = 'stderrTail' in r && r.stderrTail ? `：${r.stderrTail}` : '';
    return new PluginError(code, `${prefix}${tail}`);
  }
}

/** dsh list 输出全文（stdout + parsed JSON 双通道；parsed 缺省时仅 stdout） */
function listHaystack(list: Extract<DshCliResult, { ok: true }>): string {
  const parsed = (list as { parsed?: unknown }).parsed;
  return `${list.stdout}\n${parsed === undefined ? '' : JSON.stringify(parsed)}`;
}

/** 更新后版本从 stdout 提取（ponytail: P1 parsed 落地后精化；提取失败 → 'unknown'） */
function extractVersion(r: DshCliResult): string {
  if (!r.ok) return 'unknown';
  const m = /v?(\d+\.\d+\.\d+(?:[-+][\w.-]+)?)/.exec(r.stdout);
  return m ? m[1] : 'unknown';
}

/** 版本比较：current < min → true（非法版本 → false，registry 脏数据不误报） */
function versionBelow(min: string, current: string): boolean {
  try {
    return compareVersions(current, min) < 0;
  } catch {
    return false;
  }
}
