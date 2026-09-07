/**
 * README 截图采集（手动触发，不进常规 e2e 套件）：
 *   CAPTURE_SCREENSHOTS=1 npx playwright test tests/e2e/capture-screenshots.spec.ts
 *   CAPTURE_REAL_DSH=1     ← 追加真实 dsh web 截图（用真实 userData，含真实会话数据，勿公开敏感内容）
 * 产出 docs/screenshots/*.png。
 *
 * 注意：主窗口 capturePage 不合成 WebContentsView（官方 UI 独立 webContents）——
 * dsh web 截图走「官方 webContents 自身 capturePage」路径，产物为纯官方 UI（无壳 nav）。
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
  waitForMainWindow,
  mainWindowUrl,
  shellPage,
  PROJECT_ROOT,
} from './helpers';

function seedBoard(userData: string): void {
  const kanbanDir = join(userData, 'kanban');
  mkdirSync(kanbanDir, { recursive: true });
  const now = new Date().toISOString();
  const day = (offset: number): string => {
    const d = new Date();
    d.setDate(d.getDate() + offset);
    return d.toISOString().slice(0, 10);
  };
  const base = {
    parentId: null, executionMode: 'manual', executionStatus: 'idle', currentExecutionId: null,
    acceptanceCriteria: null, agentSpec: { provider: 'dsh', agent: null, model: null, subagentPolicy: 'auto' },
    dependencies: [], assignee: null, blockedFromColumnId: null, archivedAt: null, archivedFromColumnId: null,
    createdAt: now, updatedAt: now, timeline: [],
  };
  const task = (id: string, columnId: string, title: string, extra: Record<string, unknown> = {}) => ({
    ...base, id, columnId, title, order: 0, ...extra,
  });
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
          { id: 'c_doing', type: 'doing', name: 'In Progress', order: 2, color: '#d29922', hidden: false },
          { id: 'c_done', type: 'done', name: 'Done', order: 3, color: '#3fb950', hidden: false },
        ],
        tasks: [
          task('t_1', 'c_backlog', '设计插件市场交互稿', { description: '**目标**：插件市场 MVP 交互稿\n\n- 插件形态\n- 分发渠道', labels: ['frontend'], priority: 'P1' }),
          task('t_2', 'c_backlog', '调研插件分发渠道', { description: null, labels: ['research'], priority: 'P2' }),
          task('t_3', 'c_todo', '实现市场列表页', { description: '卡片网格 + 分类筛选 + 搜索', labels: ['frontend'], priority: 'P2', startDate: day(-2), dueDate: day(5) }),
          task('t_4', 'c_todo', '安装/卸载生命周期', { description: null, labels: ['electron'], priority: 'P1', startDate: day(0), dueDate: day(7) }),
          task('t_5', 'c_doing', '技能扫描性能优化', { description: '首屏 <2s（200+ skill）', labels: ['electron', 'perf'], priority: 'P1', startDate: day(-3), dueDate: day(2) }),
          task('t_6', 'c_done', '修复 spawn ENOENT 弹框', { description: 'node 解析收敛 spawnArgs 单一修改点', labels: ['bugfix'], priority: 'P0', startDate: day(-6), dueDate: day(-1) }),
        ],
      },
    ],
  };
  writeFileSync(join(kanbanDir, 'boards.json'), JSON.stringify(data, null, 2));
}

function captureWindow(app: import('@playwright/test').ElectronApplication): Promise<Buffer> {
  return app
    .evaluate(({ BrowserWindow }) =>
      (async () => {
        const win = BrowserWindow.getAllWindows()[0];
        const img = await win.webContents.capturePage();
        return img.toPNG().toString('base64');
      })()
    )
    .then((b64) => Buffer.from(b64, 'base64'));
}

/** 整窗合成截图（desktopCapturer 抓窗口源像素——包含 WebContentsView 层，即壳 nav + 官方 UI 同框） */
function captureWindowComposited(app: import('@playwright/test').ElectronApplication): Promise<Buffer> {
  return app
    .evaluate(({ desktopCapturer, BrowserWindow }) =>
      (async () => {
        const win = BrowserWindow.getAllWindows()[0];
        const b = win.getBounds();
        const sources = await desktopCapturer.getSources({
          types: ['window'],
          thumbnailSize: { width: Math.max(b.width * 2, 2400), height: Math.max(b.height * 2, 1600) },
          fetchWindowIcons: false,
        });
        const src = sources.find((s) => s.name === win.getTitle()) ?? sources[0];
        if (!src) return '';
        return src.thumbnail.toPNG().toString('base64');
      })()
    )
    .then((b64) => {
      if (!b64) throw new Error('desktopCapturer 未抓到窗口源（可能缺屏幕录制权限）');
      return Buffer.from(b64, 'base64');
    });
}

const REAL_USER_DATA = join(process.env.HOME ?? '', 'Library', 'Application Support', 'dsh-hull-desktop');

test.describe('README 截图采集', () => {
  test.skip(!process.env.CAPTURE_SCREENSHOTS, '仅 CAPTURE_SCREENSHOTS=1 时运行');

  test('壳内视图截图（种子假数据）', async () => {
    test.setTimeout(120_000);
    const tmp = makeTempUserData();
    seedFakeDsh(tmp.dir);
    seedSettings(tmp.dir);
    seedBoard(tmp.dir);
    const app = await launchApp({ userData: tmp.dir, fakeDshMode: 'ready' });
    try {
      const shell = await waitForReady(app, 30_000);
      await expect(shell.locator('#nav')).toBeVisible();
      const outDir = join(PROJECT_ROOT, 'docs', 'screenshots');
      mkdirSync(outDir, { recursive: true });

      // 看板
      await shell.locator('#nav-board').click();
      await expect(shell.locator('#board-root .kb-card')).toHaveCount(6);
      await shell.waitForTimeout(500);
      writeFileSync(join(outDir, 'board.png'), await captureWindow(app));

      // 看板日历视图（时间线 data-view=timeline 为任务事件流，非日历栅格——README 用 calendar）
      await shell.locator('#board-root [data-view="calendar"]').click();
      await shell.waitForTimeout(800);
      writeFileSync(join(outDir, 'board-calendar.png'), await captureWindow(app));
      await shell.locator('#board-root [data-view="board"]').click();

      // 任务详情弹框（EasyMDE 编辑器）
      await shell.locator('#board-root .kb-card', { hasText: '技能扫描性能优化' }).click();
      await shell.locator('.EasyMDEContainer .CodeMirror').first().waitFor({ state: 'visible', timeout: 10_000 });
      await shell.waitForTimeout(500);
      writeFileSync(join(outDir, 'board-detail.png'), await captureWindow(app));
      await shell.keyboard.press('Escape');
      await shell.waitForTimeout(400);

      // 设置
      await shell.locator('#nav-settings').click();
      await shell.waitForTimeout(800);
      writeFileSync(join(outDir, 'settings.png'), await captureWindow(app));
    } finally {
      await app.close();
      tmp.cleanup();
    }
  });

  test('dsh web 官方 UI 截图（真实 userData）', async () => {
    test.skip(!process.env.CAPTURE_REAL_DSH, '仅 CAPTURE_REAL_DSH=1 时运行（用真实 userData）');
    test.setTimeout(120_000);
    const app = await launchApp({ userData: REAL_USER_DATA });
    try {
      // 真实 dsh web 根路径返回完整 HTML（非 fake 的 body=ok）——只等官方 view URL 就绪
      const deadline = Date.now() + 60_000;
      while (Date.now() < deadline) {
        if ((await mainWindowUrl(app)).startsWith('http://127.0.0.1:')) break;
        await new Promise((r) => setTimeout(r, 300));
      }
      if (!(await mainWindowUrl(app)).startsWith('http://127.0.0.1:')) {
        throw new Error('真实 dsh web 未在 60s 内就绪');
      }
      await waitForMainWindow(app, 30_000);
      // 隐藏 nav 状态区：真实 dsh web URL 含 ?token=（虽 localhost-only 也不该进公开 README），顺带消「检查更新中」噪声
      const shell = shellPage(app);
      if (shell) {
        await shell.evaluate(() => document.getElementById('nav-status')?.style.setProperty('display', 'none'));
        await shell.waitForTimeout(300);
      }
      await new Promise((r) => setTimeout(r, 4000)); // 等官方 UI 渲染稳定
      const outDir = join(PROJECT_ROOT, 'docs', 'screenshots');
      mkdirSync(outDir, { recursive: true });
      // 整窗合成截图（壳 nav + 官方 UI 同框；desktopCapturer 含 WebContentsView 层）
      writeFileSync(join(outDir, 'dsh-web.png'), await captureWindowComposited(app));
    } finally {
      await app.close();
    }
  });
});
