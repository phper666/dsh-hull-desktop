import { HullError } from '../shared/errors';
import { compareVersions, isValidVersion } from './semver';

/** registry 检查超时（S3 设计 B12：10s 常量，不入配置面） */
export const CHECK_TIMEOUT_MS = 10_000;
/** 默认 registry（HULL_REGISTRY env 可配） */
export const DEFAULT_REGISTRY = 'https://registry.npmjs.org';

export interface RegistryHttpGetResult {
  ok: boolean;
  status: number;
  text: string;
}

export type RegistryHttpGet = (url: string, opts: { signal: AbortSignal }) => Promise<RegistryHttpGetResult>;

export interface CheckLatestOptions {
  /** registry 源（缺省 env HULL_REGISTRY → 默认官方） */
  registry?: string;
  /** settings.registry 来源（S6 B7：settings 优先 + env 兜底） */
  getRegistry?: () => string | null;
  /** 当前版本来源（main 接 OverlayManager.currentVersion） */
  currentVersion: () => string | null;
  /** HTTP GET 注入（测试） */
  httpGet?: RegistryHttpGet;
  /** 超时 seam（缺省 CHECK_TIMEOUT_MS；测试快进） */
  timeoutMs?: number;
}

export interface CheckResult {
  hasUpdate: boolean;
  current: string | null;
  latest: string | null;
  /** 变更说明：可空（不展示策略，不拉 GitHub，S3 设计 B10） */
  changeNotes?: string;
}

export type RegistryCheckFn = (opts: CheckLatestOptions) => Promise<CheckResult>;

/** 默认 HTTP GET：fetch + AbortSignal 超时 */
async function defaultHttpGet(url: string, opts: { signal: AbortSignal }): Promise<RegistryHttpGetResult> {
  const res = await fetch(url, { signal: opts.signal });
  return { ok: res.ok, status: res.status, text: await res.text() };
}

export { defaultHttpGet };

/** registry 解析公共参数（S3 check + S4 ChannelService 复用） */
export interface RegistryFetchOptions {
  /** 显式 registry（测试/调用方覆盖；缺省走 getRegistry → env → 默认） */
  registry?: string;
  /** settings.registry 来源（S6 B7：settings 优先 + env 兜底——main 注入 settings 读取） */
  getRegistry?: () => string | null;
  httpGet?: RegistryHttpGet;
  timeoutMs?: number;
}

/** registry 来源解析：显式 → settings（getRegistry）→ env → 默认官方（S6 B7 统一优先级） */
export function resolveRegistry(opts: RegistryFetchOptions): string {
  const explicit = opts.registry;
  const fromSettings = opts.getRegistry ? opts.getRegistry() : null;
  return (explicit ?? fromSettings ?? process.env.HULL_REGISTRY ?? DEFAULT_REGISTRY).replace(/\/+$/, '');
}

/**
 * 解析最新版本（S3 D4/B9 逻辑抽取，S4 resolveTarget 复用）：
 * GET <registry>/@deepseek-ai%2Fdsh → dist-tags.latest → fallback /latest 端点。
 * 网络/解析/超时失败 → check-failed 错误语义。
 */
export async function fetchLatestVersion(opts: RegistryFetchOptions = {}): Promise<string> {
  const registry = resolveRegistry(opts);
  // @ 保持字面、/ 编码为 %2F（registry 对 scoped 包的标准路径约定）
  const url = `${registry}/@${encodeURIComponent('deepseek-ai/dsh')}`;
  const httpGet = opts.httpGet ?? defaultHttpGet;
  const timeoutMs = opts.timeoutMs ?? CHECK_TIMEOUT_MS;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await httpGet(url, { signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    let parsed: { 'dist-tags'?: { latest?: unknown } } | null = null;
    try {
      parsed = JSON.parse(res.text) as { 'dist-tags'?: { latest?: unknown } };
    } catch {
      /* 解析失败 → 走 fallback */
    }
    const raw = parsed?.['dist-tags']?.latest;
    if (typeof raw === 'string' && isValidVersion(raw)) {
      return raw;
    }
    // fallback：/latest 端点（返回裸版本串）
    const fb = await httpGet(`${url}/latest`, { signal: controller.signal });
    if (!fb.ok) throw new Error(`fallback HTTP ${fb.status}`);
    const fbText = fb.text.trim();
    if (!isValidVersion(fbText)) throw new Error(`latest 版本非法: ${fbText}`);
    return fbText;
  } catch (err) {
    throw new HullError('check-failed', `registry 检查失败: ${(err as Error).message}`);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * registry 版本检查（S3 设计 D4/B9/B10）：
 * fetchLatestVersion → semver 比较（prerelease 感知）→ hasUpdate。
 * 网络/解析/超时失败 → check-failed 错误语义。
 */
export async function checkLatestVersion(opts: CheckLatestOptions): Promise<CheckResult> {
  const current = opts.currentVersion();
  if (current === null) {
    throw new HullError('check-failed', '当前版本不可读（overlay 未就绪）');
  }
  const latest = await fetchLatestVersion({
    registry: opts.registry,
    getRegistry: opts.getRegistry, // Y-1：透传 settings.registry（B7 三消费点对齐）
    httpGet: opts.httpGet,
    timeoutMs: opts.timeoutMs,
  });
  return {
    hasUpdate: compareVersions(latest, current) > 0, // prerelease 感知（semver.ts）
    current,
    latest,
    // changeNotes 可空：S3 设计 B10 不拉 GitHub Releases，UI 不展示
  };
}
