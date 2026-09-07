/**
 * README 截图采集（手动触发，不进常规 e2e 套件）：
 *   CAPTURE_SCREENSHOTS=1 npx playwright test tests/e2e/capture-screenshots.spec.ts
 * 产出 docs/screenshots/{official,board,settings}.png（主窗口 capturePage，含 WebContentsView 合成）。
 */
import { test, expect } from '@playwright/test';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  makeTempUserData,
  seedFakeDsh,
  seedSettings,
  launchApp,
  waitForReady,
  PROJECT_ROOT,
} from './helpers';

function seedBoard(userData: string): void {
  const kanbanDir = join(userData, 'kanban');
  mkdirSync(kanbanDir, { recursive: true });
  const now = new Date().toISOString();
  const data = {
    version: 1,
    boards: [
      {
        id: 'b_alpha',
        name: 'Alpha',
        order: 0,
        createdAt: now,
        updatedAt: now,
        columns: [
          { id: 'c_backlog', type: 'backlog', name: 'Backlog', order: 0, color: '#8b949e', hidden: false },
          { id: 'c_todo', type: 'todo', name: 'Todo', order: 1, color: '#58a6ff', hidden: false },
          { id: 'c_done', type: 'done', name: 'Done', order: 2, color: '#3fb950', hidden: false },
        ],
        tasks: [
          {
            id: 't_1', parentId: null, columnId: 'c_backlog', title: '看板任务 A', executionMode: 'manual',
            executionStatus: 'idle', currentExecutionId: null, acceptanceCriteria: null,
            agentSpec: { provider: 'dsh', agent: null, model: null, subagentPolicy: 'auto' },
            dependencies: [], description: '示例描述', labels: ['frontend'], priority: 'P1', assignee: null,
            dueDate: null, order: 0, blockedFromColumnId: null, archivedAt: null, archivedFromColumnId: null,
            createdAt: now, updatedAt: now, timeline: [],
          },
          {
            id: 't_2', parentId: null, columnId: 'c_todo', title: '看板任务 B', executionMode: 'manual',
            executionStatus: 'idle', currentExecutionId: null, acceptanceCriteria: null,
            agentSpec: { provider: 'dsh', agent: null, model: null, subagentPolicy: 'auto' },
            dependencies: [], description: null, labels: [], priority: 'P2', assignee: null,
            dueDate: null, order: 0, blockedFromColumnId: null, archivedAt: null, archivedFromColumnId: null,
            createdAt: now, updatedAt: now, timeline: [],
          },
        ],
      },
      {
        id: 'b_beta',
        name: 'Beta',
        order: 1,
        createdAt: now,
        updatedAt: now,
        columns: [
          { id: 'c_backlog', type: 'backlog', name: 'Backlog', order: 0, color: '#8b949e', hidden: false },
          { id: 'c_todo', type: 'todo', name: 'Todo', order: 1, color: '#58a6ff', hidden: false },
        ],
        tasks: [],
      },
    ],
  };
  writeFileSync(join(kanbanDir, 'boards.json'), JSON.stringify(data, null, 2));
}

test.skip(!process.env.CAPTURE_SCREENSHOTS, '截图采集仅 CAPTURE_SCREENSHOTS=1 时运行');

test('capture README screenshots', async () => {
  test.setTimeout(120_000);
  const tmp = makeTempUserData();
  seedFakeDsh(tmp.dir);
  seedSettings(tmp.dir);
  seedBoard(tmp.dir);
  const app = await launchApp({ userData: tmp.dir, fakeDshMode: 'ready' });
  try {
    const shell = await waitForReady(app, 30_000);
    await expect(shell.locator('#nav')).toBeVisible();

    const capture = (): Promise<Buffer> =>
      app.evaluate(({ BrowserWindow }) =>
        (async () => {
          const win = BrowserWindow.getAllWindows()[0];
          const img = await win.webContents.capturePage();
          return img.toPNG().toString('base64');
        })()
      ).then((b64) => Buffer.from(b64, 'base64'));

    const outDir = join(PROJECT_ROOT, 'docs', 'screenshots');
    mkdirSync(outDir, { recursive: true });

    // Skills 检查器
    await shell.locator('#nav-skills').click();
    await shell.waitForTimeout(1500);
    writeFileSync(join(outDir, 'skills.png'), await capture());

    // Token 消耗视图
    await shell.locator('#nav-tokens').click();
    await shell.waitForTimeout(1200);
    writeFileSync(join(outDir, 'tokens.png'), await capture());

    // 设置
    await shell.locator('#nav-settings').click();
    await shell.waitForTimeout(800);
    writeFileSync(join(outDir, 'settings.png'), await capture());
  } finally {
    await app.close();
    tmp.cleanup();
  }
});
