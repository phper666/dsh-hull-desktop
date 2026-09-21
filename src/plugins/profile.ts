/**
 * profile 'hull' 管理（设计 §1.2，P1）：
 * HULL_PLUGIN_PROFILE 常量、ensureProfile（校验存在性，dsh 侧隐式创建）、
 * reconcile 只读列表解析（JSON 优先/文本行兜底，按 profile 过滤 bundles → InstalledPlugin[]）。
 * 插件装到独立 profile 'hull'，不污染用户业务 profile（契约决策：--profile 独立管理）。
 */
import { NOOP_LOGGER, type RuntimeLogger } from '../shared/types';

import { PluginError } from './errors';
import type { DshCliResult, InstalledPlugin } from './types';

export const HULL_PLUGIN_PROFILE = 'hull';

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
