import { test } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { launchApp, makeTempUserData, seedFakeDsh, seedSettings, shellPage, waitForReady } from './helpers';

test('screenshot notifs', async () => {
  const tmp = makeTempUserData();
  let app = null;
  try {
    seedFakeDsh(tmp.dir);
    seedSettings(tmp.dir);
    const now = Date.now();
    const iso = (o: number) => new Date(now + o).toISOString();
    const dir = join(tmp.dir, 'workflows');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'workflows.json'), JSON.stringify({ version: 1, workflows: [
      { id: 'wf-night', name: '夜间巡检', enabled: true, steps: [], createdAt: iso(-86400000), updatedAt: iso(-86400000), trigger: { type: 'cron', expr: '0 9 * * *' } },
      { id: 'wf-budget', name: 'Token 预算告警', enabled: true, steps: [], createdAt: iso(-86400000), updatedAt: iso(-86400000) },
      { id: 'wf-notify', name: '发布提醒邮件', enabled: true, steps: [], createdAt: iso(-86400000), updatedAt: iso(-86400000) },
    ] }));
    writeFileSync(join(dir, 'runs.json'), JSON.stringify({ version: 1, runs: [
      { id: 'r1', workflowId: 'wf-night', workflowName: '夜间巡检', startedAt: iso(-600000), finishedAt: iso(-590000), status: 'failed', trigger: 'cron', log: [{ stepId: 's1', type: 'http', ok: true, message: 'GET https://example.com/health → 200', durationMs: 210 }, { stepId: 's2', type: 'notification', ok: false, message: 'HTTP 503：dsh 探活失败，已重试 3 次', durationMs: 1900 }] },
      { id: 'r2', workflowId: 'wf-budget', workflowName: 'Token 预算告警', startedAt: iso(-3600000), finishedAt: iso(-3599300), status: 'success', trigger: 'cron', log: [{ stepId: 's1', type: 'token-budget', ok: true, message: 'Token 预算正常：今日用量 42 万 / 阈值 100 万', durationMs: 700 }] },
      { id: 'r3', workflowId: 'wf-notify', workflowName: '发布提醒邮件', startedAt: iso(-10800000), finishedAt: iso(-10799870), status: 'success', trigger: 'manual', log: [{ stepId: 's1', type: 'connection-action', ok: true, message: '邮件已发送至 a***@x.com', durationMs: 130 }] },
    ] }));
    app = await launchApp({ userData: tmp.dir });
    await waitForReady(app);
    const shell = shellPage(app)!;
    await shell.locator('#nav-notifs').click();
    await shell.locator('#nt-rows .nt-row').first().waitFor();
    await shell.screenshot({ path: '/tmp/notifs-page.png' });
    // 展开详情也截一张
    await shell.locator('#nt-rows .nt-row').first().click();
    await shell.waitForTimeout(200);
    await shell.screenshot({ path: '/tmp/notifs-expanded.png' });
  } finally {
    if (app) await app.close().catch(() => {});
    tmp.cleanup();
  }
});
