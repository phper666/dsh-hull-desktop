/**
 * 通知中心 e2e（V2a）：双源（工作流 + 看板执行）seed notifications.json →
 * 铃铛入口 → 页面/未读行/角标/已读 → 来源筛选 → 双跳转（工作流视图 / 看板任务详情）。
 */
import { expect, test } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  closeMainWindow,
  launchApp,
  makeTempUserData,
  seedFakeDsh,
  seedSettings,
  shellPage,
  waitForReady,
  type ElectronApplication,
} from './helpers';

/** 种子工作流定义（WorkflowStore 磁盘格式）：让「查看工作流」flash 定位有真实卡片 */
function seedWorkflows(userData: string): void {
  const dir = join(userData, 'workflows');
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'workflows.json'),
    JSON.stringify({
      version: 1,
      workflows: [
        { id: 'wf-night', name: '夜间巡检', enabled: true, steps: [], createdAt: '2026-09-03T00:00:00Z', updatedAt: '2026-09-03T00:00:00Z' },
      ],
    })
  );
}

/** 种子通知（NotificationService 磁盘格式）：工作流失败(未读)/工作流通知(已读)/看板执行失败(未读) */
function seedNotifs(userData: string): void {
  const now = Date.now();
  const iso = (offsetMs: number) => new Date(now + offsetMs).toISOString();
  const dir = join(userData, 'notifications');
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'notifications.json'),
    JSON.stringify({
      version: 1,
      notifications: [
        {
          id: 'n-wf-fail', source: 'workflow', severity: 'error', title: '工作流 · 夜间巡检【失败】',
          body: 'HTTP 503：dsh 探活失败', link: { kind: 'workflow', workflowId: 'wf-night' },
          ts: iso(-600_000), readAt: null,
          meta: { trigger: 'cron', durationMs: 2100, log: [{ stepId: 's1', type: 'http', ok: false, message: 'HTTP 503：dsh 探活失败', durationMs: 2100 }] },
        },
        {
          id: 'n-wf-ok', source: 'workflow', severity: 'info', title: '工作流 · Token 预算告警',
          body: 'token-budget: Token 预算正常', link: { kind: 'workflow', workflowId: 'wf-budget' },
          ts: iso(-3_600_000), readAt: iso(-3_590_000),
          meta: { trigger: 'cron', durationMs: 700, log: [] },
        },
        {
          id: 'n-exec-fail', source: 'board-exec', severity: 'error', title: '任务 · 数据迁移【失败】',
          body: '执行失败（selfCheck 未通过或异常退出）', link: { kind: 'task', boardId: 'b-1', taskId: 't-migrate' },
          ts: iso(-120_000), readAt: null, meta: { executionId: 'e_1', mode: 'auto' },
        },
      ],
    })
  );
}

test('E2E-08 通知中心 › 双源列表/角标/已读/来源筛选/双跳转（V2a）', async () => {
  const tmp = makeTempUserData();
  let app: ElectronApplication | null = null;
  try {
    seedFakeDsh(tmp.dir);
    seedSettings(tmp.dir);
    seedNotifs(tmp.dir);
    seedWorkflows(tmp.dir);
    app = await launchApp({ userData: tmp.dir });
    await waitForReady(app);
    const shell = shellPage(app);
    if (!shell) throw new Error('shell page 未就绪');

    // 角标：2 条未读失败（工作流 + 看板执行）
    const bell = shell.locator('#nav-notifs');
    await expect(bell).toBeVisible();
    await expect(bell.locator('#notifs-badge')).toHaveText('2');

    // 点铃铛 → 通知中心页 3 行；失败行未读态
    await bell.click();
    await expect(shell.locator('#notifs')).toBeVisible();
    const rows = shell.locator('#nt-rows .nt-row');
    await expect(rows).toHaveCount(3);
    // service 排序：未读优先 → 看板执行失败(最新未读) → 工作流失败 → 已读通知
    await expect(rows.nth(0).locator('.wf')).toHaveText('任务 · 数据迁移【失败】');
    await expect(rows.nth(0)).toHaveClass(/unread/);
    await expect(rows.nth(1).locator('.wf')).toHaveText('工作流 · 夜间巡检【失败】');
    await expect(rows.nth(1)).toHaveClass(/unread/);
    await expect(rows.nth(2).locator('.st-t')).toHaveText('通知');
    await expect(rows.nth(2)).not.toHaveClass(/unread/);
    await expect(bell.locator('#notifs-badge')).toBeHidden({ timeout: 5000 });

    // 来源筛选：看板执行 → 只剩 board-exec 行
    await shell.click('#nt-source button[data-f="board-exec"]');
    await expect(rows).toHaveCount(1);
    await expect(rows.nth(0).locator('.wf')).toHaveText('任务 · 数据迁移【失败】');

    // 看板执行行：展开详情 + 查看任务 → 看板视图 + openTask 路由（seed 的 taskId 无真实任务数据，
    // 详情弹层由 kanban 自身 data-detail 用例覆盖；此处断言路由参数正确）
    await shell.evaluate(() => {
      const orig = window.__kanbanOpenTask;
      window.__lastOpenTaskId = null;
      window.__kanbanOpenTask = (taskId: string) => {
        window.__lastOpenTaskId = taskId;
        orig(taskId);
      };
    });
    await rows.nth(0).click();
    const detail = shell.locator('#nt-rows .nt-item').nth(0).locator('.nt-detail');
    await expect(detail).toBeVisible();
    await detail.locator('.nt-goto').click();
    await expect(shell.locator('#board')).toBeVisible();
    await expect(shell.evaluate(() => window.__lastOpenTaskId)).resolves.toBe('t-migrate');

    // 回通知中心：工作流行「查看工作流」→ 工作流视图 + 卡片 flash
    await shell.locator('#nav-notifs').click();
    await shell.click('#nt-source button[data-f="workflow"]');
    const wfRows = shell.locator('#nt-rows .nt-row');
    await expect(wfRows).toHaveCount(2);
    await wfRows.nth(0).click();
    await shell.locator('#nt-rows .nt-item').nth(0).locator('.nt-goto').click();
    await expect(shell.locator('#workflows')).toBeVisible();
    await expect(shell.locator('#workflows .wf-card[data-id="wf-night"]')).toHaveClass(/flash/, { timeout: 1000 });
  } finally {
    if (app) await app.close().catch(() => {});
    tmp.cleanup();
  }
});
