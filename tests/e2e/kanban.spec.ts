/**
 * B2 看板 UI e2e（M2）：fake dsh 环境 + 种子看板数据。
 * 验证：nav-board 进入看板 → 看板视图渲染（列+卡片）→ 三视图切换 → 多项目切换。
 */
import { test, expect } from '@playwright/test';
import { join } from 'node:path';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { makeTempUserData, seedFakeDsh, seedSettings, launchApp, sleep, officialViewState } from './helpers';

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
    await expect(shell.locator('#board-root .kb-view')).toHaveCount(5); // T1：五视图（看板/列表/归档/时间线/日历）
    // 列表视图（限定 #board-root——skills 页 sk-viewbtn 也用 data-view，防选择器撞车）
    await shell.locator('#board-root [data-view="list"]').click();
    await expect(shell.locator('#board-root .kb-list tbody tr[data-id]')).toHaveCount(2);
    // 归档视图（空）
    await shell.locator('#board-root [data-view="archive"]').click();
    await expect(shell.locator('#board-root', { hasText: '归档区为空' })).toBeVisible();
    // 回看板视图
    await shell.locator('#board-root [data-view="board"]').click();
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

  test('nav-web 恢复官方 view（showBoard → showWeb 对称）', async () => {
    const tmp = makeTempUserData();
    seedFakeDsh(tmp.dir);
    seedSettings(tmp.dir);
    seedBoard(tmp.dir);
    const app = await launchApp({ userData: tmp.dir, fakeDshMode: 'ready' });
    const shell = await app.firstWindow();
    await expect(shell.locator('#nav-web')).toBeVisible();
    // 初始：fake dsh ready → official view 可见
    await expect.poll(() => officialViewState(app)).toMatchObject({ visible: true });
    // 进看板 → official view 隐藏（board 面板显示）
    await shell.locator('#nav-board').click();
    await expect(shell.locator('#board')).not.toHaveClass(/hidden/);
    await expect.poll(() => officialViewState(app)).toMatchObject({ visible: false });
    // 回 dsh web → official view 恢复可见，board 面板隐藏
    await shell.locator('#nav-web').click();
    await expect(shell.locator('#board')).toHaveClass(/hidden/);
    await expect.poll(() => officialViewState(app)).toMatchObject({ visible: true });
    await app.close();
    tmp.cleanup();
  });
});

/**
 * E1 看板 ticket 内容编辑器（feishu-e1-kanban-editor-api-contract.md 场景 E1~E19 选摘）：
 * 三入口 EasyMDE + description round-trip/空 null + detail markdown 渲染 + XSS 消毒 + ESC/destroy 生命周期。
 */
test.describe('E1 看板编辑器', () => {
  /** 在 CodeMirror 编辑区输入文本（EasyMDE 接管 textarea 后的真实输入路径） */
  async function typeIntoEditor(shell: import('@playwright/test').Page, text: string): Promise<void> {
    await shell.locator('.EasyMDEContainer .CodeMirror').first().click();
    await shell.keyboard.type(text);
  }

  function readBoards(userData: string): { tasks: Array<{ description: string | null; timeline: Array<{ type: string; content: string }> }> } {
    const raw = JSON.parse(readFileSync(join(userData, 'kanban', 'boards.json'), 'utf8')) as {
      boards: Array<{ tasks: Array<{ description: string | null; timeline: Array<{ type: string; content: string }> }> }>;
    };
    return raw.boards[0];
  }

  test('三入口 EasyMDE 呈现；create markdown round-trip 落盘；空描述存 null（E1/E2/E3）', async () => {
    const tmp = makeTempUserData();
    seedFakeDsh(tmp.dir);
    seedSettings(tmp.dir);
    seedBoard(tmp.dir);
    const app = await launchApp({ userData: tmp.dir, fakeDshMode: 'ready' });
    const shell = await app.firstWindow();
    await shell.locator('#nav-board').click();

    // create 弹窗：EasyMDE 容器 + 工具栏呈现
    await shell.locator('.kb-add-card').first().click();
    await expect(shell.locator('.kb-modal .EasyMDEContainer')).toBeVisible();
    await expect(shell.locator('.kb-modal .editor-toolbar button').first()).toBeVisible();
    // 输入标题 + Markdown 描述 → 创建
    await shell.locator('#kb-tt').fill('E1 markdown 任务');
    await typeIntoEditor(shell, '# 标题\n\n- 列表项');
    await shell.locator('[data-ok]').click();
    await expect(shell.locator('.kb-modal')).toHaveCount(0);
    // E2：description 为 Markdown 原样字符串落盘（boards.json 结构不变）
    await expect.poll(() => readBoards(tmp.dir).tasks[2]?.description ?? '').toBe('# 标题\n\n- 列表项');

    // E3：空描述 → null（编辑器留空直接创建）
    await shell.locator('.kb-add-card').first().click();
    await shell.locator('#kb-tt').fill('E1 空描述任务');
    await shell.locator('[data-ok]').click();
    await expect(shell.locator('.kb-modal')).toHaveCount(0);
    await expect.poll(() => readBoards(tmp.dir).tasks[3]?.description).toBeNull();

    // edit 入口：预填现值（FE-1）
    await shell.locator('.kb-card', { hasText: 'E1 markdown 任务' }).click();
    await expect(shell.locator('.kb-detail-desc h1', { hasText: '标题' })).toBeVisible(); // 详情已走 markdown 渲染
    await shell.locator('[data-edit]').click();
    await expect(shell.locator('.kb-modal .EasyMDEContainer')).toBeVisible();
    await expect(shell.locator('.kb-modal .CodeMirror')).toContainText('# 标题');
    await shell.keyboard.press('Escape'); // E19：ESC 关闭（编辑器不吞）
    await expect(shell.locator('.kb-modal')).toHaveCount(0);
    await app.close();
    tmp.cleanup();
  });

  test('detail 结构化渲染：标题/加粗/列表/代码/链接/表格/任务列表（E4/E17）', async () => {
    const tmp = makeTempUserData();
    seedFakeDsh(tmp.dir);
    seedSettings(tmp.dir);
    seedBoard(tmp.dir);
    // 种子任务 t_1 描述改为 GFM 全样样本
    const boardsPath = join(tmp.dir, 'kanban', 'boards.json');
    const data = JSON.parse(readFileSync(boardsPath, 'utf8'));
    data.boards[0].tasks[0].description = [
      '# 大标题',
      '',
      '**加粗** 与 *斜体*',
      '',
      '- 列表一',
      '- [x] 已完成',
      '- [ ] 待办',
      '',
      '| a | b |',
      '|---|---|',
      '| 1 | 2 |',
      '',
      '```js',
      'console.log(1)',
      '```',
      '',
      '[外链](https://example.com)',
    ].join('\n');
    writeFileSync(boardsPath, JSON.stringify(data, null, 2));
    const app = await launchApp({ userData: tmp.dir, fakeDshMode: 'ready' });
    const shell = await app.firstWindow();
    await shell.locator('#nav-board').click();
    await shell.locator('.kb-card', { hasText: '看板任务 A' }).click();
    const desc = shell.locator('.kb-detail-desc');
    await expect(desc.locator('h1', { hasText: '大标题' })).toBeVisible();
    await expect(desc.locator('strong', { hasText: '加粗' })).toBeVisible();
    await expect(desc.locator('li', { hasText: '列表一' })).toBeVisible();
    // GFM 任务列表（markdown-it-task-lists）
    await expect(desc.locator('.task-list-item input[type="checkbox"]')).toHaveCount(2);
    await expect(desc.locator('table td', { hasText: '1' })).toBeVisible();
    await expect(desc.locator('pre code', { hasText: 'console.log' })).toBeVisible();
    await expect(desc.locator('a[href="https://example.com"]', { hasText: '外链' })).toBeVisible();
    await app.close();
    tmp.cleanup();
  });

  test('XSS 三载荷不执行：img onerror / script / javascript: href（E6/E7/E8）', async () => {
    const tmp = makeTempUserData();
    seedFakeDsh(tmp.dir);
    seedSettings(tmp.dir);
    seedBoard(tmp.dir);
    const boardsPath = join(tmp.dir, 'kanban', 'boards.json');
    const data = JSON.parse(readFileSync(boardsPath, 'utf8'));
    data.boards[0].tasks[0].description = [
      '<img src=x onerror="window.__xss=1">',
      '<script>window.__xss=1</script>',
      '[坏链](javascript:window.__xss=1)',
    ].join('\n');
    writeFileSync(boardsPath, JSON.stringify(data, null, 2));
    const app = await launchApp({ userData: tmp.dir, fakeDshMode: 'ready' });
    const shell = await app.firstWindow();
    let dialogFired = false;
    shell.on('dialog', () => { dialogFired = true; });
    await shell.locator('#nav-board').click();
    await shell.locator('.kb-card', { hasText: '看板任务 A' }).click();
    const desc = shell.locator('.kb-detail-desc');
    // 载荷以文本可见、不执行：无 script/img 元素、无 javascript: href
    await expect(desc).toContainText('<img src=x');
    await expect(desc).toContainText('[坏链]');
    await expect(desc.locator('script')).toHaveCount(0);
    await expect(desc.locator('img')).toHaveCount(0);
    await expect(desc.locator('a[href^="javascript:"]')).toHaveCount(0);
    await sleep(500); // 给潜在 onerror/alert 执行窗口
    expect(dialogFired).toBe(false);
    expect(await shell.evaluate(() => (window as unknown as { __xss?: number }).__xss ?? 0)).toBe(0);
    await app.close();
    tmp.cleanup();
  });

  test('comment EasyMDE → markdown 渲染；反复开关 destroy 无泄漏（E9/E13）', async () => {
    const tmp = makeTempUserData();
    seedFakeDsh(tmp.dir);
    seedSettings(tmp.dir);
    seedBoard(tmp.dir);
    const app = await launchApp({ userData: tmp.dir, fakeDshMode: 'ready' });
    const shell = await app.firstWindow();
    await shell.locator('#nav-board').click();

    // 泄漏冒烟：反复开关 create 弹窗，关闭后无 EasyMDE 孤儿实例（Q-041）
    for (let i = 0; i < 5; i++) {
      await shell.locator('.kb-add-card').first().click();
      await expect(shell.locator('.kb-modal .EasyMDEContainer')).toHaveCount(1);
      await shell.keyboard.press('Escape');
      await expect(shell.locator('.kb-modal')).toHaveCount(0);
      expect(await shell.evaluate(() => document.querySelectorAll('.EasyMDEContainer').length as unknown as number)).toBe(0);
    }

    // comment 入口：EasyMDE 呈现 → 提交 markdown 评论 → timeline content 原样落盘
    await shell.locator('.kb-card', { hasText: '看板任务 A' }).click();
    await expect(shell.locator('.kb-comment .EasyMDEContainer')).toBeVisible();
    await typeIntoEditor(shell, '**重要**评论');
    await shell.locator('[data-comment]').click();
    // 现有行为：评论成功后 close → loadBoard → 自动重开详情（非关闭态）
    await expect(shell.locator('.kb-tl-content strong', { hasText: '重要' })).toBeVisible();
    await expect.poll(() => readBoards(tmp.dir).tasks[0].timeline.some((i) => i.type === 'comment' && i.content === '**重要**评论')).toBe(true);
    await app.close();
    tmp.cleanup();
  });
});
