/**
 * U3 依赖图可视化 e2e（docs/design/U3-依赖图可视化-kanban-depgraph-design.md §六/§八）：
 * 详情摘要入口条可见 + 独立弹框可开/ESC 可关 + 无子任务卡不显示入口条。
 * 种子直写 boards.json（同 kanban.spec 机制）；dependencies 仅同父兄弟合法（store Q-014）。
 */
import { test, expect } from '@playwright/test';
import { join } from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';
import { makeTempUserData, seedFakeDsh, seedSettings, launchApp } from './helpers';

/** 种子：父卡 + 4 子任务（t_s2→t_s1、t_s4→t_s3 两条依赖链）+ 1 无子任务普通卡 */
function seedDepgraphBoard(userData: string): void {
  const kanbanDir = join(userData, 'kanban');
  mkdirSync(kanbanDir, { recursive: true });
  const now = new Date().toISOString();
  const task = (id: string, extra: Record<string, unknown> = {}) => ({
    id, parentId: null, columnId: 'c_todo', title: `任务${id}`, executionMode: 'manual',
    executionStatus: 'idle', currentExecutionId: null, acceptanceCriteria: null,
    agentSpec: { provider: 'dsh', agent: null, model: null, subagentPolicy: 'auto' },
    dependencies: [], description: null, labels: [], priority: 'P2', assignee: null,
    dueDate: null, startDate: null, order: 0, blockedFromColumnId: null, archivedAt: null, archivedFromColumnId: null,
    createdAt: now, updatedAt: now, timeline: [], ...extra,
  });
  const data = {
    version: 2,
    boards: [
      {
        id: 'b_dg', name: '依赖板', order: 0, createdAt: now, updatedAt: now,
        columns: [{ id: 'c_todo', type: 'todo', name: 'Todo', order: 0, color: '#58a6ff', hidden: false }],
        tasks: [
          task('t_parent', { title: '父任务' }),
          task('t_s1', { parentId: 't_parent', title: '子任务一' }),
          task('t_s2', { parentId: 't_parent', title: '子任务二', dependencies: ['t_s1'] }),
          task('t_s3', { parentId: 't_parent', title: '子任务三' }),
          task('t_s4', { parentId: 't_parent', title: '子任务四', dependencies: ['t_s3'] }),
          task('t_plain', { title: '普通任务' }),
        ],
      },
    ],
  };
  writeFileSync(join(kanbanDir, 'boards.json'), JSON.stringify(data, null, 2));
}

test.describe('U3 依赖图可视化', () => {
  test('详情摘要入口条可见 + 独立弹框（节点≥4/ESC 关闭）+ 无子任务卡不显示', async () => {
    const tmp = makeTempUserData();
    seedFakeDsh(tmp.dir);
    seedSettings(tmp.dir);
    seedDepgraphBoard(tmp.dir);
    const app = await launchApp({ userData: tmp.dir, fakeDshMode: 'ready' });
    const shell = await app.firstWindow();
    await shell.locator('#nav-board').click();
    await expect(shell.locator('#board-root .kb-card')).toHaveCount(6);

    // ① 父卡详情 → 详情内子任务列表仍在（4 行）+ 摘要入口条可见（依赖图文案 + 计数：两条依赖边）
    await shell.locator('.kb-card', { hasText: '父任务' }).click();
    await expect(shell.locator('.kb-modal .kb-sub-item')).toHaveCount(4);
    const entry = shell.locator('.kb-modal .dg-entry');
    await expect(entry).toBeVisible();
    await expect(entry.locator('.dg-et')).toHaveText('依赖图');
    await expect(entry.locator('.dg-sum')).toContainText('2 依赖');

    // ② 点「查看依赖图」→ 独立弹框 + 内联 SVG + 节点 ≥4 + 左栏子任务列表 4 行 + ESC 可关闭
    await entry.click();
    await expect(shell.locator('.dg-modal')).toBeVisible();
    await expect(shell.locator('.dg-modal svg.dg-svg')).toBeVisible();
    const nodes = shell.locator('.dg-modal .dg-node');
    expect(await nodes.count()).toBeGreaterThanOrEqual(4);
    await expect(shell.locator('.dg-modal .dg-edge')).not.toHaveCount(0);
    await expect(shell.locator('.dg-modal .dg-li')).toHaveCount(4); // 左栏子任务列表
    await expect(shell.locator('.dg-modal .dg-li', { hasText: '子任务一' })).toBeVisible();
    await shell.keyboard.press('Escape');
    await expect(shell.locator('.dg-modal')).toHaveCount(0);

    // ③ 无子任务普通卡详情不显示摘要条
    await shell.locator('.kb-card', { hasText: '普通任务' }).click();
    await expect(shell.locator('.kb-modal')).toBeVisible();
    await expect(shell.locator('.kb-modal .dg-entry')).toHaveCount(0);

    await app.close();
    tmp.cleanup();
  });
});
