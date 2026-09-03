/**
 * 看板真实场景测试发现的 4 个 bug 回归 e2e（2026-09-03，场景测试报告）：
 * - BUG-1：「＋新建列」误走 updateColumn(null) 必报「列不存在」→ createColumn 原语全生命周期
 * - BUG-2：Verify 卡「✓ 确认完成」后 UI 不刷新（数据已落 Done）→ 确认后立即出现在 Done
 * - BUG-3：moveTask 进 Blocked 漏改 columnId，卡片永远进不了 Blocked 列 → 落入 + 拖出回来源列
 * - BUG-4：壳页 partition 'shell' 非持久，localStorage 视图记忆（Q-053）跨重启丢失 → persist:shell
 */
import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { join } from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';
import { makeTempUserData, seedFakeDsh, seedSettings, launchApp, sleep } from './helpers';

/** 6 模板列全量种子：t_work（Todo, idle）测 Blocked 拖拽；t_vfy（Verify, succeeded）测 ✓ 把关 */
function seedBoard(userData: string): void {
  const kanbanDir = join(userData, 'kanban');
  mkdirSync(kanbanDir, { recursive: true });
  const now = new Date().toISOString();
  const task = (id: string, columnId: string, extra: Record<string, unknown> = {}) => ({
    id, parentId: null, columnId, title: `任务${id}`, executionMode: 'manual', executionStatus: 'idle',
    currentExecutionId: null, acceptanceCriteria: null,
    agentSpec: { provider: 'dsh', agent: null, model: null, subagentPolicy: 'auto' },
    dependencies: [], description: null, labels: [], priority: 'P2', assignee: null,
    dueDate: null, startDate: null, order: 0, blockedFromColumnId: null, archivedAt: null, archivedFromColumnId: null,
    createdAt: now, updatedAt: now, timeline: [], ...extra,
  });
  writeFileSync(join(kanbanDir, 'boards.json'), JSON.stringify({
    version: 2,
    boards: [{
      id: 'b_main', name: '主看板', order: 0, createdAt: now, updatedAt: now,
      columns: [
        { id: 'c_backlog', type: 'backlog', name: 'Backlog', order: 0, color: '#8b949e', hidden: false },
        { id: 'c_todo', type: 'todo', name: 'Todo', order: 1, color: '#58a6ff', hidden: false },
        { id: 'c_in_progress', type: 'in_progress', name: 'In Progress', order: 2, color: '#d29922', hidden: false },
        { id: 'c_verify', type: 'verify', name: 'Verify', order: 3, color: '#a371f7', hidden: false },
        { id: 'c_done', type: 'done', name: 'Done', order: 4, color: '#3fb950', hidden: false },
        { id: 'c_blocked', type: 'blocked', name: 'Blocked', order: 5, color: '#f85149', hidden: false },
      ],
      tasks: [task('t_work', 'c_todo'), task('t_vfy', 'c_verify', { executionStatus: 'succeeded' })],
    }],
  }, null, 2));
}

async function openBoard() {
  const tmp = makeTempUserData();
  seedFakeDsh(tmp.dir);
  seedSettings(tmp.dir);
  seedBoard(tmp.dir);
  const app = await launchApp({ userData: tmp.dir, fakeDshMode: 'ready' });
  const shell = await app.firstWindow();
  await shell.locator('#nav-board').click();
  await expect(shell.locator('.kb-cols')).toBeVisible();
  return { tmp, app, shell };
}

/** HTML5 DnD：真实 handler 监听 dragstart/dragover/drop，Playwright 原生拖拽不触发，走 DOM 事件派发 */
async function dragCard(shell: Page, taskId: string, toColId: string): Promise<void> {
  await shell.evaluate(([tid, cid]) => {
    const card = document.querySelector(`.kb-card[data-id="${tid}"]`);
    const col = document.querySelector(`.kb-col[data-col="${cid}"]`);
    if (!card || !col) throw new Error(`drag target missing: ${tid} → ${cid}`);
    const dt = new DataTransfer();
    card.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: dt }));
    col.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt }));
    col.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }));
    card.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer: dt }));
  }, [taskId, toColId]);
  await sleep(400);
}
const cardIn = (shell: Page, colId: string, taskId: string) =>
  shell.locator(`.kb-col[data-col="${colId}"] .kb-card[data-id="${taskId}"]`);

test.describe('BUG-1 新建列', () => {
  test('列管理→新建列→列出现；列内卡片随删列迁移 Todo（全生命周期）', async () => {
    const { tmp, app, shell } = await openBoard();
    // 新建列
    await shell.locator('.kb-col-head [data-act="col-mgr"]').first().click();
    await expect(shell.locator('.kb-modal .kb-cols-mgr')).toBeVisible();
    await shell.locator('.kb-modal [data-newcol]').click();
    await shell.locator('#kb-cname').fill('待评审');
    await shell.locator('.kb-modal [data-ok]').click();
    await expect(shell.locator('.kb-col:has(.kb-col-name:text-is("待评审"))')).toBeVisible();
    expect(await shell.locator('.kb-col').count()).toBe(7, '6 模板列 + 1 新建');
    // 新列加卡
    const newColId = await shell.locator('.kb-col:has(.kb-col-name:text-is("待评审"))').getAttribute('data-col') as string;
    await shell.locator(`.kb-add-card[data-col="${newColId}"]`).click();
    await shell.locator('#kb-tt').fill('迁移演练卡');
    await shell.locator('.kb-modal [data-ok]').click();
    await expect(shell.locator('.kb-card:has-text("迁移演练卡")')).toBeVisible();
    // 删列（confirm）→ 卡片迁 Todo
    shell.on('dialog', (d) => void d.accept());
    await shell.locator('.kb-col-head [data-act="col-mgr"]').first().click();
    await expect(shell.locator('.kb-modal .kb-cols-mgr')).toBeVisible();
    await shell.locator('.kb-modal [data-delcol]').first().click();
    await expect(shell.locator(`.kb-col[data-col="${newColId}"]`)).toHaveCount(0);
    expect(await cardIn(shell, 'c_todo', await shell.locator('.kb-card:has-text("迁移演练卡")').getAttribute('data-id') as string).count()).toBe(1);
    await app.close();
    tmp.cleanup();
  });
});

test.describe('BUG-3 Blocked 拖入', () => {
  test('拖卡进 Blocked 落入 Blocked 列；拖出回来源列（落点忽略，P2-4 设计）', async () => {
    const { tmp, app, shell } = await openBoard();
    await dragCard(shell, 't_work', 'c_blocked');
    await expect(cardIn(shell, 'c_blocked', 't_work')).toBeVisible();
    // 拖出：按设计回来源列 Todo（拖到 In Progress 落点被忽略）
    await dragCard(shell, 't_work', 'c_in_progress');
    await expect(cardIn(shell, 'c_todo', 't_work')).toBeVisible();
    await expect(cardIn(shell, 'c_in_progress', 't_work')).toHaveCount(0);
    await app.close();
    tmp.cleanup();
  });
});

test.describe('BUG-2 ✓ 确认完成', () => {
  test('Verify 列 succeeded 卡点 ✓ → 立即出现在 Done（无需切视图/重进）', async () => {
    const { tmp, app, shell } = await openBoard();
    await expect(cardIn(shell, 'c_verify', 't_vfy')).toBeVisible();
    await shell.locator('[data-verify="t_vfy"]').click();
    await expect(cardIn(shell, 'c_done', 't_vfy')).toBeVisible();
    await expect(cardIn(shell, 'c_verify', 't_vfy')).toHaveCount(0);
    await expect(shell.locator('[data-verify="t_vfy"]')).toHaveCount(0, '✓ 按钮随重渲染消失');
    await app.close();
    tmp.cleanup();
  });
});

test.describe('BUG-4 视图记忆跨重启', () => {
  test('切日历 → 重启（同 userData）→ 仍日历（persist:shell localStorage）', async () => {
    const tmp = makeTempUserData();
    seedFakeDsh(tmp.dir);
    seedSettings(tmp.dir);
    seedBoard(tmp.dir);
    const app1 = await launchApp({ userData: tmp.dir, fakeDshMode: 'ready' });
    const shell1 = await app1.firstWindow();
    await shell1.locator('#nav-board').click();
    await expect(shell1.locator('.kb-cols')).toBeVisible();
    await shell1.locator('[data-view="calendar"]').click();
    await expect(shell1.locator('.kb-cal-grid')).toBeVisible();
    await app1.close();
    // 同 userData 重启
    const app2 = await launchApp({ userData: tmp.dir, fakeDshMode: 'ready' });
    const shell2 = await app2.firstWindow();
    await shell2.locator('#nav-board').click();
    await expect(shell2.locator('.kb-cal-grid')).toBeVisible({ message: '重启后视图记忆应恢复日历' });
    await app2.close();
    tmp.cleanup();
  });
});
