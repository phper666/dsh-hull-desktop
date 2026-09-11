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

  test('「+ 新建目录」→ 选中「工作」→ 只输名称建在选中目录下（notes:mkdir 链路）', async () => {
    const tmp = makeTempUserData();
    seedFakeDsh(tmp.dir);
    seedSettings(tmp.dir);
    seedNotes(tmp.dir);
    const app = await launchApp({ userData: tmp.dir, fakeDshMode: 'ready' });
    const shell = await openNotesView(app);
    await expect(shell.locator('#nt-items .nt-item')).toHaveCount(2, { timeout: 20_000 });
    // ② 交互改版：先选中父目录「工作」→ 新建只填名称 → 建在 工作/ 下
    await shell.locator('#nt-tree .nt-trow[data-dir="工作"]').click();
    await shell.locator('#nt-newdir').click();
    await expect(shell.locator('#nt-newdir-input')).toHaveAttribute('placeholder', /工作\//);
    await shell.locator('#nt-newdir-input').fill('资料库');
    await shell.keyboard.press('Enter');
    // 树出现嵌套新目录行 + 磁盘目录已创建（notes:mkdir 真建目录而非笔记文件）
    await expect(shell.locator('#nt-tree .nt-trow[data-dir="工作/资料库"]')).toBeVisible({ timeout: 20_000 });
    ok(existsSync(join(tmp.dir, 'notes', '工作', '资料库')), '磁盘目录已创建于选中目录下');
    // 名称含 / → UI 拦截（不发起创建）
    await shell.locator('#nt-newdir').click();
    await shell.locator('#nt-newdir-input').fill('a/b');
    await shell.keyboard.press('Enter');
    await expect(shell.locator('#nt-tree .nt-trow[data-dir="工作/a"]')).toHaveCount(0);
    await app.close();
    tmp.cleanup();
  });

  test('双击目录行 → 切换折叠；再双击 → 展开（N3 反馈补充手势）', async () => {
    const tmp = makeTempUserData();
    seedFakeDsh(tmp.dir);
    seedSettings(tmp.dir);
    seedNotes(tmp.dir);
    // 补充种子：工作/ 需含子目录才有折叠语义；经验/ 平铺目录（无子目录）供「双击无折叠语义」断言
    mkdirSync(join(tmp.dir, 'notes', '工作', '子'), { recursive: true });
    mkdirSync(join(tmp.dir, 'notes', '经验'), { recursive: true });
    writeFileSync(join(tmp.dir, 'notes', '工作', '子', 'deep.md'), '---\ntitle: 深层\n---\n\nx\n', 'utf8');
    writeFileSync(join(tmp.dir, 'notes', '经验', 'exp.md'), '---\ntitle: 经验一则\n---\n\nx\n', 'utf8');
    const app = await launchApp({ userData: tmp.dir, fakeDshMode: 'ready' });
    const shell = await openNotesView(app);
    await expect(shell.locator('#nt-items .nt-item')).toHaveCount(4, { timeout: 20_000 }); // 种子 2 + 补种 2
    const kidRows = () => shell.evaluate(() =>
      [...document.querySelectorAll('#nt-tree .nt-trow')].filter((r) => (r as HTMLElement).dataset.dir!.startsWith('工作/')).length);
    // 「工作」有子目录 → 折叠点在；双击行（350ms 内两击）→ 子目录行收起
    await expect(shell.locator('#nt-tree .nt-trow[data-dir="工作/子"]')).toBeVisible({ timeout: 20_000 });
    await shell.locator('#nt-tree .nt-trow[data-dir="工作"]').click();
    await shell.locator('#nt-tree .nt-trow[data-dir="工作"]').click();
    await shell.waitForTimeout(200);
    ok(await kidRows() === 0, '双击折叠后「工作/」子行数应为 0');
    // 再双击 → 展开
    await shell.locator('#nt-tree .nt-trow[data-dir="工作"]').click();
    await shell.locator('#nt-tree .nt-trow[data-dir="工作"]').click();
    await shell.waitForTimeout(200);
    ok((await kidRows()) >= 1, '再双击后「工作/」子行数应 ≥1');
    // 平铺目录（经验 无子目录）双击：无折叠语义，行保持可见
    await shell.locator('#nt-tree .nt-trow[data-dir="经验"]').click();
    await shell.locator('#nt-tree .nt-trow[data-dir="经验"]').click();
    await shell.waitForTimeout(150);
    await expect(shell.locator('#nt-tree .nt-trow[data-dir="经验"]')).toBeVisible();
    await app.close();
    tmp.cleanup();
  });

  test('根节点「全部笔记」折叠/展开（chevron 真实点击 + 双击两条路径）', async () => {
    const tmp = makeTempUserData();
    seedFakeDsh(tmp.dir);
    seedSettings(tmp.dir);
    seedNotes(tmp.dir);
    const app = await launchApp({ userData: tmp.dir, fakeDshMode: 'ready' });
    const shell = await openNotesView(app);
    await expect(shell.locator('#nt-items .nt-item')).toHaveCount(2, { timeout: 20_000 });
    const root = shell.locator('#nt-tree .nt-trow[data-dir=""]');
    const rowCount = () => shell.evaluate(() => document.querySelectorAll('#nt-tree .nt-trow').length);
    // 展开态：根行 + 工作 + 经验 = 3 行
    await expect(shell.locator('#nt-tree .nt-trow')).toHaveCount(3, { timeout: 20_000 });
    // 路径 ①：真实点击根 chevron → 所有一级目录行消失（根行保留）
    await root.locator('.nt-chev').click();
    await shell.waitForTimeout(200);
    ok(await rowCount() === 1, `折叠后树行数应为 1（仅根行），实际 ${await rowCount()}`);
    await shell.screenshot({ path: '/tmp/notes-root-collapsed.png' });
    // 再点 → 恢复
    await root.locator('.nt-chev').click();
    await shell.waitForTimeout(200);
    const dirsAfterExpand = await shell.evaluate(() => [...document.querySelectorAll('#nt-tree .nt-trow')].map((r) => (r as HTMLElement).dataset.dir));
    ok(await rowCount() === 2 && dirsAfterExpand.join(',') === ',工作', `展开后应为 [根,工作]，实际 ${JSON.stringify(dirsAfterExpand)}`);
    // 路径 ②：双击根行（350ms 内两击）→ 折叠
    await root.click();
    await root.click();
    await shell.waitForTimeout(200);
    ok(await rowCount() === 1, `双击折叠后树行数应为 1，实际 ${await rowCount()}`);
    // 双击 → 展开
    await root.click();
    await root.click();
    await shell.waitForTimeout(200);
    const dirsAfterDblExpand = await shell.evaluate(() => [...document.querySelectorAll('#nt-tree .nt-trow')].map((r) => (r as HTMLElement).dataset.dir));
    ok(await rowCount() === 2 && dirsAfterDblExpand.join(',') === ',工作', `双击展开后应为 [根,工作]，实际 ${JSON.stringify(dirsAfterDblExpand)}`);
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
