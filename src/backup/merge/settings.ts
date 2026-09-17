/**
 * B3 设置字段级合并（设计 §4.3）：
 * - value = {...local, ...incoming}（包内覆盖同名键，本地独有键保留）；
 * - 写盘前跑读路径归一化链（与 SettingsProvider.set 对称）：theme 白名单 / packageManager /
 *   notifPrefs / registry / channel+pinnedVersion 约束；任一非法 → 回退本地值 + kept-local；
 * - notesDir 特例：incoming 未携带（如包内无 settings）→ 保留本地值；携带则按 §3.4 解析
 *   （合法且存在取包内值，否则回退默认 + notice）。
 */
import { normalizeNotifPrefs } from '../../notifications/prefs';
import {
  SCHEMA_VERSION_CURRENT,
  type ChannelName,
  type HullSettings,
  type PkgMgrName,
  type ThemeName,
} from '../../settings/SettingsProvider';
import { isValidVersion } from '../../updater/semver';
import { resolveNotesDir } from '../validators';
import type { ConflictEntry, ResultNotice } from './conflicts';

export { resolveNotesDir };

/** registry 地址格式校验（与 SettingsProvider 私有实现同规：http/https；B2 落地后可收敛为共享导出） */
function isValidRegistry(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

export function mergeSettings(
  local: HullSettings,
  incoming: unknown,
  ctx: { userDataPath: string; exists(p: string): boolean },
): { value: HullSettings; conflicts: ConflictEntry[]; notices: ResultNotice[] } {
  const inc = (incoming && typeof incoming === 'object' ? incoming : {}) as Record<string, unknown>;
  const conflicts: ConflictEntry[] = [];
  const notices: ResultNotice[] = [];

  const keptLocal = (field: string, detail: string): void => {
    conflicts.push({ kind: 'setting', id: field, resolution: 'kept-local', detail });
  };
  const boolField = (key: 'closeToQuit' | 'autoCheckDsh' | 'autoCheckHull'): boolean => {
    const v = inc[key];
    if (v === undefined) return local[key];
    if (typeof v === 'boolean') return v;
    keptLocal(key, `非法值 ${String(v)}，回退本地`);
    return local[key];
  };
  const enumField = <T extends string>(key: string, allowed: readonly T[], fallback: T): T => {
    const v = inc[key];
    if (v === undefined) return fallback;
    if (typeof v === 'string' && (allowed as readonly string[]).includes(v)) return v as T;
    keptLocal(key, `非法值 ${String(v)}，回退本地`);
    return fallback;
  };

  const theme = enumField<ThemeName>('theme', ['dark', 'light', 'system'], local.theme);
  const packageManager = enumField<PkgMgrName>('packageManager', ['npm', 'pnpm'], local.packageManager);
  let channel = enumField<ChannelName>('channel', ['latest', 'pinned'], local.channel);

  let registry = local.registry;
  if (inc.registry !== undefined) {
    if (typeof inc.registry === 'string' && isValidRegistry(inc.registry)) registry = inc.registry;
    else keptLocal('registry', `非法 registry 地址 ${String(inc.registry)}，回退本地`);
  }

  let notifPrefs = local.notifPrefs;
  if (inc.notifPrefs !== undefined) {
    if (inc.notifPrefs && typeof inc.notifPrefs === 'object' && !Array.isArray(inc.notifPrefs)) {
      notifPrefs = normalizeNotifPrefs(inc.notifPrefs);
    } else {
      keptLocal('notifPrefs', '非法结构，回退本地');
    }
  }

  let pinnedVersion = local.pinnedVersion;
  if ('pinnedVersion' in inc) {
    const v = inc.pinnedVersion;
    if (v === null) pinnedVersion = null;
    else if (typeof v === 'string' && isValidVersion(v)) pinnedVersion = v;
    else keptLocal('pinnedVersion', `非法版本号 ${String(v)}，回退本地`);
  }
  if (channel === 'latest') {
    pinnedVersion = null; // B4 语义：latest 显式清 pinned（同事务）
  }
  if (channel === 'pinned' && !pinnedVersion) {
    keptLocal('channel', 'pinned 通道缺有效锁定版本，回退本地通道');
    channel = local.channel;
    pinnedVersion = local.pinnedVersion;
    if (channel === 'pinned' && !pinnedVersion) {
      channel = 'latest';
      pinnedVersion = null;
    }
  }

  // incoming 缺 notesDir（undefined）≠ 非法值：保留本地，避免包内无 settings 时被强制回退
  let notesDir = local.notesDir;
  if (inc.notesDir !== undefined) {
    const notesDirResult = resolveNotesDir(inc.notesDir, ctx);
    notesDir = notesDirResult.value;
    if (notesDirResult.fallback !== null && notesDirResult.notice) {
      notices.push(notesDirResult.notice);
      conflicts.push({ kind: 'setting', id: 'notesDir', resolution: 'kept-local', detail: notesDirResult.notice.message });
    }
  }

  return {
    value: {
      closeToQuit: boolField('closeToQuit'),
      schemaVersion: SCHEMA_VERSION_CURRENT,
      channel,
      pinnedVersion,
      autoCheckDsh: boolField('autoCheckDsh'),
      autoCheckHull: boolField('autoCheckHull'),
      registry,
      theme,
      packageManager,
      notifPrefs,
      notesDir,
    },
    conflicts,
    notices,
  };
}
