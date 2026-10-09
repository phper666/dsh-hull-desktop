/**
 * registry 发现（设计 §1.3 / 契约 #1，P2）：拉取 plugins.json → 内存缓存（TTL 1h，时钟注入）
 * → 失败回落缓存/snapshot（打包 assets/plugins-registry-snapshot.json 内置兜底）
 * → 全部失败 plugin-registry-unreachable（数据可用性优先，R3）。
 */
import { readFileSync } from 'node:fs';

import type { RuntimeLogger } from '../shared/types';

import { PluginError } from './errors';
import type { RegistryEntry } from './types';

export interface RegistryOptions {
  /** 默认社区 dsh-market plugins.json（settings.pluginRegistry 可配） */
  url: string;
  /** 内存缓存 TTL（默认 1h） */
  cacheTtlMs?: number;
  /** 打包 assets/plugins-registry-snapshot.json（内置兜底） */
  snapshotPath: string;
  /** 注入可测（默认 globalThis.fetch） */
  fetchImpl?: typeof fetch;
  /** 时钟注入（缓存 TTL 判定） */
  now?: () => Date;
  logger: RuntimeLogger;
}

export type RegistrySource = 'remote' | 'cache' | 'snapshot';

export interface RegistryLoadResult {
  entries: RegistryEntry[];
  source: RegistrySource;
  fetchedAt?: string;
}

const DEFAULT_TTL_MS = 60 * 60 * 1000; // 1h（dsh-market 同款）
const FETCH_TIMEOUT_MS = 15_000;

interface CacheEntry {
  entries: RegistryEntry[];
  fetchedAt: Date;
}

let cache: CacheEntry | null = null;

/** 清空内存缓存（settings.pluginRegistry 变更 / 测试） */
export function clearRegistryCache(): void {
  cache = null;
}

export async function loadRegistry(opts: RegistryOptions, forceRefresh = false): Promise<RegistryLoadResult> {
  const now = opts.now?.() ?? new Date();
  const ttl = opts.cacheTtlMs ?? DEFAULT_TTL_MS;

  if (!forceRefresh && cache && now.getTime() - cache.fetchedAt.getTime() < ttl) {
    return { entries: cache.entries, source: 'cache', fetchedAt: cache.fetchedAt.toISOString() };
  }

  try {
    const entries = await fetchRemote(opts);
    cache = { entries, fetchedAt: now };
    return { entries, source: 'remote', fetchedAt: now.toISOString() };
  } catch (err) {
    opts.logger.warn(`[plugins] registry 拉取失败：${(err as Error).message}（回落缓存/snapshot）`);
    // 失败回落：缓存（含过期，最近数据）→ snapshot（构建期冻结）→ 抛错
    if (cache) return { entries: cache.entries, source: 'cache', fetchedAt: cache.fetchedAt.toISOString() };
    const snap = loadSnapshot(opts.snapshotPath, opts.logger);
    if (snap) return { entries: snap, source: 'snapshot' };
    throw new PluginError('plugin-registry-unreachable', '市场 registry 不可达，且无可用缓存或内置快照');
  }
}

async function fetchRemote(opts: RegistryOptions): Promise<RegistryEntry[]> {
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  const res = await fetchImpl(opts.url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const raw: unknown = await res.json();
  const entries = normalizeEntries(raw);
  if (entries.length === 0) throw new Error('registry 数据为空或字段不合法');
  return entries;
}

/** registry/snapshot 顶层兼容：数组 或 { plugins: [...] }；逐项校验契约字段（缺 name/owner/url 丢弃） */
export function normalizeEntries(raw: unknown): RegistryEntry[] {
  const list = extractList(raw);
  const out: RegistryEntry[] = [];
  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    const r = item as Record<string, unknown>;
    const name = str(r.name);
    const owner = str(r.owner);
    const url = str(r.url);
    if (!name || !owner || !url) continue;
    out.push({
      name,
      owner,
      url,
      ...(str(r.category) ? { category: str(r.category) as string } : {}),
      ...(str(r.install) ? { install: str(r.install) as string } : {}),
      ...(r.deprecated === true ? { deprecated: true } : {}),
      ...(str(r.minDshVersion) ? { minDshVersion: str(r.minDshVersion) as string } : {}),
    });
  }
  return out;
}

function loadSnapshot(snapshotPath: string, logger: RuntimeLogger): RegistryEntry[] | null {
  try {
    const raw: unknown = JSON.parse(readFileSync(snapshotPath, 'utf8'));
    const entries = normalizeEntries(raw);
    if (entries.length === 0) return null;
    return entries;
  } catch (err) {
    logger.warn(`[plugins] snapshot 读取失败：${(err as Error).message}`);
    return null;
  }
}

function extractList(raw: unknown): unknown[] {
  if (Array.isArray(raw)) return raw;
  if (raw && typeof raw === 'object') {
    const plugins = (raw as Record<string, unknown>).plugins;
    if (Array.isArray(plugins)) return plugins;
  }
  return [];
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}
