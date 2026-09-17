/**
 * B2 恢复校验器（设计 §3.3~§3.5）：
 * - validateDataFiles：staged 包只读校验（manifest 实存/尺寸一致 + JSON 顶层结构 + trash 形状 +
 *   notes 仅 md + 守卫断言）；inspect 与启动期 verified 复跑同一函数（纯只读、幂等）。
 * - resolveNotesDir：notesDir 红线解析（§3.4 唯一实现；merge/settings 复用）。
 * - previewMigrations：设置/看板迁移预演（§3.5；纯函数与 SettingsProvider.migrate / KanbanStore.migrate 同源）。
 */
import { existsSync, lstatSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';

import { migrateKanbanData } from '../kanban/KanbanStore';
import { KANBAN_SCHEMA_VERSION, type KanbanData } from '../kanban/types';
import { forbiddenNotesDirReason } from '../notes/NotesService';
import { migrateSettingsObject, type HullSettings } from '../settings/SettingsProvider';

import type { BackupErrorCode } from './errors';
import type { Manifest } from './manifest';
import type { ResultNotice } from './result';
import { BACKUP_SCOPE, enumerateFiles, resolveItemPaths } from './scope';

const NOTES_DIR_FALLBACK_CODE = 'notes-dir-fallback';

// ── §3.3 关键文件可解析校验 ──

export interface ValidateInput {
  /** 备份包根（staged 包，只读） */
  stagedRoot: string;
  manifest: Manifest;
  /** 目标 userData（当前未参与内容校验，保留 schema 兼容 RestoreService 调用面） */
  userDataPath: string;
}

export type ValidateOutput =
  | { ok: true; notices: ResultNotice[] }
  | { ok: false; code: BackupErrorCode; message: string };

/**
 * 包内容校验（检查项见设计 §3.3，任一失败整包拒绝）：
 * 1. manifest.items[].path 实存且 size/fileCount 一致（枚举规则与 B1 同源，包内布局镜像源相对路径）
 * 2. JSON 顶层结构（settings/kanban/workflows/notifications）
 * 3. trash.json 条目形状（notes / skills）
 * 4. notes/** 仅 *.md
 * 5. 守卫断言：不含 dsh/node/corepack/Partitions/.restore/token-buckets/skills 哈希缓存/executions/runs.json/logs
 */
export function validateDataFiles(input: ValidateInput): ValidateOutput {
  const fail = (message: string): ValidateOutput => ({ ok: false, code: 'restore-manifest-invalid', message });
  const root = input.stagedRoot;

  const guardHit = findGuardHit(root);
  if (guardHit !== null) return fail(`包内出现禁止路径：${guardHit}（守卫断言，疑似伪造的全量包）`);

  const scopeById = new Map(BACKUP_SCOPE.map((i) => [i.id, i]));
  const itemById = new Map(input.manifest.items.map((i) => [i.id, i]));
  // 包内布局镜像源：fake ctx 令 notes 项落在 <stagedRoot>/notes（与 B1 resolveItemPaths 同规则）
  const stagedCtx = { userDataPath: root, notesDir: join(root, 'notes') };

  for (const item of input.manifest.items) {
    const scope = scopeById.get(item.id);
    if (!scope) return fail(`manifest 项 id 非法：${item.id}`);
    if (item.kind !== scope.kind) return fail(`manifest 项 ${item.id} kind 与白名单不符：${item.kind}`);
    const paths = resolveItemPaths(scope, stagedCtx);
    if (!paths) return fail(`manifest 项 ${item.id} 无法在包内定位`);
    if (item.path !== paths.packRel) return fail(`manifest 项 ${item.id} path 与包内布局不符：${item.path}`);

    const files = enumerateFiles(paths.absSource, scope);
    let size = 0;
    for (const rel of files) {
      const abs = scope.kind === 'file' ? paths.absSource : join(paths.absSource, rel);
      try {
        size += statSync(abs).size;
      } catch {
        return fail(`manifest 项 ${item.id} 文件不可读：${rel}`);
      }
      // 4) notes/** 仅 *.md（trash.json/.trash 归 notes-trash 项，已在 enumerateFiles 排除）
      if (item.id === 'notes' && !rel.endsWith('.md')) return fail(`notes 项含非 .md 文件：${rel}`);
    }
    if (files.length !== item.fileCount || size !== item.size) {
      return fail(
        `manifest 项 ${item.id} 与包内实际不一致（fileCount ${files.length}/${item.fileCount}，bytes ${size}/${item.size}）`
      );
    }
  }

  // 2) JSON 顶层结构
  if (itemById.has('settings')) {
    const r = readJsonAt(root, 'settings.json');
    if (r.state !== 'ok' || !isRecord(r.value) || typeof r.value.schemaVersion !== 'number') {
      return fail('settings.json 缺失/损坏/顶层结构非法（需对象 + schemaVersion 数值）');
    }
  }
  if (itemById.has('kanban')) {
    const r = readJsonAt(root, 'kanban/boards.json');
    if (r.state !== 'ok' || !isRecord(r.value) || typeof r.value.version !== 'number' || !Array.isArray(r.value.boards)) {
      return fail('kanban/boards.json 缺失/损坏/顶层结构非法（需 version:number + boards:[]）');
    }
  }
  if (itemById.has('workflows')) {
    const r = readJsonAt(root, 'workflows/workflows.json');
    if (r.state !== 'ok' || !isRecord(r.value) || typeof r.value.version !== 'number' || !Array.isArray(r.value.workflows)) {
      return fail('workflows/workflows.json 缺失/损坏/顶层结构非法（需 version:number + workflows:[]）');
    }
  }
  if (itemById.has('notifs')) {
    const r = readJsonAt(root, 'notifications/notifications.json');
    if (r.state !== 'ok' || !isRecord(r.value) || typeof r.value.version !== 'number' || !Array.isArray(r.value.notifications)) {
      return fail('notifications/notifications.json 缺失/损坏/顶层结构非法（需 version:number + notifications:[]）');
    }
    const d = readJsonAt(root, 'dismiss.json');
    if (d.state === 'invalid' || (d.state === 'ok' && !isRecord(d.value))) {
      return fail('dismiss.json 损坏/顶层结构非法（需对象）');
    }
  }

  // 3) trash 形状（notes 条目须含 sizeBytes：NotesTrash 加载器把缺字段条目视为损坏丢弃，
  //    与 merge/notes.ts readTrashEntries 同口径；skills TrashManager 不要求 → 保持现状）
  const notesTrash = readJsonAt(root, 'notes/trash.json');
  if (notesTrash.state === 'invalid') return fail('notes/trash.json 损坏');
  if (notesTrash.state === 'ok') {
    if (
      !isRecord(notesTrash.value) ||
      !Array.isArray(notesTrash.value.entries) ||
      !notesTrash.value.entries.every(isNotesTrashEntry)
    ) {
      return fail('notes/trash.json 结构非法（需 entries[] 元素含 id/originalPath/deletedAt/sizeBytes）');
    }
  }
  const skillsTrash = readJsonAt(root, 'skills/trash.json');
  if (skillsTrash.state === 'invalid') return fail('skills/trash.json 损坏');
  if (skillsTrash.state === 'ok') {
    if (
      !isRecord(skillsTrash.value) ||
      typeof skillsTrash.value.version !== 'number' ||
      !Array.isArray(skillsTrash.value.entries) ||
      !skillsTrash.value.entries.every(isTrashEntry)
    ) {
      return fail('skills/trash.json 结构非法（需 version + entries[] 元素含 id/originalPath/deletedAt）');
    }
  }
  const skillsDisabled = readJsonAt(root, 'skills/disabled.json');
  if (skillsDisabled.state === 'invalid') return fail('skills/disabled.json 损坏');
  if (skillsDisabled.state === 'ok' && (!isRecord(skillsDisabled.value) || !Array.isArray(skillsDisabled.value.entries))) {
    return fail('skills/disabled.json 结构非法（需 entries[]）');
  }

  return { ok: true, notices: [] };
}

// ── §3.4 notesDir 红线 ──

/**
 * notesDir 红线解析（设计 §3.4 判定顺序）：
 * ① 绝对路径字符串 ② forbiddenNotesDirReason === null ③ exists —— 任一失败回退 join(userDataPath,'notes') + notice。
 */
export function resolveNotesDir(
  raw: unknown,
  ctx: { userDataPath: string; exists(p: string): boolean }
): { value: string; fallback: string | null; notice: ResultNotice | null } {
  const fallbackPath = join(ctx.userDataPath, 'notes');
  const fail = (why: string): { value: string; fallback: string; notice: ResultNotice } => ({
    value: fallbackPath,
    fallback: fallbackPath,
    notice: { code: NOTES_DIR_FALLBACK_CODE, message: `包内笔记目录不可用（${why}），已回退默认目录` },
  });
  if (typeof raw !== 'string' || raw === '' || !isAbsolute(raw)) return fail('非绝对路径');
  const forbidden = forbiddenNotesDirReason(raw, ctx.userDataPath);
  if (forbidden !== null) return fail(forbidden);
  if (!ctx.exists(raw)) return fail('原路径不存在');
  return { value: raw, fallback: null, notice: null };
}

// ── §3.5 迁移预演 ──

export interface PreviewMigrationsInput {
  settingsRaw: unknown;
  boardsRaw: unknown;
  workflowsRaw: unknown;
  userDataPath: string;
}

export type PreviewMigrationsOutput =
  | { ok: true; settings: HullSettings; boards: KanbanData }
  | { ok: false; code: BackupErrorCode; message: string };

/**
 * 迁移预演（只读；不写盘、不触发 KanbanStore.backupAndRebuild —— CON-R-backup-010）。
 * 可选项缺失（null/undefined）按空对象/空看板预演；boards 高于当前或迁移抛错 → restore-migrate-preview-failed。
 */
export function previewMigrations(input: PreviewMigrationsInput): PreviewMigrationsOutput {
  const fail = (message: string): PreviewMigrationsOutput => ({
    ok: false,
    code: 'restore-migrate-preview-failed',
    message,
  });

  const settingsRaw = input.settingsRaw == null ? {} : input.settingsRaw;
  if (!isRecord(settingsRaw)) return fail('settings.json 顶层结构非法（需对象）');
  const settings = migrateSettingsObject(settingsRaw, input.userDataPath);

  const boardsRaw = input.boardsRaw == null ? { version: KANBAN_SCHEMA_VERSION, boards: [] } : input.boardsRaw;
  if (!isRecord(boardsRaw) || typeof boardsRaw.version !== 'number' || !Array.isArray(boardsRaw.boards)) {
    return fail('kanban/boards.json 顶层结构非法（需 version:number + boards:[]）');
  }
  if (boardsRaw.version > KANBAN_SCHEMA_VERSION) {
    return fail(`boards.json version ${boardsRaw.version} 高于当前 ${KANBAN_SCHEMA_VERSION}，无法降级`);
  }
  let boards: KanbanData;
  try {
    boards = migrateKanbanData({ version: boardsRaw.version, boards: boardsRaw.boards as KanbanData['boards'] });
  } catch (err) {
    return fail(`看板迁移失败：${(err as Error).message}`);
  }

  const workflowsRaw = input.workflowsRaw;
  if (
    workflowsRaw != null &&
    (!isRecord(workflowsRaw) || typeof workflowsRaw.version !== 'number' || !Array.isArray(workflowsRaw.workflows))
  ) {
    return fail('workflows/workflows.json 顶层结构非法（需 version:number + workflows:[]）');
  }

  return { ok: true, settings, boards };
}

// ── 内部 ──

/** 守卫断言（设计 §3.3-5，按包内相对路径，'/' 分隔）：跨包/壳自管/全量数据目录 */
const GUARD_TOP_DIRS = new Set(['dsh', 'node', 'corepack', 'Partitions', '.restore', 'logs']);
const GUARD_FILES = new Set([
  'token-buckets.json',
  'skills/hash-cache.json',
  'skills/remote-sig-cache.json',
  'workflows/runs.json',
]);
const GUARD_DIRS = ['skills/staging', 'kanban/executions'];

function hitsGuard(rel: string): boolean {
  if (GUARD_TOP_DIRS.has(rel.split('/')[0])) return true;
  if (GUARD_FILES.has(rel)) return true;
  return GUARD_DIRS.some((d) => rel === d || rel.startsWith(`${d}/`));
}

/** 递归扫描包内全部条目（不跟符号链接）；命中返回相对路径，否则 null */
function findGuardHit(root: string): string | null {
  const stack: Array<{ abs: string; rel: string }> = [{ abs: root, rel: '' }];
  while (stack.length > 0) {
    const cur = stack.pop() as { abs: string; rel: string };
    let names: string[];
    try {
      names = readdirSync(cur.abs);
    } catch {
      continue;
    }
    for (const name of names) {
      const rel = cur.rel === '' ? name : `${cur.rel}/${name}`;
      if (rel === 'manifest.json') continue;
      if (hitsGuard(rel)) return rel;
      try {
        if (lstatSync(join(cur.abs, name)).isDirectory()) stack.push({ abs: join(cur.abs, name), rel });
      } catch {
        /* 读取失败跳过（其余检查兜底） */
      }
    }
  }
  return null;
}

type JsonRead = { state: 'missing' } | { state: 'invalid' } | { state: 'ok'; value: unknown };

function readJsonAt(root: string, rel: string): JsonRead {
  const abs = join(root, rel);
  if (!existsSync(abs)) return { state: 'missing' };
  try {
    return { state: 'ok', value: JSON.parse(readFileSync(abs, 'utf8')) };
  } catch {
    return { state: 'invalid' };
  }
}

function isTrashEntry(v: unknown): boolean {
  return (
    isRecord(v) && typeof v.id === 'string' && typeof v.originalPath === 'string' && typeof v.deletedAt === 'string'
  );
}

/** notes 回收站条目：与 NotesTrash 加载器同口径（缺 sizeBytes 视为损坏 → 整包拒绝，防静默丢条目） */
function isNotesTrashEntry(v: unknown): boolean {
  return isTrashEntry(v) && typeof (v as { sizeBytes?: unknown }).sizeBytes === 'number';
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
