/**
 * B1 备份范围：白名单 7 项（CON-R-backup-001）+ 瞬态过滤 + 路径守卫。
 * 纯路径逻辑（只读 realpath/stat/readdir，无写副作用）；拷贝编排在 backupService。
 *
 * 包内布局 = 源相对路径镜像（packRel 为项在包内的根）：
 *   settings.json / kanban/boards.json / workflows/workflows.json / notes/**（仅 .md） /
 *   skills/{disabled,trash}.json + skills/{disabled,trash}/** /
 *   notifications/notifications.json + dismiss.json
 */
import { existsSync, lstatSync, readdirSync, realpathSync } from 'node:fs';
import { basename, dirname, join, resolve, sep } from 'node:path';

export type ScopeItemId = 'settings' | 'kanban' | 'workflows' | 'notes' | 'notes-trash' | 'skills' | 'notifs';
export type ScopeItemKind = 'file' | 'tree';

/** 多源项的附加路径（相对该项的源根；parts 项源根 = userData 根） */
export interface ScopePart {
  rel: string;
  /** 包内相对路径，缺省 = rel */
  packRel?: string;
}

export interface ScopeItem {
  id: ScopeItemId;
  kind: ScopeItemKind;
  /** userData 内相对路径（目录用无尾斜杠相对路径）；notes 项为默认值，实际源走 ctx.notesDir */
  rel: string;
  /** 备份包内相对路径，缺省 = rel */
  packRel?: string;
  /** manifest.items[].version 提取器：读原始 JSON 取版本号，无版本 → null */
  versionOf?: (raw: unknown) => number | null;
  /** 允许缺失（缺失时该项不进 manifest.items，不失败） */
  optional?: boolean;
  /** 项内排除（如 notes 正文排除 .trash/ 与 trash.json，归 notes-trash 项） */
  exclude?: (relInItem: string) => boolean;
  /**
   * 多源项：同一 id 覆盖 userData 内多个不相邻路径。
   * 设计接口只给了单个 rel，无法表达 notifs（notifications.json + 根 dismiss.json）与
   * skills（两个索引 + trash/）；parts 相对 userData 根正列举，避免对 userData 全树 walk。
   */
  parts?: readonly ScopePart[];
}

export interface ScopeCtx {
  userDataPath: string;
  notesDir: string;
}

/** 从原始 JSON 对象取数值字段（非数值 → null） */
function numField(raw: unknown, key: string): number | null {
  if (raw === null || typeof raw !== 'object') return null;
  const v = (raw as Record<string, unknown>)[key];
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/** trash.json + .trash/**（含 .trash 目录自身：notes-trash 项取反后用同谓词，需能保留该目录） */
const isNotesTrashRel = (rel: string): boolean => rel === 'trash.json' || rel === '.trash' || rel.startsWith('.trash/');

/** 7 项（以 CON-R-backup-001 为准；改分组只改本表） */
export const BACKUP_SCOPE: readonly ScopeItem[] = [
  { id: 'settings', kind: 'file', rel: 'settings.json', versionOf: (raw) => numField(raw, 'schemaVersion'), optional: true },
  { id: 'kanban', kind: 'file', rel: 'kanban/boards.json', versionOf: (raw) => numField(raw, 'version'), optional: true },
  { id: 'workflows', kind: 'file', rel: 'workflows/workflows.json', versionOf: (raw) => numField(raw, 'version'), optional: true },
  {
    id: 'notes',
    kind: 'tree',
    rel: 'notes',
    packRel: 'notes',
    optional: true,
    // 仅收 .md：非 md（.DS_Store/图片/.txt）若入包，校验器 notes 仅 md 断言会整包拒绝 → 自产包无法恢复
    exclude: (rel) => isNotesTrashRel(rel) || !rel.endsWith('.md'),
  },
  {
    id: 'notes-trash',
    kind: 'tree',
    rel: 'notes',
    packRel: 'notes',
    optional: true,
    // 与 notes 项共存于包内 notes/ 子树（源同根）：本项只收 trash.json + .trash/**
    exclude: (rel) => !isNotesTrashRel(rel),
  },
  {
    id: 'skills',
    kind: 'tree',
    rel: '.',
    packRel: '.',
    optional: true,
    parts: [
      { rel: 'skills/disabled.json' },
      { rel: 'skills/disabled' },
      { rel: 'skills/trash.json' },
      { rel: 'skills/trash' },
    ],
  },
  {
    id: 'notifs',
    kind: 'tree',
    rel: '.',
    packRel: '.',
    optional: true,
    parts: [
      { rel: 'notifications/notifications.json' },
      { rel: 'dismiss.json' },
    ],
    versionOf: (raw) => numField(raw, 'version'),
  },
];

/** 拷贝期瞬态过滤（同时用于备份拷贝与恢复 staging 校验） */
export const EXCLUDE_NAME_PATTERNS: readonly RegExp[] = [
  /\.tmp$/,
  /\.tmp-/,
  /\.bak-\d+$/,
  /\.corrupt-\d+$/,
  /(^|\/)[^/]*-staging(\/|$)/,
];

/** 解析源绝对路径 / 包内相对路径；notes 项在 notesDir 外置时返回 null（= 不打包） */
export function resolveItemPaths(item: ScopeItem, ctx: ScopeCtx): { absSource: string; packRel: string } | null {
  if (item.id === 'notes') {
    const notesDir = resolve(ctx.notesDir);
    // notesDir == userData 属病态配置（会把整个数据目录当笔记打包），与"在 userData 外"同样不打包
    if (notesDir === resolve(ctx.userDataPath) || !isInsideUserData(notesDir, ctx.userDataPath)) return null;
    return { absSource: notesDir, packRel: item.packRel ?? item.rel };
  }
  return { absSource: join(ctx.userDataPath, item.rel), packRel: item.packRel ?? item.rel };
}

/** 枚举项内文件（相对路径数组；应用 exclude + EXCLUDE_NAME_PATTERNS；不拷贝） */
export function enumerateFiles(absSource: string, item: ScopeItem): string[] {
  const out: string[] = [];
  if (item.parts && item.parts.length > 0) {
    for (const part of item.parts) collectFiles(resolveRoot(join(absSource, part.rel)), part.rel, item, out);
  } else if (item.kind === 'file') {
    if (existsSync(absSource) && !isExcluded(item.rel, item)) out.push(item.rel);
  } else {
    collectFiles(resolveRoot(absSource), '', item, out);
  }
  return [...new Set(out)].sort();
}

/** 项根自身是符号链接时跟到 realpath（notesDir 常被 symlink 到 userData 内）；树内条目不跟随 */
function resolveRoot(p: string): string {
  try {
    return lstatSync(p).isSymbolicLink() ? realpathSync(p) : p;
  } catch {
    return p; // 缺失：交给 collectFiles 按无文件处理
  }
}

function collectFiles(abs: string, relInItem: string, item: ScopeItem, out: string[]): void {
  let st;
  try {
    st = lstatSync(abs);
  } catch {
    return; // 缺失按无文件处理（optional 语义在调用方）
  }
  // 不跟随符号链接：防目录环，也防止把 userData 外的目标内容卷进包
  if (st.isSymbolicLink()) return;
  if (st.isFile()) {
    if (relInItem !== '' && !isExcluded(relInItem, item)) out.push(relInItem);
    return;
  }
  if (!st.isDirectory()) return;
  for (const ent of readdirSync(abs, { withFileTypes: true })) {
    const childRel = relInItem === '' ? ent.name : `${relInItem}/${ent.name}`;
    // 目录只按瞬态模式剪枝：项内 exclude 谓词只判文件（notes「仅 .md」不能把目录整个剪掉，否则丢目录内 md）
    const pruned = ent.isDirectory()
      ? EXCLUDE_NAME_PATTERNS.some((p) => p.test(childRel))
      : isExcluded(childRel, item);
    if (pruned) continue;
    collectFiles(join(abs, ent.name), childRel, item, out);
  }
}

function isExcluded(relInItem: string, item: ScopeItem): boolean {
  if (EXCLUDE_NAME_PATTERNS.some((p) => p.test(relInItem))) return true;
  return item.exclude?.(relInItem) === true;
}

/** realpath 前缀守卫：备份目标不得位于 userData 内（防自包含）；目标 == userData → true */
export function isInsideUserData(target: string, userDataPath: string): boolean {
  const root = realpathOf(userDataPath);
  const t = realpathOf(target);
  return t === root || t.startsWith(root + sep);
}

/** realpath；目标不存在/悬空时退到最近存在祖先再拼回尾段（备份目标常常尚未创建） */
function realpathOf(p: string): string {
  const abs = resolve(p);
  try {
    return realpathSync(abs);
  } catch {
    /* 继续上退 */
  }
  const tail: string[] = [];
  let cur = abs;
  for (;;) {
    const parent = dirname(cur);
    if (parent === cur) return abs; // 到根仍失败：回退字面值
    tail.unshift(basename(cur));
    cur = parent;
    try {
      return join(realpathSync(cur), ...tail);
    } catch {
      /* 继续上退 */
    }
  }
}
