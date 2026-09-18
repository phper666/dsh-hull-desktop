/**
 * B1 manifest schema + 构建/解析/兼容性校验（设计 §1.2 / §3.1 / §3.2）。
 * 纯函数，无 IO；解析容忍未知字段（前向兼容），拒绝结构/类型/合计不一致。
 */
import { isAbsolute } from 'node:path';

import { KANBAN_SCHEMA_VERSION } from '../kanban/types';
import { SCHEMA_VERSION_CURRENT } from '../settings/SettingsProvider';

import type { BackupErrorCode } from './errors';
import { BACKUP_SCOPE, type ScopeItemId, type ScopeItemKind } from './scope';

export const FORMAT_VERSION_CURRENT = 1;
export const FORMAT_VERSION_MIN = 1;
export const MANIFEST_FILENAME = 'manifest.json';

export interface ManifestItem {
  id: ScopeItemId;
  /** 包内相对路径（'/' 分隔） */
  path: string;
  kind: ScopeItemKind;
  /** 该数据文件 schema 版本（settings.schemaVersion / boards.version / workflows.version …） */
  version: number | null;
  /** 字节合计 */
  size: number;
  fileCount: number;
}

export interface Manifest {
  /** 备份包格式版本（唯一兼容判据） */
  manifestVersion: number;
  /** 导出时 Hull 版本（用户可见，用于"请升级到 ≥X"提示） */
  appVersion: string;
  platform: NodeJS.Platform;
  /** ISO8601 */
  exportedAt: string;
  /** 导出时 settings.notesDir 原值（仅提示，不用于写入） */
  notesDirHint: string;
  items: ManifestItem[];
  counts: { files: number; bytes: number };
}

export type ParseResult<T> = { ok: true; value: T } | { ok: false; code: BackupErrorCode; message: string };

/** 各数据文件当前 schema 版本（高拒低迁判据；workflows/notifs 为对应 store 落盘的字面量 version=1） */
export const CURRENT_ITEM_VERSIONS: Partial<Record<ScopeItemId, number>> = {
  settings: SCHEMA_VERSION_CURRENT,
  kanban: KANBAN_SCHEMA_VERSION,
  workflows: 1,
  notifs: 1,
};

const SCOPE_IDS: readonly ScopeItemId[] = BACKUP_SCOPE.map((i) => i.id);
const PLATFORMS: readonly NodeJS.Platform[] = ['darwin', 'win32', 'linux'];

export function buildManifest(input: {
  appVersion: string;
  platform: NodeJS.Platform;
  exportedAt: Date;
  notesDirHint: string;
  items: ManifestItem[];
}): Manifest {
  const counts = input.items.reduce(
    (acc, i) => ({ files: acc.files + i.fileCount, bytes: acc.bytes + i.size }),
    { files: 0, bytes: 0 }
  );
  return {
    manifestVersion: FORMAT_VERSION_CURRENT,
    appVersion: input.appVersion,
    platform: input.platform,
    exportedAt: input.exportedAt.toISOString(),
    notesDirHint: input.notesDirHint,
    items: input.items,
    counts,
  };
}

/** 结构 + 类型 + 必填 + counts 一致性；未知字段容忍 */
export function parseManifest(raw: unknown): ParseResult<Manifest> {
  const fail = (message: string): ParseResult<Manifest> => ({ ok: false, code: 'restore-manifest-invalid', message });
  if (!isRecord(raw)) return fail('manifest 不是对象');

  const { manifestVersion, appVersion, platform, exportedAt, notesDirHint, items, counts } = raw;
  if (typeof manifestVersion !== 'number' || !Number.isInteger(manifestVersion) || manifestVersion < 1) {
    return fail('manifestVersion 非法（需整数 ≥1）');
  }
  if (typeof appVersion !== 'string' || appVersion === '') return fail('appVersion 缺失或非法');
  if (typeof platform !== 'string' || !PLATFORMS.includes(platform as NodeJS.Platform)) {
    return fail(`platform 非法：${String(platform)}`);
  }
  if (typeof exportedAt !== 'string' || Number.isNaN(Date.parse(exportedAt))) {
    return fail('exportedAt 缺失或不是 ISO8601 时间');
  }
  if (typeof notesDirHint !== 'string') return fail('notesDirHint 缺失');
  if (!Array.isArray(items) || items.length === 0) return fail('items 缺失或为空');

  const parsedItems: ManifestItem[] = [];
  for (let i = 0; i < items.length; i++) {
    const r = parseManifestItem(items[i], i);
    if (!r.ok) return r;
    parsedItems.push(r.value);
  }

  if (!isRecord(counts) || !isNonNegNumber(counts.files) || !isNonNegNumber(counts.bytes)) {
    return fail('counts 缺失或非法');
  }
  const sum = parsedItems.reduce((acc, i) => ({ files: acc.files + i.fileCount, bytes: acc.bytes + i.size }), {
    files: 0,
    bytes: 0,
  });
  if (sum.files !== counts.files || sum.bytes !== counts.bytes) {
    return fail(`counts 与 items 合计不一致（counts ${counts.files}/${counts.bytes}，items ${sum.files}/${sum.bytes}）`);
  }

  return {
    ok: true,
    value: {
      manifestVersion,
      appVersion,
      platform: platform as NodeJS.Platform,
      exportedAt,
      notesDirHint,
      items: parsedItems,
      counts: { files: counts.files, bytes: counts.bytes },
    },
  };
}

/** 区间校验：包格式 + 各数据版本（高拒低迁；version=null 放行） */
export function checkCompatibility(m: Manifest): ParseResult<Manifest> {
  if (m.manifestVersion > FORMAT_VERSION_CURRENT) {
    return {
      ok: false,
      code: 'restore-version-newer',
      message: `备份包格式版本 ${m.manifestVersion} 高于当前支持的 ${FORMAT_VERSION_CURRENT}；请升级 Hull 到 ≥ ${m.appVersion} 后重试`,
    };
  }
  if (m.manifestVersion < FORMAT_VERSION_MIN) {
    return {
      ok: false,
      code: 'restore-version-too-old',
      message: `备份包格式版本 ${m.manifestVersion} 低于最低支持版本 ${FORMAT_VERSION_MIN}`,
    };
  }
  for (const item of m.items) {
    const current = CURRENT_ITEM_VERSIONS[item.id];
    if (current === undefined || item.version === null) continue;
    if (item.version > current) {
      return {
        ok: false,
        code: 'restore-version-newer',
        message: `${item.id} 数据版本 ${item.version} 高于当前 ${current}；请升级 Hull 到 ≥ ${m.appVersion} 后重试`,
      };
    }
  }
  return { ok: true, value: m };
}

function parseManifestItem(raw: unknown, index: number): ParseResult<ManifestItem> {
  const fail = (message: string): ParseResult<ManifestItem> => ({
    ok: false,
    code: 'restore-manifest-invalid',
    message: `items[${index}] ${message}`,
  });
  if (!isRecord(raw)) return fail('不是对象');

  const { id, path, kind, version, size, fileCount } = raw;
  if (typeof id !== 'string' || !SCOPE_IDS.includes(id as ScopeItemId)) return fail(`id 非法：${String(id)}`);
  if (typeof path !== 'string' || path === '' || isAbsolute(path)) return fail('path 非法（需包内相对路径）');
  if (kind !== 'file' && kind !== 'tree') return fail(`kind 非法：${String(kind)}`);
  if (version !== null && !(typeof version === 'number' && Number.isFinite(version))) return fail('version 需为 number|null');
  if (!isNonNegNumber(size)) return fail('size 非法');
  if (!isNonNegNumber(fileCount) || !Number.isInteger(fileCount)) return fail('fileCount 非法');

  return {
    ok: true,
    value: { id: id as ScopeItemId, path, kind, version, size, fileCount },
  };
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isNonNegNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0;
}
