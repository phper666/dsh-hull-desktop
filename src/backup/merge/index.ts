/**
 * B3 merge 引擎编排（设计 §4 / §2.3 S3）：
 * 启动期执行器先 reset userData 项为确定基线，再逐类合并；本函数按类分发，
 * **任一类抛错 → 整体失败（异常上抛，由执行器回滚）**，不做局部吞错。
 * 写盘：settings/workflows/notifications/dismiss 由本文件原子写；notes/skills/kanban 由各自模块落盘。
 *
 * 方向约定（与设计 §4.1/4.2 各调用边界一致）：userData 当前 = 包内基线，backupRoot = 本地旧数据，
 * incomingRoot = 包内 staging（notes 冲突判定 / skills 实体兜底用）。
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { HullSettings } from '../../settings/SettingsProvider';
import { createNodeFsOps } from '../../skills/SkillFsOps';
import type { RuntimeLogger } from '../../shared/types';
import { emptyReport, mergeReports, type MergeReport } from './conflicts';
import { mergeKanban } from './kanban';
import { mergeDismiss, mergeNotifications } from './notifications';
import { mergeNotes } from './notes';
import { mergeSettings } from './settings';
import { mergeSkillsState } from './skills';
import { mergeWorkflows } from './workflows';

export interface MergeContext {
  userDataPath: string;
  /** 预备份根：本地旧数据（.restore/backup） */
  backupRoot: string;
  /** 已 staging 的包内容根（.restore/incoming） */
  incomingRoot: string;
  settingsLocal: HullSettings;
  settingsIncoming: HullSettings;
  logger: RuntimeLogger;
  now(): Date;
  uuid(): string;
}

const fsOps = createNodeFsOps();

/** 缺失 → null；存在但解析失败 → 抛（本地/包内数据损坏宁可整体失败回滚） */
function readJsonIfExists(path: string): unknown {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    throw new Error(`JSON 解析失败（${path}）: ${(err as Error).message}`);
  }
}

function countWorkflowDefs(raw: unknown): number {
  const list = (raw && typeof raw === 'object' ? (raw as { workflows?: unknown }).workflows : undefined);
  return Array.isArray(list) ? list.length : 0;
}

function countNotifRows(raw: unknown): number {
  const list = (raw && typeof raw === 'object' ? (raw as { notifications?: unknown }).notifications : undefined);
  return Array.isArray(list) ? list.length : 0;
}

function countChangedSettingsKeys(value: HullSettings, local: HullSettings): number {
  let n = 0;
  for (const key of Object.keys(value) as Array<keyof HullSettings>) {
    if (key === 'schemaVersion') continue; // 恒写当前版本，不算变更
    if (JSON.stringify(value[key]) !== JSON.stringify(local[key])) n++;
  }
  return n;
}

export function applyMerge(ctx: MergeContext): MergeReport {
  const reports: MergeReport[] = [];

  // 1) 看板：包内基线已在 userData/kanban/boards.json（执行器换入），导入本地旧数据
  reports.push(
    mergeKanban({
      userDataPath: ctx.userDataPath,
      backupBoardsPath: join(ctx.backupRoot, 'kanban', 'boards.json'),
      logger: ctx.logger,
    }).report,
  );

  // 2) 笔记（文件级 + 回收站；自身落盘）
  reports.push(
    mergeNotes({
      userDataPath: ctx.userDataPath,
      backupNotesRoot: join(ctx.backupRoot, 'notes'),
      incomingNotesRoot: join(ctx.incomingRoot, 'notes'),
      now: ctx.now,
    }).report,
  );

  // 3) 设置：字段级合并 → 原子写 settings.json
  const settings = mergeSettings(ctx.settingsLocal, ctx.settingsIncoming, {
    userDataPath: ctx.userDataPath,
    exists: existsSync,
  });
  fsOps.writeFileSyncAtomic(join(ctx.userDataPath, 'settings.json'), JSON.stringify(settings.value));
  const settingsReport = emptyReport();
  settingsReport.classes.setting.updated = countChangedSettingsKeys(settings.value, ctx.settingsLocal);
  settingsReport.classes.setting.skipped = settings.conflicts.filter((c) => c.resolution === 'kept-local').length;
  settingsReport.conflicts.push(...settings.conflicts);
  settingsReport.notices.push(...settings.notices);
  reports.push(settingsReport);

  // 4) 工作流：包内为基底，本地逐条追加（id 冲突重 id）→ 原子写
  const incomingWorkflows = readJsonIfExists(join(ctx.userDataPath, 'workflows', 'workflows.json'));
  const localWorkflows = readJsonIfExists(join(ctx.backupRoot, 'workflows', 'workflows.json'));
  if (incomingWorkflows !== null || localWorkflows !== null) {
    const merged = mergeWorkflows(localWorkflows, incomingWorkflows, { uuid: ctx.uuid });
    fsOps.writeFileSyncAtomic(join(ctx.userDataPath, 'workflows', 'workflows.json'), JSON.stringify(merged.value));
    const workflowReport = emptyReport();
    workflowReport.classes.workflow.added = Math.max(0, merged.value.workflows.length - countWorkflowDefs(incomingWorkflows));
    workflowReport.classes.workflow.skipped = merged.conflicts.filter((c) => c.resolution === 'skipped-identical').length;
    workflowReport.conflicts.push(...merged.conflicts);
    reports.push(workflowReport);
  }

  // 5) 通知（包内基底 + 本地去重追加 + ring cap）与 dismiss（逐通道取新）
  const incomingNotifs = readJsonIfExists(join(ctx.userDataPath, 'notifications', 'notifications.json'));
  const localNotifs = readJsonIfExists(join(ctx.backupRoot, 'notifications', 'notifications.json'));
  if (incomingNotifs !== null || localNotifs !== null) {
    const merged = mergeNotifications(localNotifs, incomingNotifs);
    fsOps.writeFileSyncAtomic(join(ctx.userDataPath, 'notifications', 'notifications.json'), JSON.stringify(merged.value));
    const notifReport = emptyReport();
    notifReport.classes.notif.added = Math.max(0, merged.value.notifications.length - countNotifRows(incomingNotifs));
    notifReport.classes.notif.skipped = merged.conflicts.filter((c) => c.resolution === 'skipped-identical').length;
    notifReport.conflicts.push(...merged.conflicts);
    reports.push(notifReport);
  }
  const dismiss = mergeDismiss(
    readJsonIfExists(join(ctx.backupRoot, 'dismiss.json')),
    readJsonIfExists(join(ctx.userDataPath, 'dismiss.json')),
  );
  if (Object.keys(dismiss).length > 0) {
    fsOps.writeFileSyncAtomic(join(ctx.userDataPath, 'dismiss.json'), JSON.stringify(dismiss));
  }

  // 6) skills 索引并集 + 实体拷贝 + missingPath 标注（自身落盘）
  const skills = mergeSkillsState({
    userDataPath: ctx.userDataPath,
    backupSkillsRoot: join(ctx.backupRoot, 'skills'),
    incomingSkillsRoot: join(ctx.incomingRoot, 'skills'),
  });
  reports.push(skills.report);

  return mergeReports(...reports);
}
