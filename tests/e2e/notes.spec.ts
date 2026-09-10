/**
 * N2/N1 notes 主链路 e2e 冒烟（wave-1 联合集成）：fake dsh 环境 + <userData>/notes/*.md 种子。
 * 场景：nav 进入 → 列表/树渲染 → 新建+自动保存落盘 → 删除→回收站→恢复 → 新建目录 → 搜索 → 外部改动冲突弹窗。
 * 选择器全部取自 src/renderer/notes.js 真实 DOM（#nt-new/#nt-items/.nt-item/.CodeMirror/#nt-newdir-input/...）。
 */
import { test, expect } from '@playwright/test';
import type { ElectronApplication } from '@playwright/test';
import { join } from 'node:path';
import { existsSync, mkdirSync, readFileSync, readdirSync, utimesSync, writeFileSync } from 'node:fs';
import { makeTempUserData, seedFakeDsh, seedSettings, launchApp, sleep } from './helpers';

/** 种子两篇笔记（含子目录一篇；frontmatter + 正文供搜索/树渲染） */
function seedNotes(userData: string): void {
  const notes = join(userData, 'notes');
  mkdirSync(join(notes, '工作'), { recursive: true });
  writeFileSync(join(notes, 'alpha.md'), '---\ntitle: Alpha 计划\n---\n\nalpha keyword 正文内容\n', 'utf8');
  writeFileSync(join(notes, '工作', 'meeting.md'), '---\ntitle: 每周例会\ntype: daily\n---\n\nmeeting keyword 记录\n', 'utf8');
}

/** 等待 <userData>/notes 递归出现包含 needle 的 .md 文件（autosave debounce ~2s 落盘判定） */
async function waitForNoteContent(userData: string, needle: string, timeoutMs = 15_000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  const root = join(userData, 'notes');
  const walk = (dir: string): string[] => {
    const out: string[] = [];
    for (const name of readdirSync(dir)) {
      if (name.startsWith('.')) continue;
      const p = join(dir, name);
      try {
        if (name.endsWith('.md')) out.push(p);
        else out.push(...walk(p));
      } catch { /* 已删除竞态 */ }
    }
    return out;
  };
  while (Date.now() < deadline) {
    try {
      for (const p of walk(root)) {
        if (readFileSync(p, 'utf8').includes(needle)) return p;
      }
    } catch { /* 目录未创建 */ }
    await sleep(200);
  }
  throw new Error(`未在 ${timeoutMs}ms 内发现含 "${needle}" 的笔记文件`);
}

async function openNotesView(app: ElectronApplication) {
  const shell = await app.firstWindow();
  await expect(shell.locator('#nav-notes')).toBeVisible();
  await shell.locator('#nav-notes').click();
  await expect(shell.locator('#notes')).not.toHaveClass(/hidden/);
  return shell;
}

test.describe('N2/N1 笔记主链路', () => {
  test('冷启动 → nav 笔记 → 列表 2 行 + 树含目录', async () => {
    const tmp = makeTempUserData();
    seedFakeDsh(tmp.dir);
    seedSettings(tmp.dir);
    seedNotes(tmp.dir);
    const app = await launchApp({ userData: tmp.dir, fakeDshMode: 'ready' });
    const shell = await openNotesView(app);
    // 列表 2 行（种子两篇）
    await expect(shell.locator('#nt-items .nt-item')).toHaveCount(2, { timeout: 20_000 });
    await expect(shell.locator('#nt-items .nt-item', { hasText: 'Alpha 计划' })).toBeVisible();
    await expect(shell.locator('#nt-items .nt-item', { hasText: '每周例会' })).toBeVisible();
    // 树含子目录「工作」
    await expect(shell.locator('#nt-tree .nt-trow[data-dir="工作"]')).toBeVisible();
    await app.close();
    tmp.cleanup();
  });

  test('新建笔记 → 输入 → autosave 落盘（磁盘文件含输入）', async () => {
    const tmp = makeTempUserData();
    seedFakeDsh(tmp.dir);
    seedSettings(tmp.dir);
    const app = await launchApp({ userData: tmp.dir, fakeDshMode: 'ready' });
    const shell = await openNotesView(app);
    // 空态 → 新建第一篇（或右上角 ＋ 新建）
    await shell.locator('#nt-new').click();
    const modal = shell.locator('.nt-modal');
    await expect(modal).toBeVisible();
    await shell.locator('#nt-new-title').fill('自动保存测试');
    await modal.locator('[data-ok]').click();
    // 编辑器出现（EasyMDE CodeMirror），输入内容
    const cm = shell.locator('#nt-editor-body .CodeMirror');
    await expect(cm).toBeVisible({ timeout: 20_000 });
    await cm.click();
    await shell.keyboard.type('hello autosave 正文 unique-token-7f3d');
    // debounce ~2s → 落盘（磁盘文件含输入）
    const file = await waitForNoteContent(tmp.dir, 'unique-token-7f3d', 20_000);
    expect(existsSync(file)).toBe(true);
    await app.close();
    tmp.cleanup();
  });

  test('删除（一次确认）→ 回收站出现 → 恢复 → 列表回来', async () => {
    const tmp = makeTempUserData();
    seedFakeDsh(tmp.dir);
    seedSettings(tmp.dir);
    seedNotes(tmp.dir);
    const app = await launchApp({ userData: tmp.dir, fakeDshMode: 'ready' });
    const shell = await openNotesView(app);
    await expect(shell.locator('#nt-items .nt-item')).toHaveCount(2, { timeout: 20_000 });
    // 打开 alpha → 删除 → 确认弹窗
    await shell.locator('#nt-items .nt-item', { hasText: 'Alpha 计划' }).click();
    await expect(shell.locator('#nt-del')).toBeVisible();
    await shell.locator('#nt-del').click();
    const modal = shell.locator('.nt-modal');
    await expect(modal).toBeVisible();
    await modal.locator('[data-ok]').click();
    // 列表消失（剩 1 行）
    await expect(shell.locator('#nt-items .nt-item')).toHaveCount(1);
    // 回收站入口出现该条
    await expect(shell.locator('#nt-trash-count')).not.toBeHidden();
    await shell.locator('#nt-trash-entry').click();
    await expect(shell.locator('#nt-items .nt-trash-item')).toHaveCount(1);
    await expect(shell.locator('#nt-items .nt-trash-path')).toHaveText(/alpha\.md/);
    // 恢复 → 列表回来
    await shell.locator('#nt-items [data-restore]').click();
    await shell.locator('#nt-trash-back').click();
    await expect(shell.locator('#nt-items .nt-item', { hasText: 'Alpha 计划' })).toBeVisible({ timeout: 20_000 });
    await expect(shell.locator('#nt-items .nt-item')).toHaveCount(2);
    ok(existsSync(join(tmp.dir, 'notes', 'alpha.md')), '恢复后磁盘文件回原路径');
    await app.close();
    tmp.cleanup();
  });

  test('「+ 新建目录」→ 树出现新目录（notes:mkdir 链路）', async () => {
    const tmp = makeTempUserData();
    seedFakeDsh(tmp.dir);
    seedSettings(tmp.dir);
    seedNotes(tmp.dir);
    const app = await launchApp({ userData: tmp.dir, fakeDshMode: 'ready' });
    const shell = await openNotesView(app);
    await expect(shell.locator('#nt-items .nt-item')).toHaveCount(2, { timeout: 20_000 });
    await shell.locator('#nt-newdir').click();
    await shell.locator('#nt-newdir-input').fill('资料库');
    await shell.keyboard.press('Enter');
    // 树出现新目录行 + 磁盘目录已创建（notes:mkdir 真建目录而非笔记文件）
    await expect(shell.locator('#nt-tree .nt-trow[data-dir="资料库"]')).toBeVisible({ timeout: 20_000 });
    ok(existsSync(join(tmp.dir, 'notes', '资料库')), '磁盘目录已创建');
    await app.close();
    tmp.cleanup();
  });

  test('搜索关键词 → 列表过滤；清空恢复', async () => {
    const tmp = makeTempUserData();
    seedFakeDsh(tmp.dir);
    seedSettings(tmp.dir);
    seedNotes(tmp.dir);
    const app = await launchApp({ userData: tmp.dir, fakeDshMode: 'ready' });
    const shell = await openNotesView(app);
    await expect(shell.locator('#nt-items .nt-item')).toHaveCount(2, { timeout: 20_000 });
    // 输入即搜（250ms debounce）——正文关键词命中一篇
    await shell.locator('#nt-q').fill('meeting');
    await expect(shell.locator('#nt-items .nt-item', { hasText: '每周例会' })).toBeVisible({ timeout: 15_000 });
    await expect(shell.locator('#nt-items .nt-item')).toHaveCount(1);
    // 清空 → 恢复全量
    await shell.locator('#nt-q').fill('');
    await expect(shell.locator('#nt-items .nt-item')).toHaveCount(2, { timeout: 15_000 });
    await app.close();
    tmp.cleanup();
  });

  test('外部改动冲突：fs 改磁盘 → autosave → 三选弹窗 → 放弃', async () => {
    const tmp = makeTempUserData();
    seedFakeDsh(tmp.dir);
    seedSettings(tmp.dir);
    seedNotes(tmp.dir);
    const app = await launchApp({ userData: tmp.dir, fakeDshMode: 'ready' });
    const shell = await openNotesView(app);
    await expect(shell.locator('#nt-items .nt-item')).toHaveCount(2, { timeout: 20_000 });
    // 打开 alpha → 编辑器输入（dirty + 2s debounce 计时启动）
    await shell.locator('#nt-items .nt-item', { hasText: 'Alpha 计划' }).click();
    const cm = shell.locator('#nt-editor-body .CodeMirror');
    await expect(cm).toBeVisible();
    await cm.click();
    await shell.keyboard.type('我的本地修改');
    // 外部改磁盘（内容 + mtime 推移）→ 乐观锁 expectedMtime 失配
    await sleep(300);
    const alphaPath = join(tmp.dir, 'notes', 'alpha.md');
    writeFileSync(alphaPath, '---\ntitle: Alpha 计划\n---\n\n外部编辑器写入的内容\n', 'utf8');
    utimesSync(alphaPath, new Date(), new Date(Date.now() + 10_000));
    // debounce ~2s 后 flushSave → notes-conflict-modified → 三选弹窗
    const modal = shell.locator('.nt-modal', { hasText: '保存冲突：文件已被外部修改' });
    await expect(modal).toBeVisible({ timeout: 20_000 });
    // 放弃 → 弹窗关闭，磁盘保持外部版本
    await modal.locator('[data-c="discard"]').click();
    await expect(shell.locator('.nt-modal')).toHaveCount(0);
    await expect.poll(() => readFileSync(alphaPath, 'utf8'), { timeout: 10_000 }).toContain('外部编辑器写入的内容');
    await app.close();
    tmp.cleanup();
  });
});

function ok(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg);
}
