/**
 * B2 看板 UI e2e（M2）：fake dsh 环境 + 种子看板数据。
 * 验证：nav-board 进入看板 → 看板视图渲染（列+卡片）→ 三视图切换 → 多项目切换。
 */
import { test, expect } from '@playwright/test';
import { join } from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';
import { makeTempUserData, seedFakeDsh, seedSettings, launchApp, sleep } from './helpers';

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

test.describe('B2 看板 UI', () => {
  test('nav-board 进入看板 → 渲染列与卡片', async () => {
    const tmp = makeTempUserData();
    seedFakeDsh(tmp.dir);
    seedSettings(tmp.dir);
    seedBoard(tmp.dir);
    const app = await launchApp({ userData: tmp.dir, fakeDshMode: 'ready' });
    const shell = await app.firstWindow();
    await expect(shell.locator('#nav-board')).toBeVisible();
    await shell.locator('#nav-board').click();
    // 看板面板显示（view 切到 placeholder:board）
    await expect(shell.locator('#board')).not.toHaveClass(/hidden/);
    await expect(shell.locator('#board-root .kb-col')).toHaveCount(3);
    await expect(shell.locator('#board-root .kb-card')).toHaveCount(2);
    await expect(shell.locator('#board-root .kb-card', { hasText: '看板任务 A' })).toBeVisible();
    await expect(shell.locator('#board-root .kb-card', { hasText: '看板任务 B' })).toBeVisible();
    await app.close();
    tmp.cleanup();
  });

  test('三视图切换：看板/列表/归档', async () => {
    const tmp = makeTempUserData();
    seedFakeDsh(tmp.dir);
    seedSettings(tmp.dir);
    seedBoard(tmp.dir);
    const app = await launchApp({ userData: tmp.dir, fakeDshMode: 'ready' });
    const shell = await app.firstWindow();
    await shell.locator('#nav-board').click();
    await expect(shell.locator('#board-root .kb-view')).toHaveCount(3);
    // 列表视图
    await shell.locator('[data-view="list"]').click();
    await expect(shell.locator('#board-root .kb-list tbody tr[data-id]')).toHaveCount(2);
    // 归档视图（空）
    await shell.locator('[data-view="archive"]').click();
    await expect(shell.locator('#board-root', { hasText: '归档区为空' })).toBeVisible();
    // 回看板视图
    await shell.locator('[data-view="board"]').click();
    await expect(shell.locator('#board-root .kb-card')).toHaveCount(2);
    await app.close();
    tmp.cleanup();
  });

  test('多项目看板切换', async () => {
    const tmp = makeTempUserData();
    seedFakeDsh(tmp.dir);
    seedSettings(tmp.dir);
    seedBoard(tmp.dir);
    const app = await launchApp({ userData: tmp.dir, fakeDshMode: 'ready' });
    const shell = await app.firstWindow();
    await shell.locator('#nav-board').click();
    await expect(shell.locator('#kb-board-select option')).toHaveCount(2);
    // 切到 Beta（有看板无任务 → 空列态）
    await shell.locator('#kb-board-select').selectOption('b_beta');
    await expect(shell.locator('#board-root .kb-empty-col').first()).toBeVisible();
    await app.close();
    tmp.cleanup();
  });
});
