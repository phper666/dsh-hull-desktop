/**
 * B5 e2e —— 备份/恢复（设计 §7.3 表 + 验收②④）：
 * happy（replace：备份→改数据→请求恢复→重启→断言）/ 高版本拒绝（DOM 提示）/ 半成品自愈（崩溃后二次启动）/
 * merge（冲突清单非空 + 双方数据可检索）。
 * 约定：HULL_E2E=1（helpers.launchApp 默认）显式传 targetDir/sourceDir 绕过原生 dialog（CON-R-backup-009/014）；
 * 断言 DOM（数据卡结果）+ 文件系统（manifest/result.json/settings 值）。
 */
import { test, expect, type ElectronApplication } from '@playwright/test';
import { existsSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import { BACKUP_SCOPE } from '../../src/backup/scope';
import {
  cleanupTempDirs,
  listTree,
  mkTemp,
  readJson,
  seedFixture,
  writePackage,
  writeJson,
} from '../integration/backup/_helpers';

import { launchApp, makeTempUserData, openSettings, seedFakeDsh, seedSettings, sleep, waitForReady } from './helpers';

test.afterAll(() => cleanupTempDirs());

const ALL_ITEM_IDS = ['kanban', 'notes', 'notes-trash', 'notifs', 'settings', 'skills', 'workflows'];

/** 优雅退出（__hullTest.quit → quitOrchestration；finally 复用，防 dsh 子进程残留） */
async function quitApp(app: ElectronApplication): Promise<void> {
  await app.evaluate(() => (globalThis as { __hullTest?: { quit(): void } }).__hullTest?.quit());
  await app.waitForEvent('close');
}

async function closeAppQuietly(app: ElectronApplication): Promise<void> {
  try {
    await quitApp(app);
  } catch {
    /* 已退出/不可达 */
  }
  try {
    await app.close();
  } catch {
    /* 已退出 */
  }
}

/** 等 app 进程退出（崩溃窗口：process.exit(86)）；返回 exitCode（拿不到 → null） */
async function waitForAppExit(app: ElectronApplication, timeoutMs = 30_000): Promise<number | null> {
  let closed = false;
  app.on('close', () => {
    closed = true;
  });
  const exitCodeOf = (): number | null => {
    try {
      return app.process().exitCode;
    } catch {
      return null;
    }
  };
  const deadline = Date.now() + timeoutMs;
  while (!closed && Date.now() < deadline) {
    if (exitCodeOf() !== null) break;
    await sleep(200);
  }
  try {
    await app.close();
  } catch {
    /* 已退出 */
  }
  return exitCodeOf();
}

async function waitTheme(userData: string, theme: string, timeoutMs = 10_000): Promise<void> {
  const file = join(userData, 'settings.json');
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if ((JSON.parse(readFileSync(file, 'utf8')) as { theme?: string }).theme === theme) return;
    } catch {
      /* 文件暂不可读 */
    }
    await sleep(100);
  }
  throw new Error(`settings.json theme 未在 ${timeoutMs}ms 内变为 ${theme}`);
}

test.describe('B5 备份/恢复', () => {
  test('happy（replace）：备份→改数据→请求恢复→重启→settings 复原 + result 成功 + DOM 数据卡（验收①②④）', async () => {
    test.setTimeout(180_000);
    const tmp = makeTempUserData();
    const pkgParent = makeTempUserData();
    let app: ElectronApplication | null = null;
    try {
      seedFakeDsh(tmp.dir);
      seedFixture(tmp.dir, {
        extras: { 'token-buckets.json': '{"tokens":1}', 'Cache/blob': 'cache' }, // 排除项反例
      });
      seedSettings(tmp.dir, { theme: 'light' });

      // ── 启动 1：备份（真 IPC → 真包） ──
      app = await launchApp({ userData: tmp.dir });
      const shell = await waitForReady(app);
      const r = await shell.evaluate(
        (target: string) => (window as unknown as { hull: { backup(p: unknown): Promise<any> } }).hull.backup({ action: 'run', targetDir: target }),
        pkgParent.dir,
      );
      expect(r.ok, JSON.stringify(r)).toBe(true);
      const backupDir = r.data.backupDir as string;

      // 验收①：目标目录含 7 项 + manifest，不含 dsh/Cache/token-buckets
      const manifest = readJson<{ items: Array<{ id: string }>; counts: { files: number } }>(
        join(backupDir, 'manifest.json'),
      );
      expect(manifest.items.map((i) => i.id).sort()).toEqual(ALL_ITEM_IDS);
      expect(manifest.items.length).toBe(BACKUP_SCOPE.length);
      const rels = listTree(backupDir);
      expect(rels.some((p) => p.startsWith('dsh/'))).toBe(false);
      expect(rels).not.toContain('token-buckets.json');
      expect(rels.some((p) => p.startsWith('Cache/'))).toBe(false);

      // ── 改现数据（settings.theme light → dark） ──
      await shell.evaluate(() => (window as unknown as { hull: { setSettings(p: unknown): Promise<unknown> } }).hull.setSettings({ theme: 'dark' }));
      await waitTheme(tmp.dir, 'dark');

      // ── 请求恢复（replace，显式 sourceDir 绕过原生 dialog） ──
      const req = await shell.evaluate(
        (src: string) =>
          (window as unknown as { hull: { restore(p: unknown): Promise<any> } }).hull.restore({
            action: 'request',
            mode: 'replace',
            sourceDir: src,
          }),
        backupDir,
      );
      expect(req.ok, JSON.stringify(req)).toBe(true);
      expect(existsSync(join(tmp.dir, '.restore', 'pending.json'))).toBe(true);

      await quitApp(app);
      app = null;

      // ── 启动 2：启动早期执行恢复 ──
      app = await launchApp({ userData: tmp.dir });
      const shell2 = await waitForReady(app);

      // 验收④：result.json status 正确（R3：bakDir 指向归档 backup-<ts>）
      const result = readJson<{ status: string; mode: string; bakDir: string | null }>(
        join(tmp.dir, '.restore', 'result.json'),
      );
      expect(result.status).toBe('success');
      expect(result.mode).toBe('replace');

      // 验收②：settings = 包内（theme light）、.restore/backup 已归档（人工兜底）
      expect((JSON.parse(readFileSync(join(tmp.dir, 'settings.json'), 'utf8')) as { theme: string }).theme).toBe('light');
      expect(result.bakDir).toBeTruthy();
      expect(existsSync(join(result.bakDir!, 'settings.json'))).toBe(true);
      expect((JSON.parse(readFileSync(join(result.bakDir!, 'settings.json'), 'utf8')) as { theme: string }).theme).toBe('dark');
      expect(existsSync(join(tmp.dir, '.restore', 'backup'))).toBe(false);
      expect(existsSync(join(tmp.dir, '.restore', 'pending.json'))).toBe(false);

      // DOM：数据卡展示最近一次结果（成功）
      const settings = await openSettings(app);
      await expect(settings.locator('#backup-result')).toBeVisible();
      await expect(settings.locator('#backup-result-badge')).toContainText('成功');
      await expect(settings.locator('#backup-result-body')).toContainText('原数据备份');
    } finally {
      if (app) await closeAppQuietly(app);
      tmp.cleanup();
      pkgParent.cleanup();
    }
  });

  test('高版本拒绝：restore-version-newer + DOM 提示 + 无 pending', async () => {
    const tmp = makeTempUserData();
    const pkg = mkTemp('hull-e2e-pkg-');
    let app: ElectronApplication | null = null;
    try {
      seedFakeDsh(tmp.dir);
      seedFixture(tmp.dir);
      seedSettings(tmp.dir, { theme: 'light' });
      // 手写 manifestVersion=2 包（结构合法 → 命中兼容性拒绝）
      writePackage(pkg, { settings: { theme: 'dark', notesDir: join(pkg, 'notes') } });
      const mfPath = join(pkg, 'manifest.json');
      writeJson(mfPath, { ...readJson<Record<string, unknown>>(mfPath), manifestVersion: 2 });

      app = await launchApp({ userData: tmp.dir });
      await waitForReady(app);
      const shell = await openSettings(app);

      // 原生 dialog 无法 Playwright 驱动：主进程侧替换 showOpenDialog 返回包目录（点击走真实 renderer → IPC 链路）
      const patched = await app.evaluate(({ dialog }, dir) => {
        const d = dialog as unknown as { showOpenDialog: unknown };
        const prev = d.showOpenDialog;
        d.showOpenDialog = async () => ({ canceled: false, filePaths: [dir] });
        return d.showOpenDialog !== prev;
      }, pkg);
      console.log(`[backup-e2e] dialog.showOpenDialog patch=${patched}`);

      if (patched) {
        await shell.click('#restore-run');
        await expect(shell.locator('#backup-alert')).toHaveClass(/show/, { timeout: 15_000 });
        await expect(shell.locator('#backup-alert')).toContainText('版本高于当前 Hull');
      } else {
        // 兜底：dialog 不可替换 → 直接桥调用（DOM 断言跳过，记录）
        const r = await shell.evaluate(
          (src: string) =>
            (window as unknown as { hull: { restore(p: unknown): Promise<any> } }).hull.restore({
              action: 'request',
              mode: 'replace',
              sourceDir: src,
            }),
          pkg,
        );
        expect(r.ok).toBe(false);
        expect(r.code).toBe('restore-version-newer');
        console.log('[backup-e2e] dialog.showOpenDialog 不可替换：DOM 提示断言跳过（桥调用已验码）');
      }

      // FS：无 pending；现数据（settings.theme）不变
      expect(existsSync(join(tmp.dir, '.restore', 'pending.json'))).toBe(false);
      expect((JSON.parse(readFileSync(join(tmp.dir, 'settings.json'), 'utf8')) as { theme: string }).theme).toBe('light');
    } finally {
      if (app) await closeAppQuietly(app);
      tmp.cleanup();
    }
  });

  test('半成品自愈：restore-after-stage 崩溃 + 包移走 → 二次启动 O7 本地副本完成恢复（success + 数据落位）', async () => {
    test.setTimeout(180_000);
    const tmp = makeTempUserData();
    const pkg = mkTemp('hull-e2e-pkg-');
    let app: ElectronApplication | null = null;
    try {
      seedFakeDsh(tmp.dir);
      seedFixture(tmp.dir, { notes: { 'keep.md': '# keep' } });
      seedSettings(tmp.dir, { theme: 'light' });
      writePackage(pkg, { settings: { theme: 'dark', notesDir: join(pkg, 'notes') }, notes: { 'pkg.md': '# pkg' } });

      // ── 启动 1：请求恢复（下次启动执行） ──
      app = await launchApp({ userData: tmp.dir });
      const shell = await waitForReady(app);
      const req = await shell.evaluate(
        (src: string) =>
          (window as unknown as { hull: { restore(p: unknown): Promise<any> } }).hull.restore({
            action: 'request',
            mode: 'replace',
            sourceDir: src,
          }),
        pkg,
      );
      expect(req.ok, JSON.stringify(req)).toBe(true);
      await quitApp(app);
      app = null;

      // ── 启动 2：HULL_E2E_FAIL_AT=restore-after-stage:exit → 制造崩溃窗口（staged 后退出） ──
      let exitCode: number | null = null;
      try {
        const crashed = await launchApp({
          userData: tmp.dir,
          env: { HULL_E2E_FAIL_AT: 'restore-after-stage:exit' },
        });
        exitCode = await waitForAppExit(crashed);
      } catch {
        // app 可能在 Playwright attach 前已退出（启动最早期执行恢复）——按崩溃处理
      }
      console.log(`[backup-e2e] crash exitCode=${String(exitCode)}`);
      expect(existsSync(join(tmp.dir, '.restore', 'incoming')), '崩溃窗口应留下 staged incoming').toBe(true);
      if (exitCode !== null) expect(exitCode, 'process.exit(86) 崩溃码').toBe(86);

      // 源包不可用（外部盘拔除语义）→ O7：incoming + 本地 manifest 副本已足够完成恢复（不再依赖包目录）
      rmSync(pkg, { recursive: true, force: true });

      // ── 启动 3：启动期续做 → success + 包内容落位 + 本地旧数据进归档 ──
      app = await launchApp({ userData: tmp.dir });
      await waitForReady(app);

      const result = readJson<{ status: string; bakDir: string | null }>(join(tmp.dir, '.restore', 'result.json'));
      expect(result.status).toBe('success');
      expect(existsSync(join(tmp.dir, '.restore', 'pending.json'))).toBe(false);
      expect(readFileSync(join(tmp.dir, 'notes', 'pkg.md'), 'utf8')).toBe('# pkg');
      expect(existsSync(join(tmp.dir, 'notes', 'keep.md'))).toBe(false);
      expect((JSON.parse(readFileSync(join(tmp.dir, 'settings.json'), 'utf8')) as { theme: string }).theme).toBe('dark');
      expect(result.bakDir).toBeTruthy();
      expect(readFileSync(join(result.bakDir!, 'notes', 'keep.md'), 'utf8')).toBe('# keep');
      expect(existsSync(join(tmp.dir, '.restore', 'backup'))).toBe(false);

      // DOM：结果卡展示「成功」
      const settings = await openSettings(app);
      await expect(settings.locator('#backup-result')).toBeVisible();
      await expect(settings.locator('#backup-result-badge')).toContainText('成功');
    } finally {
      if (app) await closeAppQuietly(app);
      tmp.cleanup();
    }
  });

  test('merge：同 id 工作流 + 同名笔记冲突 → 双方数据都在 + conflicts 非空 + DOM 合并冲突（验收⑤）', async () => {
    test.setTimeout(180_000);
    const tmp = makeTempUserData();
    const pkg = mkTemp('hull-e2e-pkg-');
    let app: ElectronApplication | null = null;
    try {
      seedFakeDsh(tmp.dir);
      seedFixture(tmp.dir, {
        notes: { 'a.md': '# local' },
        workflows: { version: 1, workflows: [{ id: 'wf_shared', name: '本地流', steps: [] }] },
      });
      seedSettings(tmp.dir, { theme: 'light' });
      writePackage(pkg, {
        settings: { theme: 'dark', notesDir: join(pkg, 'notes') },
        notes: { 'a.md': '# pkg' },
        workflows: { version: 1, workflows: [{ id: 'wf_shared', name: '包内流', steps: [] }] },
      });

      app = await launchApp({ userData: tmp.dir });
      const shell = await waitForReady(app);
      const req = await shell.evaluate(
        (src: string) =>
          (window as unknown as { hull: { restore(p: unknown): Promise<any> } }).hull.restore({
            action: 'request',
            mode: 'merge',
            sourceDir: src,
          }),
        pkg,
      );
      expect(req.ok, JSON.stringify(req)).toBe(true);
      await quitApp(app);
      app = null;

      app = await launchApp({ userData: tmp.dir });
      await waitForReady(app);

      // 笔记：本地原名 + 包内改名双份
      const mdFiles = readdirSync(join(tmp.dir, 'notes')).filter((n) => n.endsWith('.md'));
      expect(mdFiles).toContain('a.md');
      expect(readFileSync(join(tmp.dir, 'notes', 'a.md'), 'utf8')).toBe('# local');
      const conflictName = mdFiles.find((n) => n !== 'a.md');
      expect(conflictName).toMatch(/恢复冲突/);
      expect(readFileSync(join(tmp.dir, 'notes', conflictName!), 'utf8')).toBe('# pkg');
      // 工作流：id 冲突重生，两条都在
      const workflows = readJson<{ workflows: Array<{ id: string }> }>(
        join(tmp.dir, 'workflows', 'workflows.json'),
      );
      expect(workflows.workflows.length).toBe(2);
      expect(new Set(workflows.workflows.map((w) => w.id)).size).toBe(2);
      // result：merge 报告 + 冲突清单非空
      const result = readJson<{ status: string; merge: { conflicts: Array<{ kind: string }> } | null }>(
        join(tmp.dir, '.restore', 'result.json'),
      );
      expect(result.status).toBe('success');
      expect(result.merge?.conflicts.length ?? 0).toBeGreaterThan(0);
      expect(result.merge?.conflicts.some((c) => c.kind === 'note')).toBe(true);

      // DOM：结果卡展示合并冲突
      const settings = await openSettings(app);
      await expect(settings.locator('#backup-result')).toBeVisible();
      await expect(settings.locator('#backup-result-badge')).toContainText('成功');
      await expect(settings.locator('#backup-result-body')).toContainText('合并冲突');
    } finally {
      if (app) await closeAppQuietly(app);
      tmp.cleanup();
    }
  });

  /**
   * 门控（设计 §7.3 表末行 / 契约联调「备份门控」）：存在执行中/排队任务 → 置灰 + 原因 + backup-busy。
   *
   * 注入路径说明（评审认可的 e2e 兜底）：真实执行驱动不可行——HULL_EXEC_PROVIDER=mock 的 MockProvider
   * 0 延迟瞬时完成；预置 queued 任务走 ACP 真实握手，running 窗口 = 15s 握手超时（与启动耗时竞态，不稳定）。
   * 故经 HULL_E2E_FORCE_GATE=backup-busy（仅 HULL_E2E=1 生效）让 gateDeps.hasRunningExecutions 报告 busy。
   * 本用例覆盖「门控 → status 载荷 → DOM 置灰/原因 → 主进程强制拒绝」接线与呈现；
   * 真实 canBackup 判定（running/queued 快照）由 src/backup/gate.test.ts + backupService.test.ts 单测覆盖。
   */
  test('门控：存在执行中/排队任务 → 备份按钮置灰 + 原因提示 + backup-busy（设计 §7.3 门控行）', async () => {
    const tmp = makeTempUserData();
    const target = join(tmp.dir, 'backup-target'); // 不存在 → 门控拒绝时断言零写入
    let app: ElectronApplication | null = null;
    try {
      seedFakeDsh(tmp.dir);
      seedSettings(tmp.dir, { theme: 'light' });

      app = await launchApp({ userData: tmp.dir, env: { HULL_E2E_FORCE_GATE: 'backup-busy' } });
      const shell = await waitForReady(app);

      // ① hull:getBackupStatus：canBackup 拒绝且码为 backup-busy（canRestore 不受执行影响，不置 busy）
      const st = await shell.evaluate(() =>
        (window as unknown as { hull: { getBackupStatus(): Promise<any> } }).hull.getBackupStatus(),
      );
      expect(st.ok, JSON.stringify(st)).toBe(true);
      expect(st.data.canBackup.ok).toBe(false);
      expect(st.data.canBackup.code).toBe('backup-busy');

      // ② DOM：数据卡备份按钮置灰 + 原因文案可见
      const settings = await openSettings(app);
      await expect(settings.locator('#backup-run')).toBeDisabled();
      await expect(settings.locator('#backup-gate-hint')).toBeVisible();
      await expect(settings.locator('#backup-gate-hint')).toContainText('有执行中或排队的任务');

      // ③ 按钮 disabled 不可点（DOM 层拦截）；等价桥直调验证主进程强制门控（CON-R-backup-005）+ 零写入
      const r = await shell.evaluate(
        (t: string) =>
          (window as unknown as { hull: { backup(p: unknown): Promise<any> } }).hull.backup({ action: 'run', targetDir: t }),
        target,
      );
      expect(r.ok, JSON.stringify(r)).toBe(false);
      expect(r.code).toBe('backup-busy');
      expect(existsSync(target)).toBe(false);
    } finally {
      if (app) await closeAppQuietly(app);
      tmp.cleanup();
    }
  });
});
