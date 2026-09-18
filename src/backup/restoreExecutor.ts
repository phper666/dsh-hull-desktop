/**
 * B2 启动期恢复执行器 + 状态机 + 自愈（设计 §1.5 / §2.3~2.5 / §6.2~6.4）。
 *
 * 纪律：
 * - 同步执行、内部全捕获：`runRestoreIfPending` 绝不 throw 穿透启动（CON-R-backup-007/012）。
 * - 每完成一步即原子落 `pending.step`（崩溃后续做，§2.4 幂等表）；失败先落 `phase='rolling-back'` 再回滚。
 * - 收尾顺序固定：writeResult → clearPending（先结果后清标记）。
 * - 文件级执行：tree 项按 scope 枚举（notes 排除 .trash/trash.json；notes-trash 只取二者），
 *   多源项（skills/notifs 的 parts）逐源处理；`.restore/` 自身不在白名单内，恢复过程不动自己。
 * - 回滚安全线：仅当 step ≥ backedUp（本地原件已全部移入 backup）才允许删除 userData 项文件；
 *   step=staged 时 userData 仍是原件，回滚只做「backup → userData」还原，绝不删除；
 *   删除集优先本轮冻结快照 `incoming`（sourceDir 仅作 staging 来源兜底）。N3 定版：还原用 copy（backup 不消费）
 *   → 显式回滚（pending 在、冻结快照可信）删除可无条件，包内独有文件也清掉，回滚后 = 恢复前状态且幂等。
 *   删除集回退 sourceDir（旧版/被篡改包枚举不可信）→ 跳过删除；无 pending 的 #3 = repair-only（仅补缺失文件，不删不覆盖）。
 * - 换机/缺项：项不在原位且 backup 侧也无 = 无数据可保护（交给 apply 落位），不算异常；
 *   manual 仅剩「无源可还原」（backup 与 incoming 均缺失且 step ≥ backedUp），不猜测不动现场。
 * - 成功收尾：`.restore/backup` 归档为 `.restore/backup-<ts>/`（活跃 backup/ 只存在于崩溃窗口），
 *   result.bakDir 指向归档路径供人工兜底；成功归档只保留最新 1 个（旧归档可删，backup-orphan-* 不动）。
 * - N1：新一轮恢复（step=requested）前把上轮残留 backup 移出为 `.restore/backup-orphan-<ts>/`（绝不 rm 用户原件；
 *   上轮回滚失败时原件可能只在此）；孤儿目录保留不自动清理（清理入口记 v2）。
 * - staging 时 `manifest.json` 一并拷入 `.restore/manifest.json`；step ≥ staged 优先读本地副本（包被移走/拔出仍可完成）。
 */
import { randomUUID } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';

import type { HullSettings } from '../settings/SettingsProvider';
import type { RuntimeLogger } from '../shared/types';
import { createNodeFsOps } from '../skills/SkillFsOps';

import { BackupError, type BackupErrorCode } from './errors';
import { MANIFEST_FILENAME, parseManifest, type Manifest } from './manifest';
import type { MergeReport } from './merge/conflicts';
import { applyMerge } from './merge/index';
import { markMissingPaths } from './merge/skills';
import {
  clearPending,
  readPending,
  writePending,
  writeResult,
  type PendingFile,
  type ResultNotice,
  type RestoreResult,
} from './result';
import { BACKUP_SCOPE, enumerateFiles, resolveItemPaths, type ScopeCtx, type ScopeItem, type ScopeItemId } from './scope';
import { resolveNotesDir, validateDataFiles } from './validators';

const fsOps = createNodeFsOps();

/** CON-R-backup-008 回退提示 code（与 validators.resolveNotesDir 同契约） */
const NOTES_DIR_FALLBACK_CODE = 'notes-dir-fallback';

// ─────────────────────────── 类型（设计 §1.5 冻结） ───────────────────────────

export type RestoreStep = 'requested' | 'staged' | 'backedUp' | 'applied' | 'verified';
export type RestorePhase = 'forward' | 'rolling-back';

export const STEP_ORDER: readonly RestoreStep[] = ['requested', 'staged', 'backedUp', 'applied', 'verified'];

/** 下一步；verified 为终点（null）；未知 step 抛错（防御非法标记） */
export function nextStep(s: RestoreStep): RestoreStep | null {
  const i = STEP_ORDER.indexOf(s);
  if (i < 0) throw new Error(`未知恢复步骤：${String(s)}`);
  return i === STEP_ORDER.length - 1 ? null : STEP_ORDER[i + 1];
}

export interface ObservedState {
  hasPending: boolean;
  step: RestoreStep;
  phase: RestorePhase;
  sourceDirExists: boolean;
  incomingComplete: boolean;
  backupComplete: boolean;
  itemsInPlace: 'all' | 'partial' | 'missing-unknown';
}

export type HealAction = 'continue' | 'rollback' | 'finish' | 'cleanup' | 'manual';

const stepIndex = (s: RestoreStep): number => STEP_ORDER.indexOf(s);

/** 纯函数：自愈决策（设计 §2.5 定版 11 行决策表；单测主对象） */
export function decideHeal(s: ObservedState): HealAction {
  const atLeastBackedUp = stepIndex(s.step) >= stepIndex('backedUp');

  if (!s.hasPending) {
    if (!s.backupComplete) return 'cleanup'; // #1：.restore 无 incoming/backup → 删空目录
    if (s.itemsInPlace === 'all') return 'cleanup'; // #2：保留 backup，记 warning
    return 'rollback'; // #3：repair-only——仅从 backup 补齐缺失文件（不删除/不覆盖现有文件）
  }

  if (s.phase === 'rolling-back') {
    // #9/#10（N2/N3 修订）：回滚已非破坏且幂等（copy 还原 + 无条件清包内路径），missing-unknown 不再拦 manual；
    //        manual 仅剩「无源可还原」：backup 与 incoming 均缺失且 step ≥ backedUp（#11b）
    if (atLeastBackedUp && !s.backupComplete && !s.incomingComplete) return 'manual';
    return 'rollback';
  }

  // #8：verified = 全部步骤已完成，仅收尾（此时 incoming 可能已被替换阶段消费，不得按 #11 误判）
  if (s.step === 'verified') return 'finish';

  // #11：backup 与 incoming 均缺失且 step ≥ backedUp → 无法续做也无法回滚
  if (atLeastBackedUp && !s.backupComplete && !s.incomingComplete) return 'manual';

  if (s.step === 'requested') return s.sourceDirExists ? 'continue' : 'finish'; // #4 / #5
  return 'continue'; // #6 / #7：staged/backedUp/applied（incoming 不完整 → 重做 staging）
}

export interface RestoreExecutorDeps {
  userDataPath: string;
  logger: RuntimeLogger;
  /** HULL_E2E_FAIL_AT（仅 HULL_E2E=1 生效）：restore-after-stage / -after-backup / -after-apply / -before-verify（可 ':exit'） */
  failAt?: string;
  now?: () => Date;
}

export type RestoreOutcome =
  | { status: 'none' }
  | { status: 'success'; result: RestoreResult }
  | { status: 'rolledBack'; result: RestoreResult }
  | { status: 'failed'; result: RestoreResult };

// ─────────────────────────── 路径与枚举工具 ───────────────────────────

const restoreDirOf = (userDataPath: string): string => join(userDataPath, '.restore');
const incomingDirOf = (userDataPath: string): string => join(restoreDirOf(userDataPath), 'incoming');
const incomingTmpDirOf = (userDataPath: string): string => join(restoreDirOf(userDataPath), 'incoming.tmp');
const backupDirOf = (userDataPath: string): string => join(restoreDirOf(userDataPath), 'backup');

function itemsOf(pending: PendingFile | null): ScopeItem[] {
  if (!pending) return [...BACKUP_SCOPE];
  const ids = new Set<ScopeItemId>(pending.items);
  return BACKUP_SCOPE.filter((i) => ids.has(i.id));
}

/** 项在给定 root 下的根路径（parts 项逐 part） */
function itemRoots(scope: ScopeItem, root: string): string[] {
  if (scope.parts && scope.parts.length > 0) return scope.parts.map((p) => join(root, p.rel));
  return [join(root, scope.packRel ?? scope.rel)];
}

/** 枚举项内文件（相对项根；应用 exclude + EXCLUDE_NAME_PATTERNS），root 语义 = userData/包/备份根 */
function filesOf(scope: ScopeItem, root: string): string[] {
  const ctx: ScopeCtx = { userDataPath: root, notesDir: join(root, 'notes') };
  const resolved = resolveItemPaths(scope, ctx);
  if (!resolved) return [];
  return enumerateFiles(resolved.absSource, scope);
}

/** 项内相对路径 → root 下绝对路径（file 项 = 项根文件本身；tree 项 = 项根/rel） */
function itemAbs(scope: ScopeItem, root: string, rel: string): string {
  const base = join(root, scope.packRel ?? scope.rel);
  return scope.kind === 'file' ? base : join(base, rel);
}

/** 目录下是否存在至少一个文件（递归；判定 incoming/backup "有内容" 用） */
function hasAnyFile(dir: string): boolean {
  if (!existsSync(dir)) return false;
  try {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.isFile()) return true;
      if (e.isDirectory() && hasAnyFile(join(dir, e.name))) return true;
    }
  } catch {
    return false;
  }
  return false;
}

// ─────────────────────────── 观察态采样 ───────────────────────────

/**
 * 现数据项位置：all = 都在原位；partial = 缺项能从 backup 补齐；
 * missing-unknown = 仅回滚续做（strictRollback）时产生：项既不在原位也不在 backup，现场不可解释。
 * 非回滚（换机/新装/正向续做）两处皆无 = 从未有过 → 不算缺项（不计 missing），交给 apply 落位。
 */
function computeItemsInPlace(
  userDataPath: string,
  items: ScopeItem[],
  backupRoot: string,
  strictRollback: boolean,
): ObservedState['itemsInPlace'] {
  let missing = 0;
  for (const scope of items) {
    const inPlace = itemRoots(scope, userDataPath).some((p) => existsSync(p));
    if (inPlace) continue;
    const inBackup = itemRoots(scope, backupRoot).some((p) => existsSync(p));
    if (inBackup) {
      missing++;
      continue;
    }
    // 回滚续做：原件应已备过；两处皆无 = 不可解释（防误判，保留现场）
    if (strictRollback) return 'missing-unknown';
  }
  return missing === 0 ? 'all' : 'partial';
}

function observe(userDataPath: string, pending: PendingFile | null): ObservedState {
  const items = itemsOf(pending);
  const backupRoot = backupDirOf(userDataPath);
  return {
    hasPending: pending !== null,
    step: (pending?.step ?? 'requested') as RestoreStep,
    phase: (pending?.phase ?? 'forward') as RestorePhase,
    sourceDirExists: pending ? existsSync(pending.sourceDir) : false,
    incomingComplete: !existsSync(incomingTmpDirOf(userDataPath)) && hasAnyFile(incomingDirOf(userDataPath)),
    backupComplete: hasAnyFile(backupRoot),
    itemsInPlace: computeItemsInPlace(userDataPath, items, backupRoot, pending !== null && pending.phase === 'rolling-back'),
  };
}

// ─────────────────────────── 启动入口 ───────────────────────────

/** 启动早期入口（幂等；内部捕获全部异常，绝不阻断启动） */
export function runRestoreIfPending(deps: RestoreExecutorDeps): RestoreOutcome {
  try {
    return runOnce(deps);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    safeLog(deps, 'error', `[restore] 执行器异常（已捕获，不阻断启动）：${message}`);
    const result = buildResult(deps, null, 'failed', { code: 'restore-apply-failed', message }, null);
    // Y1：异常也落盘 result(failed) + 清标记（否则每次启动静默重试且 UI 无内容）；
    //     仅当写盘本身失败时保留标记（下次启动幂等重试）
    try {
      writeResult(deps.userDataPath, result);
    } catch (writeErr) {
      safeLog(deps, 'warn', `[restore] 异常结果落盘失败，保留 pending 下次重试：${(writeErr as Error).message}`);
      return { status: 'failed', result };
    }
    try {
      clearPending(deps.userDataPath);
    } catch (clearErr) {
      safeLog(deps, 'warn', `[restore] 清除 pending 失败（下次启动幂等重跑）：${(clearErr as Error).message}`);
    }
    return { status: 'failed', result };
  }
}

function runOnce(deps: RestoreExecutorDeps): RestoreOutcome {
  const pending = readPending(deps.userDataPath);
  const observed = observe(deps.userDataPath, pending);
  const action = decideHeal(observed);
  safeLog(
    deps,
    'info',
    `[restore] 观察 hasPending=${observed.hasPending} step=${observed.step} phase=${observed.phase} ` +
      `source=${observed.sourceDirExists} incoming=${observed.incomingComplete} backup=${observed.backupComplete} ` +
      `items=${observed.itemsInPlace} → ${action}`,
  );

  switch (action) {
    case 'manual':
      return manualOutcome(deps, pending, '恢复现场不可判定（数据项既不在原位也不在预备份中），需人工处理');
    case 'cleanup':
      return cleanupOutcome(deps, observed);
    case 'rollback':
      return doRollback(deps, pending, itemsOf(pending), null, 'rollback');
    case 'finish':
      return finishOutcome(deps, pending, observed);
    case 'continue':
      return advance(deps, pending as PendingFile);
  }
}

// ─────────────────────────── 收尾 / 清理 / 人工 ───────────────────────────

function safeLog(deps: RestoreExecutorDeps, level: 'info' | 'warn' | 'error', message: string): void {
  try {
    deps.logger[level](message);
  } catch {
    /* 日志失败不得影响恢复状态机 */
  }
}

function nowOf(deps: RestoreExecutorDeps): Date {
  return deps.now?.() ?? new Date();
}

/** 活跃预备份有内容 → 路径，否则 null（人工兜底入口只在真有数据时给） */
function currentBackupDir(deps: RestoreExecutorDeps): string | null {
  const dir = backupDirOf(deps.userDataPath);
  return hasAnyFile(dir) ? dir : null;
}

function buildResult(
  deps: RestoreExecutorDeps,
  pending: PendingFile | null,
  status: RestoreResult['status'],
  error: RestoreResult['error'],
  merge: MergeReport | null,
  extraNotices: ResultNotice[] = [],
  bakDir: string | null = currentBackupDir(deps),
): RestoreResult {
  return {
    version: 1,
    mode: pending?.mode ?? 'replace',
    status,
    finishedAt: nowOf(deps).toISOString(),
    bakDir,
    notices: [...(merge?.notices ?? []), ...extraNotices],
    merge,
    error,
  };
}

/** finish：verified → success 收尾；requested + 源缺失 → failed(restore-source-missing)（现数据零改动） */
function finishOutcome(deps: RestoreExecutorDeps, pending: PendingFile | null, observed: ObservedState): RestoreOutcome {
  if (pending && observed.step !== 'verified' && !observed.sourceDirExists) {
    const result = buildResult(
      deps,
      pending,
      'failed',
      { code: 'restore-source-missing', message: `备份包目录不存在：${pending.sourceDir}` },
      null,
    );
    commitResult(deps, result);
    safeLog(deps, 'error', `[restore] 源缺失，放弃恢复（现数据零改动）：${pending.sourceDir}`);
    return { status: 'failed', result };
  }
  return finishSuccess(deps, pending, null);
}

function finishSuccess(
  deps: RestoreExecutorDeps,
  pending: PendingFile | null,
  merge: MergeReport | null,
  extraNotices: ResultNotice[] = [],
): RestoreOutcome {
  const bakDir = archiveBackup(deps); // R3：归档后才写 result（bakDir 指向归档路径）
  const result = buildResult(deps, pending, 'success', null, merge, extraNotices, bakDir);
  commitResult(deps, result);
  safeLog(deps, 'info', `[restore] 完成 status=success mode=${result.mode} backup=${bakDir ?? '无'}`);
  return { status: 'success', result };
}

/**
 * N1：新一轮恢复前把上轮残留 `.restore/backup` 整体移出为 `backup-orphan-<ts>/`——上轮回滚失败时
 * 本地原件可能只存在于 backup，绝不 rm（孤儿目录保留不自动清理，清理入口记 v2）。
 * 移出失败 → false（本轮不开始；新旧预映像混入同一 backup/ 会让回滚串数据）。
 */
function orphanPreviousBackup(deps: RestoreExecutorDeps): boolean {
  const active = backupDirOf(deps.userDataPath);
  if (!hasAnyFile(active)) return true;
  const base = join(restoreDirOf(deps.userDataPath), `backup-orphan-${nowOf(deps).getTime()}`);
  const orphan = existsSync(base) ? `${base}-${randomUUID().slice(0, 8)}` : base;
  try {
    renameSync(active, orphan);
    safeLog(deps, 'warn', `[restore] 上轮 backup 残留（可能含未还原原件）已保留至 ${orphan}`);
    return true;
  } catch (err) {
    safeLog(deps, 'error', `[restore] 上轮 backup 残留移出失败（保留原位）：${(err as Error).message}`);
    return false;
  }
}

/**
 * R3①：成功后把 `.restore/backup` 归档为 `.restore/backup-<ts>/`——活跃 backup/ 只应存在于崩溃窗口，
 * 消除「无 pending + backup 有内容 + 某白名单项缺失 → 静默全量回滚」歧义；归档路径写入 result.bakDir 兜底。
 * rename 失败（极端 IO）→ 保留活跃 backup 并 warn（宁可留歧义也不丢兜底数据）。
 * N1：归档后修剪旧成功归档，只保留最新 1 个（backup-orphan-* 不动）。
 */
function archiveBackup(deps: RestoreExecutorDeps): string | null {
  const active = backupDirOf(deps.userDataPath);
  if (!hasAnyFile(active)) return null;
  const stamp = nowOf(deps).getTime();
  let archived = join(restoreDirOf(deps.userDataPath), `backup-${stamp}`);
  if (existsSync(archived)) archived = join(restoreDirOf(deps.userDataPath), `backup-${stamp}-${randomUUID().slice(0, 8)}`);
  try {
    renameSync(active, archived);
    pruneArchives(deps, archived);
    return archived;
  } catch (err) {
    safeLog(deps, 'warn', `[restore] backup 归档失败（保留活跃路径兜底）：${(err as Error).message}`);
    return active;
  }
}

/** N1：成功归档修剪——只保留最新 1 个 `backup-<ts>[/-uuid]`；backup-orphan-* 与活跃 backup 不在删除集 */
function pruneArchives(deps: RestoreExecutorDeps, keep: string): void {
  const dir = restoreDirOf(deps.userDataPath);
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of names) {
    if (!/^backup-\d/.test(name)) continue; // 孤儿（backup-orphan-*）/活跃 backup 不匹配
    const abs = join(dir, name);
    if (abs === keep) continue;
    try {
      rmSync(abs, { recursive: true, force: true });
    } catch (err) {
      safeLog(deps, 'warn', `[restore] 旧归档清理失败（无害）：${name}：${(err as Error).message}`);
    }
  }
}

/** writeResult → clearPending（先结果后清标记；清标记失败下次幂等重跑） */
function commitResult(deps: RestoreExecutorDeps, result: RestoreResult): void {
  try {
    writeResult(deps.userDataPath, result);
  } catch (err) {
    safeLog(deps, 'error', `[restore] 结果落盘失败：${(err as Error).message}`);
  }
  try {
    clearPending(deps.userDataPath);
  } catch (err) {
    safeLog(deps, 'warn', `[restore] 清除 pending 失败（下次启动幂等重跑）：${(err as Error).message}`);
  }
}

/** 不可判定：写 result(failed) 但保留 pending 与现场（不猜测不动数据） */
function manualOutcome(deps: RestoreExecutorDeps, pending: PendingFile | null, message: string): RestoreOutcome {
  const result = buildResult(deps, pending, 'failed', { code: 'restore-manual-required', message }, null);
  try {
    writeResult(deps.userDataPath, result);
  } catch (err) {
    safeLog(deps, 'error', `[restore] 人工介入结果落盘失败：${(err as Error).message}`);
  }
  safeLog(deps, 'error', `[restore] restore-manual-required：${message}`);
  return { status: 'failed', result };
}

/** cleanup：清 stale incoming（保留 backup/result），.restore 空则删目录 */
function cleanupOutcome(deps: RestoreExecutorDeps, observed: ObservedState): RestoreOutcome {
  try {
    rmSync(incomingTmpDirOf(deps.userDataPath), { recursive: true, force: true });
    rmSync(incomingDirOf(deps.userDataPath), { recursive: true, force: true });
    // O7：本地 manifest 副本属 staging 残留，无 pending 即失效
    rmSync(join(restoreDirOf(deps.userDataPath), MANIFEST_FILENAME), { force: true });
    const dir = restoreDirOf(deps.userDataPath);
    if (existsSync(dir) && readdirSync(dir).length === 0) rmSync(dir, { recursive: true, force: true });
  } catch (err) {
    safeLog(deps, 'warn', `[restore] cleanup 失败（无害）：${(err as Error).message}`);
  }
  if (observed.backupComplete && observed.itemsInPlace === 'all') {
    safeLog(deps, 'warn', '[restore] 检测到 .restore/backup 残留且现数据齐全：保留备用（决策表 #2）');
  }
  return { status: 'none' };
}

// ─────────────────────────── 正向推进 ───────────────────────────

function advance(deps: RestoreExecutorDeps, pending: PendingFile): RestoreOutcome {
  const items = itemsOf(pending);
  let p = pending;
  let mergeReport: MergeReport | null = null;
  const extraNotices: ResultNotice[] = [];

  // N1：新一轮恢复（step=requested）先把上轮残留 backup 移出为 backup-orphan-<ts>/（绝不 rm 用户原件）。
  //     移出失败 → 本轮不开始（保留现场，下次启动重试），避免新旧预映像混入同一 backup/ 造成回滚串数据。
  if (p.step === 'requested' && !orphanPreviousBackup(deps)) {
    return manualOutcome(deps, pending, '上轮备份残留无法移出（原件保留原位），本轮恢复未开始，可重启重试');
  }

  try {
    // S1 staged
    if (p.step === 'requested') {
      stageFromSource(deps, p);
      p = saveStep(deps, p, 'staged');
      injectFail(deps, 'restore-after-stage');
    }

    const manifest = loadManifest(p, deps.userDataPath); // 后续步骤（含校验）依赖 manifest

    if ((p.step === 'staged' || p.step === 'backedUp') && !incomingComplete(deps.userDataPath, items, manifest)) {
      safeLog(deps, 'warn', '[restore] incoming 缺失/不完整 → 重做 staging（决策表 #7）');
      stageFromSource(deps, p);
      p = saveStep(deps, p, 'staged');
      injectFail(deps, 'restore-after-stage');
    }

    // S2 backedUp：逐文件 rename userData → .restore/backup（源缺+目标在 = 已完成）
    if (p.step === 'staged') {
      backupExisting(deps, items);
      p = saveStep(deps, p, 'backedUp');
      injectFail(deps, 'restore-after-backup');
    }

    // S3 applied
    if (p.step === 'backedUp') {
      if (p.mode === 'merge') {
        resetToPackageBaseline(deps, items); // 可重入：userData 物化为包内基线（从 incoming 重新放置）
        mergeReport = runMerge(deps);
      } else {
        applyReplace(deps, items);
        markSkillsMissingPaths(deps, items); // CON-R-backup-008：replace 侧标注（merge 由 mergeSkills 内部标注）
      }
      // CON-R-backup-008：settings 落位后 notesDir 兜底（merge 已由 mergeSettings 处理 → 去重跳过）
      const notesNotice = postProcessNotesDir(deps, mergeReport?.notices ?? []);
      if (notesNotice) extraNotices.push(notesNotice);
      injectFail(deps, 'restore-after-apply');
      p = saveStep(deps, p, 'applied');
    }

    // S4 verified：复校验（replace 校验落地数据；merge 校验包内基线完整性）
    if (p.step === 'applied') {
      injectFail(deps, 'restore-before-verify');
      verify(deps, manifest);
      p = saveStep(deps, p, 'verified');
    }

    return finishSuccess(deps, p, mergeReport, extraNotices);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const code: BackupErrorCode = err instanceof BackupError ? err.code : 'restore-apply-failed';
    safeLog(deps, 'error', `[restore] step=${p.step} 失败：${message} → 回滚`);
    try {
      p = savePhase(deps, p, 'rolling-back');
    } catch (writeErr) {
      safeLog(deps, 'warn', `[restore] rolling-back 落盘失败（继续回滚）：${(writeErr as Error).message}`);
    }
    return doRollback(deps, p, items, code, message);
  }
}

/** S1：rm incoming* → 拷包内 → incoming.tmp → rename incoming（每轮重建，无半成品） */
function stageFromSource(deps: RestoreExecutorDeps, pending: PendingFile): void {
  const sourceDir = pending.sourceDir;
  if (!existsSync(sourceDir)) {
    throw new BackupError('restore-source-missing', `备份包目录不存在：${sourceDir}`);
  }
  const tmp = incomingTmpDirOf(deps.userDataPath);
  const incoming = incomingDirOf(deps.userDataPath);
  rmSync(tmp, { recursive: true, force: true });
  rmSync(incoming, { recursive: true, force: true });
  mkdirSync(tmp, { recursive: true });

  for (const scope of itemsOf(pending)) {
    for (const rel of filesOf(scope, sourceDir)) {
      const src = itemAbs(scope, sourceDir, rel);
      const dst = itemAbs(scope, tmp, rel);
      mkdirSync(dirname(dst), { recursive: true });
      copyFileSync(src, dst);
    }
  }
  // O7：manifest 一并拷入 .restore/（step ≥ staged 后不再依赖外部包目录）；包内无 manifest → 删旧副本防冒充
  const localManifest = join(restoreDirOf(deps.userDataPath), MANIFEST_FILENAME);
  const srcManifest = join(sourceDir, MANIFEST_FILENAME);
  if (existsSync(srcManifest)) copyFileSync(srcManifest, localManifest);
  else rmSync(localManifest, { force: true });
  renameSync(tmp, incoming); // 原子就绪
}

/** incoming 是否完整（按 manifest fileCount 对账；无 manifest 项要求至少 1 文件） */
function incomingComplete(userDataPath: string, items: ScopeItem[], manifest: Manifest): boolean {
  if (!existsSync(incomingDirOf(userDataPath)) || existsSync(incomingTmpDirOf(userDataPath))) return false;
  for (const scope of items) {
    const declared = manifest.items.find((i) => i.id === scope.id);
    const count = filesOf(scope, incomingDirOf(userDataPath)).length;
    if (declared && count !== declared.fileCount) return false;
    if (!declared && count === 0) return false;
  }
  return true;
}

/** S2：逐项 rename userData → backup（源缺+目标在 = 已完成；rename 原子，不产生半文件） */
function backupExisting(deps: RestoreExecutorDeps, items: ScopeItem[]): void {
  const backupRoot = backupDirOf(deps.userDataPath);
  for (const scope of items) {
    for (const rel of filesOf(scope, deps.userDataPath)) {
      const src = itemAbs(scope, deps.userDataPath, rel);
      if (!existsSync(src)) continue; // 源缺（目标在 = 已完成；两缺 = 源本就没有）
      const dst = itemAbs(scope, backupRoot, rel);
      mkdirSync(dirname(dst), { recursive: true });
      rmSync(dst, { force: true }); // 幂等重跑：覆盖旧目标
      renameSync(src, dst);
    }
  }
}

/**
 * S3 replace：逐文件换入（copy 而非 move：incoming 保留到收尾，供 verified 复校验；
 * 目标已在 → 覆盖 = 幂等重跑）。
 */
function applyReplace(deps: RestoreExecutorDeps, items: ScopeItem[]): void {
  const incoming = incomingDirOf(deps.userDataPath);
  for (const scope of items) {
    for (const rel of filesOf(scope, incoming)) {
      const src = itemAbs(scope, incoming, rel);
      if (!existsSync(src)) continue; // incoming 已不完整：交给 verified 复校验兜底
      const dst = itemAbs(scope, deps.userDataPath, rel);
      mkdirSync(dirname(dst), { recursive: true });
      rmSync(dst, { recursive: true, force: true });
      copyFileSync(src, dst);
    }
  }
}

/**
 * S3 后处理（CON-R-backup-008）：读回已落位 settings.json → resolveNotesDir；
 * 原路径不存在/非法 → 原子改写 notesDir=默认目录 + 返回 notice；合法 → 不动。
 * best-effort：任何异常只记 warning，绝不让恢复失败（merge 已有同类 notice 时跳过，不重复计）。
 */
function postProcessNotesDir(deps: RestoreExecutorDeps, existing: ResultNotice[]): ResultNotice | null {
  if (existing.some((n) => n.code === NOTES_DIR_FALLBACK_CODE)) return null;
  const settingsPath = join(deps.userDataPath, 'settings.json');
  try {
    const raw = readJsonIfExists(settingsPath);
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null; // 缺失/损坏：不动
    const settings = raw as Record<string, unknown>;
    const resolved = resolveNotesDir(settings.notesDir, { userDataPath: deps.userDataPath, exists: existsSync });
    if (resolved.fallback === null) return null;
    fsOps.writeFileSyncAtomic(settingsPath, JSON.stringify({ ...settings, notesDir: resolved.fallback }));
    const original = typeof settings.notesDir === 'string' && settings.notesDir !== '' ? settings.notesDir : '未设置';
    safeLog(deps, 'warn', `[restore] notesDir 回退：${original} → ${resolved.fallback}`);
    return {
      code: NOTES_DIR_FALLBACK_CODE,
      message: `原笔记目录不可用（${original}），已回退默认目录 ${resolved.fallback}`,
    };
  } catch (err) {
    safeLog(deps, 'warn', `[restore] notesDir 后处理失败（忽略，不影响恢复）：${(err as Error).message}`);
    return null;
  }
}

/**
 * S3 replace 后处理（CON-R-backup-008）：skills 索引条目 originalPath 不存在 / 实体目录缺失 → 原子标注
 * `missingPath: true`（仅展示；不清洗条目、不重映射；已标注且无变更 → 不重写）。复用 merge 侧 markMissingPaths
 * （实体判定与 merge/skills.ts 对称：disabled/trash 实体目录缺失 → 点「启用/恢复」必失败；symlink 条目无实体免判）。
 * best-effort：任何异常只记 warning，绝不让恢复失败。
 */
function markSkillsMissingPaths(deps: RestoreExecutorDeps, items: ScopeItem[]): void {
  if (!items.some((i) => i.id === 'skills')) return;
  for (const name of ['disabled.json', 'trash.json'] as const) {
    const entityDir = name === 'disabled.json' ? 'disabled' : 'trash';
    const path = join(deps.userDataPath, 'skills', name);
    try {
      const raw = readJsonIfExists(path);
      if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) continue;
      const entries = (raw as { entries?: unknown }).entries;
      if (!Array.isArray(entries)) continue;
      const before = JSON.stringify(raw);
      markMissingPaths(
        entries.filter(
          (e): e is { id: string; originalPath: string; kind?: unknown; missingPath?: true } =>
            !!e && typeof e === 'object' && typeof (e as { originalPath?: unknown }).originalPath === 'string',
        ),
        undefined,
        (e) =>
          (name === 'disabled.json' && e.kind === 'symlink') ||
          existsSync(join(deps.userDataPath, 'skills', entityDir, e.id)),
      );
      const after = JSON.stringify(raw);
      if (after !== before) fsOps.writeFileSyncAtomic(path, after);
    } catch (err) {
      safeLog(deps, 'warn', `[restore] skills 路径失效标注失败（${name}，忽略，不影响恢复）：${(err as Error).message}`);
    }
  }
}

/** S3 merge 前置：userData 项重置为包内基线（清项命名空间 → 从 incoming 重新放置；原数据已在 backup） */
function resetToPackageBaseline(deps: RestoreExecutorDeps, items: ScopeItem[]): void {
  const incoming = incomingDirOf(deps.userDataPath);
  for (const scope of items) {
    for (const rel of filesOf(scope, deps.userDataPath)) {
      rmSync(itemAbs(scope, deps.userDataPath, rel), { recursive: true, force: true });
    }
    for (const rel of filesOf(scope, incoming)) {
      const src = itemAbs(scope, incoming, rel);
      if (!existsSync(src)) continue;
      const dst = itemAbs(scope, deps.userDataPath, rel);
      mkdirSync(dirname(dst), { recursive: true });
      copyFileSync(src, dst);
    }
  }
}

function readJsonIfExists(path: string): unknown {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

/** S3 merge：backupRoot = 本地旧数据；incomingRoot = 包内 staging；settings 双源分别从 backup/incoming 读 */
function runMerge(deps: RestoreExecutorDeps): MergeReport {
  return applyMerge({
    userDataPath: deps.userDataPath,
    backupRoot: backupDirOf(deps.userDataPath),
    incomingRoot: incomingDirOf(deps.userDataPath),
    settingsLocal: (readJsonIfExists(join(backupDirOf(deps.userDataPath), 'settings.json')) ?? {}) as HullSettings,
    settingsIncoming: (readJsonIfExists(join(incomingDirOf(deps.userDataPath), 'settings.json')) ?? {}) as HullSettings,
    logger: deps.logger,
    now: () => nowOf(deps),
    uuid: () => randomUUID(),
  });
}

/** O7：step ≥ staged 优先本地 manifest 副本（包被移走/拔出仍可完成）；无副本才回退包目录 */
function loadManifest(pending: PendingFile, userDataPath: string): Manifest {
  const local = join(restoreDirOf(userDataPath), MANIFEST_FILENAME);
  const file = existsSync(local) ? local : join(pending.sourceDir, MANIFEST_FILENAME);
  if (!existsSync(file)) throw new BackupError('restore-source-missing', `备份包 manifest 缺失：${file}`);
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'));
  } catch (err) {
    throw new BackupError('restore-manifest-invalid', `manifest 解析失败：${(err as Error).message}`);
  }
  const parsed = parseManifest(raw);
  if (!parsed.ok) throw new BackupError(parsed.code, parsed.message);
  return parsed.value;
}

/** S4 verified：复校验 staged 包基线（replace/merge 同源；incoming 全程保留，守卫断言不误伤 userData 内 .restore） */
function verify(deps: RestoreExecutorDeps, manifest: Manifest): void {
  const out = validateDataFiles({
    stagedRoot: incomingDirOf(deps.userDataPath),
    manifest,
    userDataPath: deps.userDataPath,
  });
  if (!out.ok) throw new BackupError('restore-verify-failed', `恢复后复校验失败：${out.message}`);
}

function saveStep(deps: RestoreExecutorDeps, pending: PendingFile, step: RestoreStep): PendingFile {
  const next: PendingFile = { ...pending, step };
  writePending(deps.userDataPath, next);
  return next;
}

function savePhase(deps: RestoreExecutorDeps, pending: PendingFile, phase: RestorePhase): PendingFile {
  const next: PendingFile = { ...pending, phase };
  writePending(deps.userDataPath, next);
  return next;
}

// ─────────────────────────── 回滚 ───────────────────────────

/**
 * 回滚：step ≥ backedUp 才删 userData 项文件（删除集 = incoming 冻结快照，sourceDir 兜底）；随后把 backup
 * 项文件 copy 回原位。
 * N3 定版：还原用 copy（backup 不消费）→ 显式回滚步骤 1 可无条件删除包内路径（原件始终在 backup），包内独有
 * 文件一并清除，回滚后 = 恢复前状态；任意崩溃点重跑幂等（删除/覆盖均可重复）。
 * N3-1 定版：无 pending（决策表 #3：活跃 backup 残留 + 现数据缺项）→ repair-only：只补齐 userData 缺失
 * 文件，绝不删除/覆盖已有文件（旧 backup 可能与本机现数据不同代，覆盖 = 静默数据回退）。
 * 步骤 1 仅删除集为冻结快照 incoming 时执行：回退 sourceDir = 旧版/被篡改包，枚举不可信 → 不删。
 */
function doRollback(
  deps: RestoreExecutorDeps,
  pending: PendingFile | null,
  items: ScopeItem[],
  cause: BackupErrorCode | null,
  causeMessage: string,
): RestoreOutcome {
  const userDataPath = deps.userDataPath;
  const backupRoot = backupDirOf(userDataPath);
  const step = (pending?.step ?? 'backedUp') as RestoreStep;
  const mayHaveApplied = stepIndex(step) >= stepIndex('backedUp');
  const repairOnly = pending === null;
  // O6：删除集优先本轮冻结快照 incoming（包目录可能已被移动/替换，枚举它不再可信）；sourceDir 仅作 staging 来源兜底
  const incomingRoot = incomingDirOf(userDataPath);
  const pkgRootFrozen = hasAnyFile(incomingRoot);
  const pkgRoot = pkgRootFrozen
    ? incomingRoot
    : pending && existsSync(pending.sourceDir)
      ? pending.sourceDir
      : null;

  let ok = true;

  // 1) 清除本轮可能已换入的包内文件（仅显式回滚 + mayHaveApplied + 冻结快照；repair-only/未应用/回退 sourceDir 不动 userData）。
  //    N3：删除集可信时无条件删除——原件始终在 backup（步骤 2 copy 不消费），不删则回滚后残留包内独有文件 ≠ 恢复前状态。
  if (!repairOnly && mayHaveApplied && pkgRootFrozen && pkgRoot) {
    for (const scope of items) {
      for (const rel of filesOf(scope, pkgRoot)) {
        try {
          rmSync(itemAbs(scope, userDataPath, rel), { recursive: true, force: true });
        } catch (err) {
          ok = false;
          safeLog(deps, 'error', `[restore] 回滚删除失败 ${rel}：${(err as Error).message}`);
        }
      }
    }
  }

  // 2) backup → userData 还原（逐文件 copy；N3：backup 不消费 → 崩溃重跑幂等且状态完整）
  //    N3-1 repair-only：仅目标缺失才 copy（不删除、不覆盖已存在文件）
  for (const scope of items) {
    for (const rel of filesOf(scope, backupRoot)) {
      const src = itemAbs(scope, backupRoot, rel);
      const dst = itemAbs(scope, userDataPath, rel);
      if (!existsSync(src)) continue;
      if (repairOnly && existsSync(dst)) continue;
      try {
        mkdirSync(dirname(dst), { recursive: true });
        rmSync(dst, { recursive: true, force: true });
        copyFileSync(src, dst);
      } catch (err) {
        ok = false;
        safeLog(deps, 'error', `[restore] 回滚还原失败 ${rel}：${(err as Error).message}`);
      }
    }
  }

  const status: RestoreResult['status'] = ok ? 'rolledBack' : 'failed';
  const result = buildResult(
    deps,
    pending,
    status,
    ok ? null : { code: 'restore-manual-required', message: `回滚未完成：${causeMessage}` },
    null,
  );
  commitResult(deps, result);
  safeLog(
    deps,
    ok ? 'warn' : 'error',
    `[restore] 回滚结束${repairOnly ? '（repair-only：仅补齐缺失项）' : ''} status=${status}` +
      `${cause ? `（原因 ${cause}: ${causeMessage}）` : ''}`,
  );
  return status === 'rolledBack' ? { status: 'rolledBack', result } : { status: 'failed', result };
}

// ─────────────────────────── e2e 注入 ───────────────────────────

/** HULL_E2E_FAIL_AT 注入点（仅 HULL_E2E=1 生效）；':exit' → 制造崩溃窗口，缺省 → throw */
function injectFail(deps: RestoreExecutorDeps, point: string): void {
  if (process.env.HULL_E2E !== '1' || !deps.failAt) return;
  const [name, kind] = deps.failAt.split(':');
  if (name !== point) return;
  if (kind === 'exit') process.exit(86);
  throw new Error(`injected failure: ${point}`);
}
