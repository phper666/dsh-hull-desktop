/**
 * T1 时间线/日历视图 e2e（feishu-t1-kanban-timeline-api-contract.md 场景 TL/CAL/P/PERF 选摘）：
 * 五视图切换（<300ms）/ 时间线聚合排序兜底 / XSS 消毒 / 日历落格条带过期时区本地化 / 视图持久化 / startDate 选择器。
 * 种子数据用相对日期（今天锚定），避免机器日期漂移。
 */
import { test, expect } from '@playwright/test';
import { join } from 'node:path';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { makeTempUserData, seedFakeDsh, seedSettings, launchApp, sleep } from './helpers';

const DAY = 24 * 60 * 60 * 1000;

/** 相对今天构造种子看板：v2 数据（含 startDate），覆盖创建/评论/执行缺时间戳/区间/过期各形态 */
function seedTimelineBoard(userData: string): void {
  const kanbanDir = join(userData, 'kanban');
  mkdirSync(kanbanDir, { recursive: true });
  const now = Date.now();
  const iso = (offsetDays: number) => new Date(now - offsetDays * DAY).toISOString();
  const key = (offsetDays: number) => {
    const d = new Date(now - offsetDays * DAY);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  };
  const task = (id: string, columnId: string, createdDaysAgo: number, extra: Record<string, unknown> = {}) => ({
    id, parentId: null, columnId, title: `任务${id}`, executionMode: 'manual', executionStatus: 'idle',
    currentExecutionId: null, acceptanceCriteria: null,
    agentSpec: { provider: 'dsh', agent: null, model: null, subagentPolicy: 'auto' },
    dependencies: [], description: null, labels: [], priority: 'P2', assignee: null,
    dueDate: null, startDate: null, order: 0, blockedFromColumnId: null, archivedAt: null, archivedFromColumnId: null,
    createdAt: iso(createdDaysAgo), updatedAt: iso(createdDaysAgo), timeline: [], ...extra,
  });
  const data = {
    version: 2,
    boards: [
      {
        id: 'b_tl', name: '时间线板', order: 0, createdAt: iso(10), updatedAt: iso(10),
        columns: [
          { id: 'c_todo', type: 'todo', name: 'Todo', order: 0, color: '#58a6ff', hidden: false },
          { id: 'c_done', type: 'done', name: 'Done', order: 1, color: '#3fb950', hidden: false },
        ],
        tasks: [
          // t_d：最新创建（now）→ 时间线第一条
          task('t_d', 'c_todo', 0),
          // t_b：1 天前创建；startDate=3 天前 → dueDate=今天 区间条带跨格
          task('t_b', 'c_todo', 1, { startDate: key(3), dueDate: key(0) }),
          // t_a：3 天前创建；含 XSS 评论（2 天前）+ 执行记录双时间戳缺失（updatedAt 兜底 4 天前）
          task('t_a', 'c_done', 3, {
            updatedAt: iso(4),
            timeline: [
              { id: 'tl_xss', type: 'comment', content: '<img src=x onerror="window.__xss=1">**加粗**评论 [坏链](javascript:window.__xss=1)', attachments: [], createdAt: iso(2), author: 'user', source: { type: 'user', provider: 'dsh' }, execution: null },
              { id: 'tl_exec', type: 'execution', content: '执行完成', attachments: [], createdAt: iso(4), author: null, source: { type: 'system' }, execution: { status: 'failed', command: 'npm test', startedAt: null, finishedAt: null, exitCode: 1, outputPath: null, selfCheck: null } },
            ],
          }),
          // t_c：5 天前创建；dueDate=昨天 → 过期标记单日落格
          task('t_c', 'c_done', 5, { dueDate: key(1) }),
        ],
      },
      { id: 'b_empty', name: '空板', order: 1, createdAt: iso(10), updatedAt: iso(10), columns: [{ id: 'c_todo2', type: 'todo', name: 'Todo', order: 0, color: '#58a6ff', hidden: false }], tasks: [] },
    ],
  };
  writeFileSync(join(kanbanDir, 'boards.json'), JSON.stringify(data, null, 2));
}

async function openBoard() {
  const tmp = makeTempUserData();
  seedFakeDsh(tmp.dir);
  seedSettings(tmp.dir);
  seedTimelineBoard(tmp.dir);
  const app = await launchApp({ userData: tmp.dir, fakeDshMode: 'ready' });
  const shell = await app.firstWindow();
  await shell.locator('#nav-board').click();
  return { tmp, app, shell };
}

test.describe('T1 五视图接入与持久化', () => {
  test('五视图按钮呈现；timeline/calendar 切换渲染且 <300ms（FR-5/CON-R-timeline-006）', async () => {
    const { tmp, app, shell } = await openBoard();
    await expect(shell.locator('#board-root .kb-view')).toHaveCount(6);
    // 切时间线 → 条目渲染
    await shell.locator('[data-view="timeline"]').click();
    await expect(shell.locator('.kb-tl-row').first()).toBeVisible();
    // 切日历 → 网格渲染
    await shell.locator('[data-view="calendar"]').click();
    await expect(shell.locator('.kb-cal-grid')).toBeVisible();
    // 切换耗时（点击 → 渲染帧）<300ms（PERF3 简化形态）
    const ms = await shell.evaluate(async () => {
      const t0 = performance.now();
      (document.querySelector('[data-view="board"]') as HTMLElement).click();
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      return performance.now() - t0;
    });
    expect(ms).toBeLessThan(300);
    await app.close();
    tmp.cleanup();
  });

  test('视图持久化：切 calendar 重载保持；非法值回退 board（P1/P2/P3，Q-053）', async () => {
    const { tmp, app, shell } = await openBoard();
    await shell.locator('[data-view="calendar"]').click();
    expect(await shell.evaluate(() => localStorage.getItem('kanban:lastView'))).toBe('calendar');
    await shell.reload();
    await shell.locator('#nav-board').click();
    await expect(shell.locator('.kb-cal-grid')).toBeVisible(); // 重启保持上次视图
    // 非法值 → 回退 board 不报错
    await shell.evaluate(() => localStorage.setItem('kanban:lastView', 'hack'));
    await shell.reload();
    await shell.locator('#nav-board').click();
    await expect(shell.locator('#board-root .kb-card').first()).toBeVisible();
    await app.close();
    tmp.cleanup();
  });
});

test.describe('T1 时间线视图', () => {
  test('活动流倒序 + 徽标 + 点击跳详情（TL1/TL5，Q-055 同戳稳定）', async () => {
    const { tmp, app, shell } = await openBoard();
    await shell.locator('[data-view="timeline"]').click();
    // 倒序：t_d 创建(now) → t_b 创建(1d) → t_a 评论(2d) → t_a 创建(3d) → t_a 执行兜底(4d) → t_c 创建(5d)
    await expect(shell.locator('.kb-tl-row[data-task]')).toHaveCount(6);
    const order = await shell.locator('.kb-tl-row').evaluateAll((rows) => rows.map((r) => (r as HTMLElement).dataset.task));
    expect(order).toEqual(['t_d', 't_b', 't_a', 't_a', 't_a', 't_c']);
    // 徽标类型
    await expect(shell.locator('.kb-tl-row').nth(0).locator('.kb-tlb')).toHaveText('创建');
    await expect(shell.locator('.kb-tl-row').nth(2).locator('.kb-tlb')).toHaveText('评论');
    await expect(shell.locator('.kb-tl-row').nth(4).locator('.kb-tlb')).toHaveText('执行');
    // 点击条目 → 打开对应任务详情
    await shell.locator('.kb-tl-row[data-task="t_c"]').first().click();
    await expect(shell.locator('.kb-detail-head h3')).toHaveText('任务t_c');
    await app.close();
    tmp.cleanup();
  });

  test('执行缺 startedAt/finishedAt → updatedAt 兜底排序 + 「时间未知」标记（TL3/Q-055）', async () => {
    const { tmp, app, shell } = await openBoard();
    await shell.locator('[data-view="timeline"]').click();
    const execRow = shell.locator('.kb-tl-row', { has: shell.locator('.kb-tlb', { hasText: '执行' }) });
    await expect(execRow.locator('.kb-tl-unknown')).toHaveText('时间未知');
    // 兜底键 = task.updatedAt（4 天前）→ 排在 t_a 创建（3 天前）之后、t_c（5 天前）之前
    const order = await shell.locator('.kb-tl-row').evaluateAll((rows) => rows.map((r) => (r as HTMLElement).dataset.task));
    expect(order).toEqual(['t_d', 't_b', 't_a', 't_a', 't_a', 't_c']);
    await app.close();
    tmp.cleanup();
  });

  test('评论 XSS 载荷不执行、文本可见（TL7，markdown-it+DOMPurify 与 E1 同管线）', async () => {
    const { tmp, app, shell } = await openBoard();
    let dialogFired = false;
    shell.on('dialog', () => { dialogFired = true; });
    await shell.locator('[data-view="timeline"]').click();
    const commentMd = shell.locator('.kb-tl-md').first();
    await expect(commentMd.locator('strong', { hasText: '加粗' })).toBeVisible(); // markdown 渲染生效
    await expect(commentMd.locator('img')).toHaveCount(0);
    await expect(commentMd.locator('a[href^="javascript:"]')).toHaveCount(0);
    await expect(shell.locator('.kb-tl-row').filter({ hasText: '<img src=x' })).toHaveCount(1); // 原文以文本可见
    await sleep(500); // 给潜在 onerror/alert 执行窗口
    expect(dialogFired).toBe(false);
    expect(await shell.evaluate(() => (window as unknown as { __xss?: number }).__xss ?? 0)).toBe(0);
    await app.close();
    tmp.cleanup();
  });

  test('时间线空态（TL6）', async () => {
    const { tmp, app, shell } = await openBoard();
    await shell.locator('#kb-board-select').selectOption('b_empty');
    await shell.locator('[data-view="timeline"]').click();
    await expect(shell.locator('.kb-empty-tlv')).toHaveText('暂无活动，创建任务后这里会显示时间线');
    await app.close();
    tmp.cleanup();
  });
});

test.describe('T1 日历视图', () => {
  test('dueDate 落格 + 过期标记 + startDate+dueDate 区间跨格条带（CAL1/CAL2/CAL4，Q-054 本地时区）', async () => {
    const { tmp, app, shell } = await openBoard();
    await shell.locator('[data-view="calendar"]').click();
    const dayKey = (offset: number) => shell.evaluate((off) => {
      const d = new Date(Date.now() + off * 24 * 3600 * 1000);
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    }, offset);
    const todayKey = await dayKey(0);
    const yKey = await dayKey(-1);
    // CAL1：t_b dueDate=今天 落今日格
    await expect(shell.locator(`.kb-cal-cell[data-date="${todayKey}"] .kb-cal-task[data-task="t_b"]`)).toBeVisible();
    // CAL2：t_b 区间 3 天前→今天，条带逐格连续（≥4 格）
    expect(await shell.locator('.kb-cal-task[data-task="t_b"]').count()).toBeGreaterThanOrEqual(4);
    // CAL4：t_c dueDate=昨天 → 过期标记
    await expect(shell.locator(`.kb-cal-cell[data-date="${yKey}"] .kb-cal-task[data-task="t_c"]`)).toHaveClass(/kb-overdue/);
    await app.close();
    tmp.cleanup();
  });

  test('月/周粒度切换 + 中文月标签（CAL6/CAL7，Intl zh-CN）', async () => {
    const { tmp, app, shell } = await openBoard();
    await shell.locator('[data-view="calendar"]').click();
    await expect(shell.locator('.kb-cal-title')).toHaveText(/^\d{4}年\d{1,2}月/); // 中文月标签
    await expect(shell.locator('.kb-cal-cell')).toHaveCount(42); // 月视图 6×7
    await shell.locator('[data-calmode="week"]').click();
    await expect(shell.locator('.kb-cal-cell')).toHaveCount(7); // 周视图 7 格
    await shell.locator('[data-calmode="month"]').click();
    await expect(shell.locator('.kb-cal-cell')).toHaveCount(42);
    await app.close();
    tmp.cleanup();
  });

  test('日历空态：切到无任务月份（CAL10）', async () => {
    const { tmp, app, shell } = await openBoard();
    await shell.locator('[data-view="calendar"]').click();
    for (let i = 0; i < 3; i++) await shell.locator('[data-cal="next"]').click();
    await expect(shell.locator('.kb-empty-tlv')).toHaveText('本月无到期任务');
    await app.close();
    tmp.cleanup();
  });
});

test.describe('T1 详情面板 startDate 选择器（T2 契约 UI 承接）', () => {
  test('设开始日期即时落盘 + 日历条带出现', async () => {
    const { tmp, app, shell } = await openBoard();
    // 详情面板设 t_d 开始日期 = 3 天前（无 dueDate → 仅 startDate 显示至当月末尾）
    const startKey = await shell.evaluate(() => {
      const d = new Date(Date.now() - 3 * 24 * 3600 * 1000);
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    });
    await shell.locator('.kb-card', { hasText: '任务t_d' }).click();
    await shell.locator('#kb-date-start').fill(startKey);
    await expect.poll(() => {
      const raw = JSON.parse(readFileSync(join(tmp.dir, 'kanban', 'boards.json'), 'utf8')) as { boards: Array<{ tasks: Array<{ id: string; startDate: string | null }> }> };
      return raw.boards[0].tasks.find((t) => t.id === 't_d')?.startDate ?? '';
    }).toBe(startKey);
    // 日历出现条带（仅 startDate → 至当月末尾）
    await shell.keyboard.press('Escape');
    await shell.locator('[data-view="calendar"]').click();
    expect(await shell.locator('.kb-cal-task[data-task="t_d"]').count()).toBeGreaterThanOrEqual(3);
    await app.close();
    tmp.cleanup();
  });
});
