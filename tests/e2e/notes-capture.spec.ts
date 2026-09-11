/**
 * 笔记视图视觉验证截图（手动触发，不进常规 e2e）：
 *   CAPTURE_NOTES=1 npx playwright test tests/e2e/notes-capture.spec.ts
 */
import { test } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeTempUserData, seedFakeDsh, seedSettings, launchApp, waitForReady } from './helpers';

test.skip(!process.env.CAPTURE_NOTES, '仅 CAPTURE_NOTES=1 时运行');

test('capture notes view', async () => {
  test.setTimeout(120_000);
  const tmp = makeTempUserData();
  seedFakeDsh(tmp.dir);
  seedSettings(tmp.dir);
  const notesDir = join(tmp.dir, 'notes');
  mkdirSync(join(notesDir, '工作'), { recursive: true });
  mkdirSync(join(notesDir, '经验'), { recursive: true });
  writeFileSync(
    join(notesDir, '工作', '2026-09-11-M2看板踩坑.md'),
    '---\ntitle: M2 看板踩坑记录\ntype: 工作\ntask: t100110\n---\n\n# 优雅关停\n\n今天处理了 ACP 通道的优雅关停问题，结论是把 spawn 收敛到单一修改点。\n\n- 关键点一\n- 关键点二\n'
  );
  writeFileSync(
    join(notesDir, '经验', '2026-09-10-mac签名.md'),
    '---\ntitle: mac 签名踩坑\ntype: 经验\n---\n\n# 签名\n\nad-hoc 签名不可行，改用自签名证书。\n'
  );
  writeFileSync(join(notesDir, '2026-09-09-想法.md'), '# 想法：笔记与任务双向跳转\n\n关联功能很重要，赛高。\n');

  const app = await launchApp({ userData: tmp.dir, fakeDshMode: 'ready' });
  try {
    const shell = await waitForReady(app, 30_000);
    await shell.locator('#nav-notes').click();
    await shell.waitForTimeout(2500);
    await shell.screenshot({ path: '/tmp/notes-view-fixed.png' });
    // ④ 反馈回归：编辑态（frontmatter 淡化）+ 分屏态（57/43 + 分隔线，模式开关可退）
    await shell.locator('#note-items .note-item', { hasText: 'M2 看板踩坑记录' }).click();
    await shell.waitForTimeout(800);
    await shell.screenshot({ path: '/tmp/notes-edit-fixed.png' });
    await shell.locator('.note-mode-btn[data-mode="split"]').click();
    await shell.waitForTimeout(800);
    await shell.screenshot({ path: '/tmp/notes-split-fixed.png' });
    // 分屏可退：点「编辑」能回到编辑态（① 困死修复回归）
    await shell.locator('.note-mode-btn[data-mode="edit"]').click();
    await shell.waitForTimeout(300);
    // 看板视图对照：确认全壳未被笔记样式影响
    await shell.locator('#nav-board').click();
    await shell.waitForTimeout(800);
    await shell.screenshot({ path: '/tmp/shell-board-check.png' });
  } finally {
    await app.close();
    tmp.cleanup();
  }
});
