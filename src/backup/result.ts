/**
 * B2 `.restore/` 数据结构 + 原子读写（设计 §1.6 / §6.2~§6.4）。
 *   pending.json  运行期写（requested 步），收尾/取消删
 *   result.json   启动期写（收尾），下次恢复覆盖
 * 写：temp+rename 原子（同 SkillFsOps.writeFileSyncAtomic 模式），失败上抛（由调用方转 BackupError）；
 * 读：缺失/损坏/结构非法 → null（不 throw；main 的 hasPendingRestore 依赖 null=无标记语义）。
 * ResultNotice 唯一定义处（merge/conflicts.ts 从此处 import 再导出，避免循环依赖；本文件不得依赖 merge/*）。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import type { ScopeItemId } from './scope';

/** 恢复模式（契约 §枚举与状态） */
export type RestoreMode = 'replace' | 'merge';
/** 正向 / 回滚中（自愈判定关键位） */
export type RestorePhase = 'forward' | 'rolling-back';
/** 最后完成步（启动期状态机） */
export type RestoreStep = 'requested' | 'staged' | 'backedUp' | 'applied' | 'verified';
/** 恢复结果态（UI 可见） */
export type RestoreStatus = 'success' | 'rolledBack' | 'failed';

/** 用户可见提示（code/message；唯一定义处，merge/conflicts 再导出） */
export interface ResultNotice {
  code: string;
  message: string;
}

/** `<userData>/.restore/pending.json`（契约 §PendingFile 字段表） */
export interface PendingFile {
  version: 1;
  mode: RestoreMode;
  phase: RestorePhase;
  step: RestoreStep;
  /** 备份包根绝对路径 */
  sourceDir: string;
  /** 本次涉及的项（≥1） */
  items: ScopeItemId[];
  /** ISO8601 */
  createdAt: string;
  /** e2e 注入点（生产恒 null） */
  failAt: string | null;
}

/**
 * merge 报告的结构镜像：与 merge/conflicts.MergeReport 结构等价且可直接赋值，
 * 但本文件不 import merge/*（依赖方向单向：merge → result；conflicts.ts 有编译期断言防漂移）。
 */
export interface RestoreMergeReport {
  classes: Record<string, { added: number; updated: number; skipped: number }>;
  conflicts: Array<{ kind: string; path?: string; id?: string; resolution: string; detail?: string }>;
  notices: ResultNotice[];
}

/** `<userData>/.restore/result.json`（契约 §RestoreResult 字段表） */
export interface RestoreResult {
  version: 1;
  mode: RestoreMode;
  status: RestoreStatus;
  /** ISO8601 */
  finishedAt: string;
  /** `.restore/backup` 绝对路径（人工兜底入口）；未产生 → null */
  bakDir: string | null;
  /** 如 notes-dir-fallback */
  notices: ResultNotice[];
  /** merge 模式填，replace 为 null */
  merge: RestoreMergeReport | null;
  /** failed 时填 */
  error: ResultNotice | null;
}

/** `.restore/` 目录名（§6.4） */
export const RESTORE_DIRNAME = '.restore';
export const PENDING_FILENAME = 'pending.json';
export const RESULT_FILENAME = 'result.json';

/** `<userData>/.restore` 绝对路径 */
export function restoreDirPath(userDataPath: string): string {
  return join(userDataPath, RESTORE_DIRNAME);
}

/** 待恢复标记；不存在/损坏/结构非法 → null（损坏标记不得触发启动期恢复） */
export function readPending(userDataPath: string): PendingFile | null {
  const raw = readJson(join(restoreDirPath(userDataPath), PENDING_FILENAME));
  return isPendingFile(raw) ? raw : null;
}

/** 原子写 pending.json（父目录自动创建；IO 失败上抛，调用方转 io-error） */
export function writePending(userDataPath: string, pending: PendingFile): void {
  atomicWrite(join(restoreDirPath(userDataPath), PENDING_FILENAME), pending);
}

/** 删 pending.json（幂等：缺失不报错） */
export function clearPending(userDataPath: string): void {
  rmSync(join(restoreDirPath(userDataPath), PENDING_FILENAME), { force: true });
}

/** 最近一次恢复结果；不存在/损坏/结构非法 → null */
export function readResult(userDataPath: string): RestoreResult | null {
  const raw = readJson(join(restoreDirPath(userDataPath), RESULT_FILENAME));
  return isRestoreResult(raw) ? raw : null;
}

/** 原子写 result.json（覆盖写；先 result 后 clearPending，崩溃点重跑安全） */
export function writeResult(userDataPath: string, result: RestoreResult): void {
  atomicWrite(join(restoreDirPath(userDataPath), RESULT_FILENAME), result);
}

// ── 内部 ──

function readJson(filePath: string): unknown {
  if (!existsSync(filePath)) return null;
  try {
    return JSON.parse(readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

/** temp+rename 原子写（同 SkillFsOps.writeFileSyncAtomic 模式；JSON 单行） */
function atomicWrite(filePath: string, data: unknown): void {
  mkdirSync(dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, JSON.stringify(data), 'utf8');
  renameSync(tmp, filePath);
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

const MODES: readonly string[] = ['replace', 'merge'];
const PHASES: readonly string[] = ['forward', 'rolling-back'];
const STEPS: readonly string[] = ['requested', 'staged', 'backedUp', 'applied', 'verified'];
const STATUSES: readonly string[] = ['success', 'rolledBack', 'failed'];

function isPendingFile(v: unknown): v is PendingFile {
  if (!isRecord(v)) return false;
  return (
    v.version === 1 &&
    MODES.includes(v.mode as string) &&
    PHASES.includes(v.phase as string) &&
    STEPS.includes(v.step as string) &&
    typeof v.sourceDir === 'string' &&
    v.sourceDir !== '' &&
    Array.isArray(v.items) &&
    typeof v.createdAt === 'string' &&
    (v.failAt === null || typeof v.failAt === 'string')
  );
}

function isRestoreResult(v: unknown): v is RestoreResult {
  if (!isRecord(v)) return false;
  return (
    v.version === 1 &&
    MODES.includes(v.mode as string) &&
    STATUSES.includes(v.status as string) &&
    typeof v.finishedAt === 'string' &&
    (v.bakDir === null || typeof v.bakDir === 'string') &&
    Array.isArray(v.notices) &&
    (v.merge === null || isRecord(v.merge)) &&
    (v.error === null || isRecord(v.error))
  );
}
