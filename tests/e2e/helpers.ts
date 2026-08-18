/**
 * e2e 公共助手（S7 + S8 R1）：临时 userData 隔离（CON-R002 精神）+ fake dsh overlay 种子 + 启动 + 就绪等待 + 假 registry。
 * S8 窗口定位重构：主窗口 = 壳框架（BrowserWindow 加载 shell.html），官方 UI = WebContentsView（独立 webContents）。
 * 定位约定（URL 定位）：shellPage（file://…shell.html）/ officialPage（http://127.0.0.1: 前缀，Playwright 暴露探测 R2）。
 * 约定：HULL_USER_DATA（userData 覆盖）、HULL_E2E（测试钩子开关）、FAKE_DSH_MODE（fake dsh 行为）、
 *       HULL_REGISTRY（registry 源）——均为 main 侧已支持的注入点。
 */
import { _electron, type ElectronApplication, type Page } from '@playwright/test';
import { execSync, spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

export const PROJECT_ROOT = resolve(__dirname, '..', '..');
export const FAKE_DSH = join(PROJECT_ROOT, 'tests', 'fixtures', 'fake-dsh.js');

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export interface TempUserData {
  dir: string;
  cleanup(): void;
}

export function makeTempUserData(): TempUserData {
  const dir = mkdtempSync(join(tmpdir(), 'hull-e2e-'));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/** 种子 fake dsh overlay（结构对齐真实 npm 安装：bin/dsh → node_modules/.bin/dsh → @deepseek-ai/dsh/lib/bin.js；
 *  回滚后 createBinSymlink 重写 bin/dsh 指向 node_modules/.bin/dsh，缺该链则回滚后 spawn 失败） */
export function seedFakeDsh(userData: string, version = '0.1.0-rc.7'): void {
  const dshDir = join(userData, 'dsh');
  const pkgDir = join(dshDir, 'node_modules', '@deepseek-ai', 'dsh');
  mkdirSync(join(pkgDir, 'lib'), { recursive: true });
  mkdirSync(join(dshDir, 'bin'), { recursive: true });
  mkdirSync(join(dshDir, 'node_modules', '.bin'), { recursive: true });
  writeFileSync(join(pkgDir, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version, bin: { dsh: 'lib/bin.js' } }, null, 2));
  writeFileSync(join(pkgDir, 'lib', 'bin.js'), readFileSync(FAKE_DSH, 'utf8'));
  symlinkSync(join(pkgDir, 'lib', 'bin.js'), join(dshDir, 'node_modules', '.bin', 'dsh'));
  symlinkSync(join(dshDir, 'node_modules', '.bin', 'dsh'), join(dshDir, 'bin', 'dsh'));
}

/** 种子 settings.json（默认关自动检查——防启动自动检查弹原生 dialog 干扰 e2e；registry 可覆盖） */
export function seedSettings(userData: string, partial: Record<string, unknown> = {}): void {
  const defaults = {
    closeToQuit: false,
    schemaVersion: 3,
    channel: 'latest',
    pinnedVersion: null,
    autoCheckDsh: false,
    autoCheckHull: false,
    registry: 'https://registry.npmjs.org',
  };
  writeFileSync(join(userData, 'settings.json'), JSON.stringify({ ...defaults, ...partial }, null, 2));
}

export interface LaunchOptions {
  userData: string;
  fakeDshMode?: string;
  registry?: string;
  env?: Record<string, string>;
}

export async function launchApp(opts: LaunchOptions): Promise<ElectronApplication> {
  const env: Record<string, string> = { ...(process.env as Record<string, string>) };
  env.HULL_USER_DATA = opts.userData;
  env.HULL_E2E = '1';
  env.FAKE_DSH_MODE = opts.fakeDshMode ?? 'ready';
  if (opts.registry) env.HULL_REGISTRY = opts.registry;
  Object.assign(env, opts.env);
  return _electron.launch({
    args: ['.'],
    cwd: PROJECT_ROOT,
    env,
  });
}

/** 官方 UI URL（S8：官方 UI 在 WebContentsView 的 webContents，非 BrowserWindow——
 *  经 webContents.getAllWebContents() 按 http://127.0.0.1: 前缀定位；壳页/settings 均 file:// 可排除）。
 *  语义与旧 mainWindowUrl 一致：官方 UI 当前导航地址（未加载 → 空串） */
export async function mainWindowUrl(app: ElectronApplication): Promise<string> {
  return app.evaluate(({ webContents }) => {
    const wc = webContents.getAllWebContents().find((w) => w.getURL().startsWith('http://127.0.0.1:'));
    return wc?.getURL() ?? '';
  });
}

/** 壳框架 page（file://…shell.html；主 BrowserWindow 承载——nav + 占位区块；未就绪 → null） */
export function shellPage(app: ElectronApplication): Page | null {
  return app.windows().find((w) => w.url().includes('shell.html')) ?? null;
}

/** 官方 UI page（R2 探测：Playwright 对 WebContentsView page 暴露；未暴露 → null，断言走主进程兜底） */
export function officialPage(app: ElectronApplication): Page | null {
  return app.windows().find((w) => w.url().startsWith('http://127.0.0.1:')) ?? null;
}

/** 官方 view 状态（R2 兜底：主进程侧断言 view.webContents.getURL/getVisible，经 __hullTest hook） */
export async function officialViewState(
  app: ElectronApplication
): Promise<{ url: string; visible: boolean }> {
  return app.evaluate(() => {
    const h = (globalThis as { __hullTest?: { officialView(): { url: string; visible: boolean } } }).__hullTest;
    return h?.officialView() ?? { url: '', visible: false };
  });
}

/** 关闭主窗口（按 URL 排除 settings.html 定位；closeToQuit 语义测试用） */
export async function closeMainWindow(app: ElectronApplication): Promise<void> {
  await app.evaluate(({ BrowserWindow }) => {
    const wins = BrowserWindow.getAllWindows();
    const main = wins.find((w) => !w.webContents.getURL().includes('settings.html')) ?? wins[0];
    main?.close();
  });
}

/** 主窗口可见性（按 URL 排除 settings.html 定位） */
export async function mainWindowVisible(app: ElectronApplication): Promise<boolean> {
  return app.evaluate(({ BrowserWindow }) => {
    const wins = BrowserWindow.getAllWindows();
    const main = wins.find((w) => !w.webContents.getURL().includes('settings.html')) ?? wins[0];
    return main?.isVisible() ?? false;
  });
}

/** 等待官方 UI 就绪：官方 view URL 为 http://127.0.0.1: 且 HTTP 响应 body=ok（真实可交互信号）；返回壳页 page */
export async function waitForReady(app: ElectronApplication, timeoutMs = 30_000): Promise<Page> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const url = await mainWindowUrl(app);
    if (url.startsWith('http://127.0.0.1:')) {
      try {
        const res = await fetch(url);
        if ((await res.text()) === 'ok') {
          const shell = shellPage(app);
          if (shell) return shell;
        }
      } catch {
        /* 服务未就绪 */
      }
    }
    await sleep(200);
  }
  throw new Error(`官方 UI 未在 ${timeoutMs}ms 内就绪（URL 非 http://127.0.0.1: 或 body≠ok）`);
}

/** 等待官方 UI 内容恢复可交互（body=ok；升级/回滚后新 dsh 服务就绪判定） */
export async function waitForOkPage(app: ElectronApplication, timeoutMs = 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const url = await mainWindowUrl(app);
    if (url.startsWith('http://127.0.0.1:')) {
      try {
        const res = await fetch(url);
        if ((await res.text()) === 'ok') return;
      } catch {
        /* 服务未就绪（旧 dsh 已停/新 dsh 启动中） */
      }
    }
    await sleep(200);
  }
  throw new Error(`官方 UI 未在 ${timeoutMs}ms 内恢复可交互（body=ok）`);
}

/** 等待壳框架 page 出现（launch 后窗口在 whenReady+ensure 后创建，非即时；URL 定位 shell.html） */
export async function waitForMainWindow(app: ElectronApplication, timeoutMs = 30_000): Promise<Page> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const p = shellPage(app);
    if (p) return p;
    await sleep(200);
  }
  throw new Error(`壳窗口未在 ${timeoutMs}ms 内创建`);
}

/** 壳 nav 状态区快照（hull:status 渲染结果：phase/version/upgrade；未就绪 → null） */
export async function navStatus(
  app: ElectronApplication
): Promise<{ phase: string; version: string; upgrade: string } | null> {
  const shell = shellPage(app);
  if (!shell) return null;
  try {
    return await shell.evaluate(() => {
      // tsconfig.tests.json 无 DOM lib：最小 DOM 接口内联（evaluate 在 renderer 运行，运行时 DOM 可用）
      interface MinEl {
        textContent: string | null;
      }
      const doc = (globalThis as unknown as { document: { getElementById(id: string): MinEl | null } }).document;
      const t = (id: string) => doc.getElementById(id)?.textContent ?? '';
      return { phase: t('status-phase'), version: t('status-version'), upgrade: t('status-upgrade') };
    });
  } catch {
    return null; // 页面导航中
  }
}

/** 设置页 page（按 URL 含 settings.html 定位；未打开 → null） */
export function settingsPage(app: ElectronApplication): Page | null {
  return app.windows().find((w) => w.url().includes('settings.html')) ?? null;
}

export async function openSettings(app: ElectronApplication): Promise<Page> {
  await app.evaluate(() => (globalThis as { __hullTest?: { openSettings(): void } }).__hullTest?.openSettings());
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const p = settingsPage(app);
    if (p) return p;
    await sleep(200);
  }
  throw new Error('设置页未在 10s 内打开');
}

/** 假 registry（tests/fixtures/fake-registry.js 子进程） */
export interface FakeRegistry {
  url: string;
  port: number;
  close(): Promise<void>;
}

export function startFakeRegistry(opts: { latest?: string; tarballDelayMs?: number } = {}): Promise<FakeRegistry> {
  return new Promise((resolve, reject) => {
    const child: ChildProcess = spawn(process.execPath, [join(PROJECT_ROOT, 'tests', 'fixtures', 'fake-registry.js')], {
      env: {
        ...(process.env as Record<string, string>),
        FAKE_REGISTRY_LATEST: opts.latest ?? '9.9.9',
        ...(opts.tarballDelayMs !== undefined ? { FAKE_REGISTRY_TARBALL_DELAY_MS: String(opts.tarballDelayMs) } : {}),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let buf = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('fake-registry 启动超时'));
    }, 10_000);
    child.stdout?.on('data', (c: Buffer) => {
      buf += c.toString();
      const m = /listening on (\d+)/.exec(buf);
      if (m) {
        clearTimeout(timer);
        const port = Number(m[1]);
        resolve({
          url: `http://127.0.0.1:${port}`,
          port,
          close: () =>
            new Promise<void>((r) => {
              if (child.exitCode !== null) return r();
              child.on('exit', () => r());
              child.kill('SIGTERM');
            }),
        });
      }
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`fake-registry 提前退出 code=${code}`));
    });
  });
}

/** 等待假 registry 收到 ≥min 次 manifest 请求（S8：验证「升级入口触发检查」——原生 dialog 不可 Playwright 驱动） */
export async function waitForRegistryHits(reg: FakeRegistry, min: number, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${reg.url}/__hits`);
      if (Number(await res.text()) >= min) return;
    } catch {
      /* registry 未就绪 */
    }
    await sleep(200);
  }
  throw new Error(`registry 未在 ${timeoutMs}ms 内收到 ${min} 次 manifest 请求`);
}

/** 托盘菜单项（label + enabled 快照；原生菜单 Playwright 无法点击，读状态校验禁用逻辑） */
export async function trayMenuItems(app: ElectronApplication): Promise<Array<{ label: string; enabled: boolean }>> {
  return app.evaluate(() => {
    const m = (globalThis as { __hullTest?: { trayMenu(): { items: Array<{ label: string; enabled: boolean }> } | null } })
      .__hullTest?.trayMenu();
    return m ? m.items.map((i) => ({ label: i.label, enabled: i.enabled })) : [];
  });
}

/** 轮询托盘菜单项 enabled 状态（升级中禁用校验） */
export async function waitForTrayItemEnabled(
  app: ElectronApplication,
  label: string,
  enabled: boolean,
  timeoutMs = 30_000
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const items = await trayMenuItems(app);
    const item = items.find((i) => i.label === label);
    if (item && item.enabled === enabled) return;
    await sleep(200);
  }
  throw new Error(`托盘菜单项 "${label}" 未在 ${timeoutMs}ms 内变为 ${enabled ? '启用' : '禁用'}`);
}

/** ps 全量命令行（残留进程检测） */
export function psCommandLines(): string[] {
  return execSync('ps -axo command', { encoding: 'utf8' }).split('\n');
}

/** 轮询 dsh 生效版本（<userData>/dsh 包 version；升级/回滚完成判定） */
export async function waitForDshVersion(userData: string, version: string, timeoutMs = 60_000): Promise<void> {
  const pkgPath = join(userData, 'dsh', 'node_modules', '@deepseek-ai', 'dsh', 'package.json');
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { version?: unknown };
      if (pkg.version === version) return;
    } catch {
      /* 文件暂不可读（swap 中） */
    }
    await sleep(200);
  }
  throw new Error(`dsh 版本未在 ${timeoutMs}ms 内变为 ${version}`);
}

/** 轮询 settings.json 落盘值（registry 持久化校验） */
export async function waitForSettingsRegistry(userData: string, registry: string, timeoutMs = 10_000): Promise<void> {
  const file = join(userData, 'settings.json');
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const s = JSON.parse(readFileSync(file, 'utf8')) as { registry?: unknown };
      if (s.registry === registry) return;
    } catch {
      /* 文件暂不可读 */
    }
    await sleep(200);
  }
  throw new Error(`settings.json registry 未在 ${timeoutMs}ms 内变为 ${registry}`);
}