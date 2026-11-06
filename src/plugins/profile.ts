/**
 * profile 'hull' 管理（设计 §1.2，P1）：
 * HULL_PLUGIN_PROFILE 常量、ensureProfile（校验存在性，dsh 侧隐式创建）、
 * reconcile 只读列表解析（JSON 优先/文本行兜底，按 profile 过滤 bundles → InstalledPlugin[]）。
 * 插件装到独立 profile 'hull'，不污染用户业务 profile（契约决策：--profile 独立管理）。
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { NOOP_LOGGER, type RuntimeLogger } from '../shared/types';
import { HULL_DSH_PROFILE } from '../runtime/spawnArgs';

import { PluginError } from './errors';
import type { DshCliResult, InstalledPlugin } from './types';

/** 单一来源：与 buildSpawnArgv 的 `--profile` 同名（壳启动 profile = 插件安装 profile） */
export const HULL_PLUGIN_PROFILE = HULL_DSH_PROFILE;

/** hull profile 必须启用的 bundles：base（dsh 核心）+ web-app（`--profile hull` 起 web UI 的前提） */
const REQUIRED_BUNDLES = ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'];

/** 从已有 web profile 复制到 hull 的文件（保留用户 patch；不复制 node_modules） */
const COPIED_PROFILE_FILES = ['package.json', 'cordis.patch.yml', 'cordis.yml', 'pnpm-workspace.yaml'];

/** dsh plugin list 解析出的 bundle（reconcile 中间形态） */
export interface ParsedBundle {
  id: string;
  name: string;
  version: string;
  /** 列表输出含 profile 字段时保留（reconcile 按 profile 过滤） */
  profile?: string;
}

/** dsh plugin list 输出解析：JSON（数组或 { plugins: [...] }）优先，文本行兜底（参数面以实测为准，R1） */
export function parseBundleList(stdout: string): ParsedBundle[] {
  const trimmed = stdout.trim();
  if (!trimmed) return [];
  try {
    const raw: unknown = JSON.parse(trimmed);
    const arr = extractList(raw);
    if (arr.length > 0) {
      const out: ParsedBundle[] = [];
      for (const item of arr) {
        const b = normalizeBundle(item);
        if (b) out.push(b);
      }
      return out;
    }
    // JSON 合法但列表为空（[] / {plugins: []}）→ 直接返回空。
    // 勿再落文本行兜底——否则 `[]` 会被当成一条 { id:'[]', version:'' } 幽灵条目（e2e 暴露）。
    return [];
  } catch {
    /* 非 JSON → 文本行解析 */
  }
  const out: ParsedBundle[] = [];
  for (const line of trimmed.split(/\r?\n/)) {
    const l = line.trim();
    if (!l || l.startsWith('#')) continue;
    out.push(parseBundleLine(l));
  }
  return out;
}

/** 按 profile 过滤：未标注视为属于当前 profile（dsh 已按 --profile 过滤）；标注且不匹配 → 丢弃 */
export function filterByProfile(bundles: ParsedBundle[], profile: string = HULL_PLUGIN_PROFILE): ParsedBundle[] {
  return bundles.filter((b) => !b.profile || b.profile === profile);
}

/**
 * reconcile（设计 §2.3 / 契约 #2）：dsh list（profile hull）→ 解析 → 过滤 → InstalledPlugin[]。
 * v1 不匹配 registry 版本（RegistryEntry 无版本字段，R6 v2 严格映射）→ registryVersion=null、status='installed'。
 */
export async function reconcileInstalled(
  runner: { run(cmd: 'list', args?: string[]): Promise<DshCliResult> },
  opts: { profile?: string; logger?: RuntimeLogger } = {},
): Promise<InstalledPlugin[]> {
  const res = await runner.run('list', []);
  if (!res.ok) throw new PluginError('plugin-profile-missing', `dsh 列表不可用：${res.message}`);
  const bundles = filterByProfile(parseBundleList(res.stdout), opts.profile ?? HULL_PLUGIN_PROFILE);
  return bundles.map((b) => ({
    id: b.id,
    name: b.name,
    version: b.version,
    registryVersion: null,
    status: 'installed' as const,
  }));
}

/**
 * 校验 profile 'hull' 存在（设计 §1.2）：dsh plugin list --profile hull 成功即 profile 就绪
 * （dsh 对未知 profile 隐式创建；--profile 缺省即报错，协调事项 R1 参数面以实测为准）。
 * 失败 → plugin-profile-missing（契约 #2 降级路径：已安装 tab 降级提示 + 市场 tab 可浏览）。
 * ponytail: 若实测 dsh 需显式创建（如 `dsh profile create hull`），在此补创建调用后重试。
 */
export async function ensureProfile(
  runner: { run(cmd: 'list', args?: string[]): Promise<DshCliResult> },
  logger: RuntimeLogger = NOOP_LOGGER,
): Promise<void> {
  const res = await runner.run('list', []);
  if (res.ok) {
    logger.info(`[plugins] profile '${HULL_PLUGIN_PROFILE}' 就绪`);
    return;
  }
  logger.warn(`[plugins] profile '${HULL_PLUGIN_PROFILE}' 不可用：${res.message}`);
  throw new PluginError('plugin-profile-missing', `插件 profile '${HULL_PLUGIN_PROFILE}' 不可用：${res.message}`);
}

export interface EnsureHullProfileResult {
  /** 本次新建了 hull profile 目录 */
  initialized: boolean;
  /** 本次补齐了已有 hull profile 缺失的 bundles */
  repaired: boolean;
  /** 本次把 web profile 的真实 cordis.patch.yml 迁移到了 hull（一次性） */
  migratedPatch: boolean;
}

/**
 * 确保壳自身启动用的 dsh profile（`~/.dsh/profiles/hull`）存在且含 web-app bundle。
 * 背景：`dsh plugin --profile hull` 装包与 profile 完全独立；壳若用 `web`（= --profile web）
 * 启动，插件永不加载。dsh 隐式创建的 hull profile 只含 dsh-base，缺 dsh-web-app 时
 * `--profile hull` 起不了 web app（实测），因此启动前必须补齐。
 * 策略：
 * - 不存在 → 有 web profile 则复制其 package.json + cordis*.yml + pnpm-workspace.yaml
 *   （保留用户 patch），只改 name/确保 bundles；否则写最小 package.json。
 * - 已存在 → 仅补齐缺失 bundles 后写回（幂等）；另做一次性 patch 迁移：
 *   hull 的 cordis.patch.yml 仍是 dsh 原始模板、且 web profile 的 patch 有真实配置
 *   （llm-provider 等用户配置）→ 用 web patch 覆盖（否则切到 hull 后用户模型配置全丢）。
 *   迁移后 hull patch 非模板，后续调用自然不再迁移（幂等）。
 * - 任何异常（权限/坏 JSON）只 warn，不抛——profile 问题不得阻断壳启动。
 */
export function ensureHullProfile(deps: { home?: string; logger?: RuntimeLogger } = {}): EnsureHullProfileResult {
  const logger = deps.logger ?? NOOP_LOGGER;
  const profilesDir = join(deps.home ?? homedir(), '.dsh', 'profiles');
  const profileDir = join(profilesDir, HULL_PLUGIN_PROFILE);
  const pkgPath = join(profileDir, 'package.json');
  const unchanged: EnsureHullProfileResult = { initialized: false, repaired: false, migratedPatch: false };
  try {
    if (!existsSync(profileDir)) {
      mkdirSync(profileDir, { recursive: true });
      const webDir = join(profilesDir, 'web');
      if (existsSync(join(webDir, 'package.json'))) {
        for (const file of COPIED_PROFILE_FILES) {
          const src = join(webDir, file);
          if (existsSync(src)) copyFileSync(src, join(profileDir, file));
        }
      }
      const pkg = readPackageOr(pkgPath, minimalProfilePackage);
      pkg.name = `dsh-profile-${HULL_PLUGIN_PROFILE}`;
      ensureBundles(pkg);
      writePackage(pkgPath, pkg);
      logger.info(`[plugins] 已初始化 dsh profile '${HULL_PLUGIN_PROFILE}'（${pkgPath}）`);
      return { initialized: true, repaired: false, migratedPatch: false };
    }
    // patch 迁移独立于 package.json 处理：任一环节失败不影响另一环节
    let migratedPatch = false;
    try {
      migratedPatch = migrateWebPatch(profilesDir, profileDir, logger);
    } catch (err) {
      logger.warn(`[plugins] 迁移 web profile patch 失败（不阻断启动）：${(err as Error).message}`);
    }
    if (!existsSync(pkgPath)) {
      const pkg = minimalProfilePackage();
      writePackage(pkgPath, pkg);
      logger.info(`[plugins] 已补建 dsh profile '${HULL_PLUGIN_PROFILE}' 的 package.json`);
      return { initialized: false, repaired: true, migratedPatch };
    }
    const pkg = readPackageOr(pkgPath, null);
    if (!pkg) {
      logger.warn(`[plugins] dsh profile '${HULL_PLUGIN_PROFILE}' 的 package.json 不可解析，跳过修复`);
      return { ...unchanged, migratedPatch };
    }
    if (!ensureBundles(pkg)) return { ...unchanged, migratedPatch };
    writePackage(pkgPath, pkg);
    logger.info(`[plugins] 已补齐 dsh profile '${HULL_PLUGIN_PROFILE}' 缺失的 bundles`);
    return { initialized: false, repaired: true, migratedPatch };
  } catch (err) {
    logger.warn(`[plugins] 准备 dsh profile '${HULL_PLUGIN_PROFILE}' 失败（不阻断启动）：${(err as Error).message}`);
    return unchanged;
  }
}

/** dsh plugin 自动创建 profile 时写入的原始 patch 模板（逐字；用于识别「用户未配置」） */
const DEFAULT_PATCH_BODY = [
  '# Your patch layer for this dsh profile, applied after every bundle layer:',
  '# a top-level YAML array of loader patch entries (id-targeted config',
  '# overrides, disables, and insert lists; `!!js` expressions allowed).',
  '[]',
].join('\n');

function isDefaultPatch(content: string): boolean {
  return content.trim() === DEFAULT_PATCH_BODY;
}

/**
 * 一次性迁移（阻断级回归修复）：壳已从 `web` profile 切到 `hull`，但用户的
 * llm-provider / UI 等配置在 web/cordis.patch.yml。仅当 hull patch 仍是原始模板、
 * web patch 存在且有真实配置时复制（逐字），避免用户配置静默丢失。
 * hull patch 已有内容 / web 不存在 / web 也是空模板 → 不动。
 */
function migrateWebPatch(profilesDir: string, profileDir: string, logger: RuntimeLogger): boolean {
  const hullPatch = join(profileDir, 'cordis.patch.yml');
  const webPatch = join(profilesDir, 'web', 'cordis.patch.yml');
  if (!existsSync(hullPatch) || !existsSync(webPatch)) return false;
  const hullContent = readFileSync(hullPatch, 'utf8');
  const webContent = readFileSync(webPatch, 'utf8');
  if (!isDefaultPatch(hullContent) || isDefaultPatch(webContent) || webContent.trim() === '') return false;
  writeFileSync(hullPatch, webContent, 'utf8');
  logger.info(`[plugins] 已迁移 web profile 的 cordis.patch.yml → '${HULL_PLUGIN_PROFILE}'（保留用户配置）`);
  return true;
}

type JsonRecord = Record<string, unknown>;

function minimalProfilePackage(): JsonRecord {
  return {
    name: `dsh-profile-${HULL_PLUGIN_PROFILE}`,
    private: true,
    dsh: { profile: { bundles: [...REQUIRED_BUNDLES], patchReload: 'live' } },
  };
}

/** 读 package.json；失败时返回 fallback（null = 视为不可修复） */
function readPackageOr(pkgPath: string, fallback: () => JsonRecord): JsonRecord;
function readPackageOr(pkgPath: string, fallback: null): JsonRecord | null;
function readPackageOr(pkgPath: string, fallback: (() => JsonRecord) | null): JsonRecord | null {
  try {
    const raw: unknown = JSON.parse(readFileSync(pkgPath, 'utf8'));
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) return raw as JsonRecord;
  } catch {
    /* 缺失/坏 JSON → fallback */
  }
  return fallback ? fallback() : null;
}

function writePackage(pkgPath: string, pkg: JsonRecord): void {
  writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`, 'utf8');
}

/** 补齐 dsh.profile.bundles（保留其余字段与顺序）；有变更返回 true */
function ensureBundles(pkg: JsonRecord): boolean {
  const dsh = asRecord(pkg.dsh) ?? (pkg.dsh = {});
  const profile = asRecord(dsh.profile) ?? (dsh.profile = {});
  const current = Array.isArray(profile.bundles) ? (profile.bundles as unknown[]) : [];
  const missing = REQUIRED_BUNDLES.filter((b) => !current.includes(b));
  if (missing.length === 0) return false;
  profile.bundles = [...current, ...missing];
  return true;
}

function asRecord(v: unknown): JsonRecord | undefined {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as JsonRecord) : undefined;
}

function extractList(raw: unknown): unknown[] {
  if (Array.isArray(raw)) return raw;
  if (raw && typeof raw === 'object') {
    const plugins = (raw as Record<string, unknown>).plugins;
    if (Array.isArray(plugins)) return plugins;
  }
  return [];
}

function normalizeBundle(raw: unknown): ParsedBundle | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const id = str(r.id) ?? str(r.bundle) ?? str(r.name);
  if (!id) return null;
  return {
    id,
    name: str(r.name) ?? id,
    version: str(r.version) ?? '',
    ...(str(r.profile) ? { profile: str(r.profile) as string } : {}),
  };
}

function parseBundleLine(line: string): ParsedBundle {
  const m = line.match(/^(\S+?)(?:@|\s+)(\S+)$/);
  if (m) return { id: m[1]!, name: m[1]!, version: m[2]! };
  return { id: line, name: line, version: '' };
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}
