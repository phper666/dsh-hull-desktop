/**
 * 通知中心 e2e（§9 V1 首例）：seed 工作流运行记录 → 铃铛入口 → 页面/表格/角标/已读语义。
 * 数据经 <userData>/workflows/runs.json（WorkflowStore 磁盘格式）注入，不触真实用户数据。
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

/** 种子运行记录：1 条未读失败（时间 = 现在）+ 1 条已读成功（昨天）+ 1 条定时成功（刚才） */
function seedRuns(userData: string): void {
  const now = Date.now();
  const iso = (offsetMs: number) => new Date(now + offsetMs).toISOString();
  const dir = join(userData, 'workflows');
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'workflows.json'),
    JSON.stringify({
      version: 1,
      workflows: [
        { id: 'wf-night', name: '夜间巡检', enabled: true, steps: [], createdAt: iso(-86400_000), updatedAt: iso(-86400_000), trigger: { type: 'cron', expr: '0 9 * * *' } },
        { id: 'wf-budget', name: 'Token 预算告警', enabled: true, steps: [], createdAt: iso(-86400_000), updatedAt: iso(-86400_000) },
      ],
    })
  );
  writeFileSync(
    join(dir, 'runs.json'),
    JSON.stringify({
      version: 1,
      runs: [
        {
          id: 'run-fail', workflowId: 'wf-night', workflowName: '夜间巡检', startedAt: iso(-600_000),
          finishedAt: iso(-590_000), status: 'failed', trigger: 'cron',
          log: [{ stepId: 's1', type: 'http', ok: false, message: 'HTTP 503：dsh 探活失败', durationMs: 2100 }],
        },
        {
          id: 'run-ok', workflowId: 'wf-night', workflowName: '夜间巡检', startedAt: iso(-86_400_000),
          finishedAt: iso(-86_340_000), status: 'success', trigger: 'cron',
          log: [{ stepId: 's1', type: 'http', ok: true, message: '巡检完成', durationMs: 6200 }],
        },
        {
          id: 'run-budget', workflowId: 'wf-budget', workflowName: 'Token 预算告警', startedAt: iso(-120_000),
          finishedAt: iso(-119_000), status: 'success', trigger: 'manual',
          log: [{ stepId: 's1', type: 'token-budget', ok: true, message: 'Token 预算正常', durationMs: 700 }],
        },
      ],
    })
  );
}

test('E2E-08 通知中心 › 铃铛入口 → 页面/未读行/角标/标记已读（§9 V1）', async () => {
  const tmp = makeTempUserData();
  let app: ElectronApplication | null = null;
  try {
    seedFakeDsh(tmp.dir);
    seedSettings(tmp.dir);
    seedRuns(tmp.dir);
    app = await launchApp({ userData: tmp.dir });
    await waitForReady(app);
    const shell = shellPage(app);
    if (!shell) throw new Error('shell page 未就绪');

    // 铃铛角标：1 条未读失败（run-fail；run-ok/run-budget 已读或成功）
    const bell = shell.locator('#nav-notifs');
    await expect(bell).toBeVisible();
    await expect(bell.locator('#notifs-badge')).toHaveText('1');

    // 点铃铛 → 切 notifs 视图 + 页面渲染
    await bell.click();
    await expect(shell.locator('#notifs')).toBeVisible();
    const rows = shell.locator('#nt-rows .nt-row');
    await expect(rows).toHaveCount(3);
    // 失败行未读态（红条 + 消息红显）排最前（runs 倒序）
    await expect(rows.nth(0)).toHaveClass(/unread/);
    await expect(rows.nth(0).locator('.msg')).toHaveText('HTTP 503：dsh 探活失败');
    await expect(rows.nth(0).locator('.badge.failed')).toHaveText('失败');

    // 进页面即已读：角标清零
    await expect(bell.locator('#notifs-badge')).toBeHidden();

    // 搜索实时过滤
    await shell.fill('#nt-search', 'Token');
    await expect(rows).toHaveCount(1);
    await expect(rows.nth(0).locator('.wf')).toHaveText('Token 预算告警');
    await shell.fill('#nt-search', '');

    // 状态筛选：失败
    await shell.click('#nt-status button[data-f="failed"]');
    await expect(rows).toHaveCount(1);

    // §9.5：行点击 = 原地展开详情（步骤日志/起止时间），再点收起
    await shell.click('#nt-status button[data-f="all"]');
    await rows.nth(1).click();
    const detail = shell.locator('#nt-rows .nt-item').nth(1).locator('.nt-detail');
    await expect(detail).toBeVisible();
    await expect(detail.locator('.nt-step')).toContainText('巡检完成');
    await expect(detail.locator('.nt-meta-line')).toContainText('定时（cron）');
    await rows.nth(1).click();
    await expect(detail).toBeHidden();

    // §9.5：详情内「查看工作流」→ 跳工作流视图 + 卡片 flash 定位 + 全局最近运行段已移除
    await rows.nth(1).click();
    await detail.locator('.nt-goto').click();
    await expect(shell.locator('#workflows')).toBeVisible();
    await expect(shell.locator('#notifs')).toBeHidden();
    await expect(shell.locator('.wf-runs')).toHaveCount(0);
    await expect(shell.locator('#workflows .wf-card[data-id="wf-night"]')).toHaveClass(/flash/, { timeout: 1000 });
  } finally {
    if (app) await app.close().catch(() => {});
    tmp.cleanup();
  }
});
