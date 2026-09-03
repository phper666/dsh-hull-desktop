import { app, clipboard, dialog, ipcMain, nativeTheme, safeStorage, shell } from 'electron';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, unlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';

import { acquireSingleInstanceLock } from '../runtime/SingleInstance';
import { RuntimeManager, type CrashInfo } from '../runtime/RuntimeManager';
import { matchesDshSignature } from '../runtime/spawnArgs';
import { DshMissingError, HullError } from '../shared/errors';
import { HullUpdatePhase, InstallPhase, RuntimePhase, UpgradePhase } from '../shared/types';
import { OverlayManager } from '../overlay/OverlayManager';
import { InstallFlow } from '../overlay/InstallFlow';
import { extractBundledNode, isNodeExtracted } from '../overlay/extractNode';
import { createPkgMgrRunner, toRunNpmInstall, type PkgMgrRunOptions, type PkgMgrRunner } from '../overlay/pkgMgr';
import { Updater } from '../updater/Updater';
import { registerTokenUsageIpc } from '../tokens/TokenUsageIpc';
import { registerConnectionsIpc } from '../connections/ConnectionsIpc';
import { registerWorkflowIpc } from '../workflows/WorkflowIpc';
import { WorkflowEngine } from '../workflows/WorkflowEngine';
import { WorkflowScheduler } from '../workflows/WorkflowScheduler';
import { WorkflowStore } from '../workflows/WorkflowStore';
import { invokeConnectionAction } from '../connections/Actions';
import { scanAllSources } from '../tokens/TokenUsageScanner';
import { summarize } from '../tokens/aggregator';
import { Notification } from 'electron';
import { ConnectionsStore } from '../connections/ConnectionsStore';
import { PLATFORM_ADAPTERS } from '../connections/PlatformRegistry';
import { SwapManager } from '../updater/SwapManager';
import { UpgradeQueue } from '../updater/UpgradeQueue';
import { DismissStore } from '../updater/DismissStore';
import { HullUpdater } from '../updater/HullUpdater';
import { createElectronUpdaterAdapter } from '../updater/electronUpdaterAdapter';
import { checkLatestVersion } from '../updater/registry';
import { WindowManager } from '../window/WindowManager';
import { TrayController } from '../tray/TrayController';
import { SettingsProvider } from '../settings/SettingsProvider';
import { ChannelService } from '../channel/ChannelService';
import { KanbanStore } from '../kanban/KanbanStore';
import { registerKanbanIpc } from '../kanban/KanbanIpc';
import { ExecutionEngine } from '../exec/ExecutionEngine';
import { ACPProvider } from '../exec/provider/ACPProvider';
import { ProviderManager } from '../exec/provider/ProviderManager';
import { ProviderRegistry } from '../exec/provider/ProviderRegistry';
import { ApprovalManager } from '../exec/approval/ApprovalManager';
import { AcEditor } from '../exec/approval/AcEditor';
import { registerExecIpc } from '../exec/ipc/ExecIpc';
import { SkillsScanner } from '../skills/SkillsScanner';
import { SkillsOps } from '../skills/ops/SkillsOps';
import { registerSkillsIpc } from '../skills/ipc/SkillsIpc';
import { Logger } from '../log/Logger';

/**
 * 主进程入口（设计 §3 / §4.3/4.4/4.5 + S2 D9 + S3 D11/D12）：
 * 单实例锁 → 兜底清理（FR-7）→ Logger/Settings → whenReady → ensure() 三态分支
 * （就位：窗口 ∥ start()；首装：自动触发 InstallFlow）→ S3 升级编排（托盘入口/dialog/自动检查）
 * → 退出编排（含升级中退出扩展）。
 * 红线：DSH_HOME 零引用；官方 UI loadURL 不挂 preload（零注入 CON-R001）。
 */

// e2e 测试隔离（S7）：HULL_USER_DATA 覆盖 userData 路径（须在单实例锁之前——锁基于 userData 目录）
const userDataOverride = process.env.HULL_USER_DATA;
if (userDataOverride) app.setPath('userData', userDataOverride);

const lock = acquireSingleInstanceLock();
if (!lock.ok) {
  app.quit(); // 已有实例在跑（T1-03：second-instance 由第一个实例处理唤醒）
} else {
  void bootstrap(lock);
}

async function bootstrap(lock: { onSecondInstance(cb: () => void): void }): Promise<void> {
  const userDataPath = app.getPath('userData');

  // 启动流程第 2 步：兜底清理（FR-7 / 设计 §4.5）——校验命令行签名防误杀用户手动跑的 dsh
  cleanupStaleDsh(userDataPath);

  const logger = new Logger({ logDir: join(userDataPath, 'logs') });
  logger.info('启动流程开始（单实例锁已获取，兜底清理完成）');
  const settings = new SettingsProvider({ userDataPath, logger });
  settings.migrate(); // S6 B5：schemaVersion < 3 字段补齐（设置页首次运行触发）
  // 主题跟随系统（CON-R-theme-006）：themeSource 接受 'system' 原生透传——Electron 将其注入
  // 渲染树 prefers-color-scheme，renderer 的 matchMedia 自动跟随（OS 切换与改设置两条路径统一）；
  // 非 system 值（dark/light）直接锁定。变更经 on('changed') 广播实时生效
  nativeTheme.themeSource = settings.getSettings().theme;
  settings.on('changed', (s) => { nativeTheme.themeSource = s.theme; });
  // B1：看板数据层（boards.json 原子写/损坏重建/迁移）+ 16 IPC 原语注册
  const kanbanStore = new KanbanStore({
    userDataPath,
    logger,
    // CON-R024：附件上限从 settings 读取（默认 10；B2 设置 UI 接线后进 SettingsProvider）
    maxAttachmentSizeMB: 10,
  });
  registerKanbanIpc(kanbanStore);
  registerTokenUsageIpc(); // Token 消耗视图数据源
  // 工作台连接（凭据经 safeStorage 加密存储；渲染层零明文）
  const connectionsStore = new ConnectionsStore({
    userDataPath,
    adapters: PLATFORM_ADAPTERS,
    encryption: {
      isEncryptionAvailable: () => safeStorage.isEncryptionAvailable(),
      encryptString: (plain) => safeStorage.encryptString(plain),
      decryptString: (buf) => safeStorage.decryptString(buf),
    },
  });
  registerConnectionsIpc({ store: connectionsStore });

  // S1+S2：Skills 扫描器（只读）+ 操作层（移除/升级/禁用/回收站，破坏性守卫主进程强制）
  // homeDir 注入（Q-037 DI）；状态文件落 <userData>/skills/（CON-R-skills-006，不触 DSH_HOME）
  const skillsScanner = new SkillsScanner({ homeDir: homedir(), userDataPath, logger });
  const skillsOps = new SkillsOps({ homeDir: homedir(), userDataPath, scanner: skillsScanner, logger });
  skillsOps.selfHeal(); // 启动自愈：staging backup 残留还原（两段 rename 窗口崩溃兜底，设计 §4.1）
  registerSkillsIpc(skillsScanner, skillsOps);
  // B3+B4：执行引擎门面（ExecutionEngine 组装 Scheduler/Heartbeat/Convergence/VerifyGate）+ ProviderManager
  // + ProviderRegistry（M2 注册 'dsh' ACP）+ ApprovalManager + AcEditor + 执行控制 IPC（B3 10 + B4 3）
  const providerManager = new ProviderManager();
  // B4 收口：真实 ACP provider 显式实例化（供 ApprovalManager 审批链路接线 permission 事件；
  // 仅 HULL_EXEC_PROVIDER=mock 时回落 ProviderManager 的 MockProvider，不接 permission 事件）
  const acpProvider: ACPProvider | undefined =
    providerManager.getProvider() instanceof ACPProvider ? (providerManager.getProvider() as ACPProvider) : undefined;
  const execEngine = new ExecutionEngine({
    store: kanbanStore,
    providerManager,
    maxExecutionIdleMinutes: 30,
  });
  // 工作流引擎（顺序步骤：dsh-card 联动看板+执行引擎；通知走系统 Notification）
  // v2：connection-action（凭据 main 侧解密 → Actions 能力层）+ token-budget（tokens 扫描聚合）+ cron 定时调度器
  // §8.1：通知点击 → 聚焦主窗口并切工作流视图（winMgr 晚于引擎构造，晚绑定引用）
  let winMgrRef: WindowManager | null = null;
  const workflowStore = new WorkflowStore(userDataPath);
  const workflowEngine = new WorkflowEngine({
    store: workflowStore,
    kanban: kanbanStore,
    exec: execEngine,
    notify: (title, body) => {
      try {
        const n = new Notification({ title, body });
        n.on('click', () => {
          try {
            winMgrRef?.show();
            winMgrRef?.focus();
            winMgrRef?.showWorkflows();
          } catch { /* 窗口已销毁等，忽略 */ }
        });
        n.show();
      } catch { /* 通知失败不阻塞 */ }
    },
    invokeAction: async (connectionId, params) => {
      const conn = connectionsStore.getCredentials(connectionId);
      if (!conn) return { ok: false, message: '连接不存在或已被删除，请重新选择' };
      return invokeConnectionAction(conn.platform, conn.fields, params);
    },
    tokenUsage: async (period) => {
      const { records } = scanAllSources();
      const summary = summarize(records, period, []);
      return { totalTokens: summary.totals.totalTokens };
    },
  });
  // v2 定时调度器：save/delete/启停时由 IPC 全量重算；壳启动排期；退出清理
  const workflowScheduler = new WorkflowScheduler({
    engine: workflowEngine,
    getDefs: () => workflowStore.list(),
    log: (m) => logger.warn(m),
  });
  registerWorkflowIpc(workflowStore, workflowEngine, workflowScheduler);
  workflowScheduler.reschedule();
  execEngine.start(); // 壳重启收敛（Q-017）：running/paused/interrupted → failed + queued 重排
  // B1 store 内部 system 事件写原语（B4 审批/AC 修订 timeline 写权，P1-1：B4 经 store 原语直调，不经 IPC）
  const appendSystem = (boardId: string, taskId: string, content: string): void => {
    const b = (kanbanStore as unknown as { data: { boards: Array<{ id: string; tasks: Array<{ id: string; timeline: unknown[] }> }> } }).data.boards.find((x) => x.id === boardId);
    const t = b?.tasks.find((x) => x.id === taskId);
    t?.timeline.push({
      id: `tl_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      type: 'system',
      content,
      attachments: [],
      createdAt: new Date().toISOString(),
      author: 'system',
      source: { type: 'system' },
      execution: null,
    });
  };
  // RuntimeManager 由后续启动编排段创建（isReady 闭包延迟执行时已初始化）
  const registry = new ProviderRegistry();
  registry.register({
    provider: 'dsh',
    displayName: 'DeepSeek Harness',
    supportsSubagent: true,
    factory: () => providerManager.getProvider(),
    // isReady = dsh 运行时就绪（RuntimeManager.phase==='ready'）；与 executeTask 实际可用口径一致（P1-B4-2）
    isReady: () => runtime.snapshot().phase === 'ready',
  });
  // 审批流：respondApproval 回 ACP（经 engine 转发到当前执行句柄 permission_response 帧）+ timeline 写
  const approval = new ApprovalManager({
    respondApproval: (ctx, decision, reason) => {
      execEngine.respondApproval(ctx.taskId, ctx.requestId, decision === 'approve', reason);
    },
    timelineStore: { appendSystemEvent: appendSystem },
    logger,
  });
  // B4 收口：ACPProvider permission_request 通知 → ApprovalManager 入队（生产审批链路）
  // （仅真实 ACP provider 接线；HULL_EXEC_PROVIDER=mock 无 permission 事件源，跳过）
  if (acpProvider) acpProvider.on('permission', (ctx) => void approval.handlePermission(ctx));
  const acEditor = new AcEditor({
    readStore: {
      getExecutionStatus: (boardId, taskId) => kanbanStore.getBoard(boardId).tasks.find((t) => t.id === taskId)?.executionStatus ?? 'idle',
      getCurrentExecutionId: (boardId, taskId) => kanbanStore.getBoard(boardId).tasks.find((t) => t.id === taskId)?.currentExecutionId ?? null,
      getAcceptanceCriteria: (boardId, taskId) => kanbanStore.getBoard(boardId).tasks.find((t) => t.id === taskId)?.acceptanceCriteria ?? null,
    },
    mutations: {
      updateAcceptanceCriteria: (boardId, taskId, ac) => {
        kanbanStore.updateTask(boardId, taskId, { acceptanceCriteria: ac });
      },
    },
    executionBridge: {
      cancelExecution: (boardId, taskId) => execEngine.cancel(boardId, taskId),
      markInterrupted: (boardId, taskId) => {
        void execEngine.interruptExecution(boardId, taskId, '执行已中断', 'AC 修订');
      },
      markExecutionDeprecated: (boardId, taskId, executionId) => {
        execEngine.markExecutionDeprecated(boardId, taskId, executionId);
      },
    },
    timelineStore: { appendSystemEvent: appendSystem },
  });
  registerExecIpc({ engine: execEngine, approval, registry, acEditor });
  // B5：导出/导入传输层（KanbanTransfer 默认装配 electron dialog + KanbanStore；2 IPC 已随 registerKanbanIpc 注册）
  // S2：overlay 管理栈（首装自动触发 / ensure 三态 / 取消）
  const runtime = new RuntimeManager({ userDataPath, logger });
  // S2：overlay 管理栈（首装自动触发 / ensure 三态 / 取消）
  const bundledNode = join(userDataPath, 'node', 'bin', 'node');
  // P1：包管理器执行器抽象（npm/pnpm 两实现；P1 阶段默认 npm，P3 接 settings.packageManager 字段；yarn 已移除）
  // 改进 2：pkgMgrRunner onLine 接线——install 逐行输出 → Updater 输出缓冲（升级输出框数据源）。
  // updater 在后面装配，先占位 holder、装配后赋真实引用（onLine 触发时 upgrade 已初始化）。
  const npmOutputTarget: { fn: ((line: string) => void) | null } = { fn: null };
  // 首装进度钩子 holder：overlay 在后面构造，onLine 触发时可能 overlay 未初始化（与 npmOutputTarget 同模式）
  const installLineTarget: { fn: ((line: string) => void) | null } = { fn: null };
  // P3：包管理器按「安装时当前 settings.packageManager」选（用户切换设置后无需重启壳即生效）；
  // 每次安装前经 createPkgMgrRunner 重建 runner——开关可读、切设置即时生效（CON-R-pkgmgr-008：
  // 工厂未知/非法名已回退 npm）。pkgMgrRunner 供取消路径用（cancel 需命中当前 runner）。
  // A 方案：corepackHome 壳控（<userData>/corepack）——corepack 缓存 pnpm 到壳控目录，脱离用户环境；
  // 固定官方最新稳定版 pnpm 11.23.0，corepack 按需下载后复用。
  const corepackHome = join(userDataPath, 'corepack');
  let pkgMgrRunner: PkgMgrRunner = createPkgMgrRunner('npm', {
    nodePath: existsSync(bundledNode) ? bundledNode : 'node',
    corepackHome,
    logger,
  });
  const newPkgMgrRunner = (): PkgMgrRunner => {
    pkgMgrRunner = createPkgMgrRunner(settings.getSettings().packageManager, {
      nodePath: existsSync(bundledNode) ? bundledNode : 'node',
      corepackHome,
      logger,
    });
    return pkgMgrRunner;
  };
  const pkgMgrOptions: PkgMgrRunOptions = {
    registry: settings.getSettings().registry, // S6 B7：settings.registry 优先 + env 兜底
    onLine: (line) => {
      npmOutputTarget.fn?.(line);
      installLineTarget.fn?.(line); // 首装进度：install 行 → OverlayManager.onPkgMgrLine
      logger.dshLog(0, `[pkgmgr] ${line}`); // 逐包输出落盘（排查安装慢/卡包）
    },
  };
  const overlay = new OverlayManager({
    userDataPath,
    logger,
    runNpmInstall: (stagingDir, targetVersion) => toRunNpmInstall(newPkgMgrRunner(), pkgMgrOptions)(stagingDir, targetVersion), // 委托 pkgMgrRunner（错误码透传）
  });
  installLineTarget.fn = (line) => overlay.onPkgMgrLine(line);
  // PK2：捆绑 node 解压接入（CON-R-packaging-003）——打包后 resources/node → <userData>/node；
  // dev 无打包资源 → extractBundledNode 抛错 → InstallFlow dev 分支告警跳过 → PATH 兜底（CON-R-packaging-008）
  const installFlow = new InstallFlow({
    userDataPath,
    overlay,
    isDev: !app.isPackaged,
    logger,
    extractNode: (nodeDir) => extractBundledNode(process.resourcesPath, nodeDir),
  });
  // S3：升级编排栈（UpgradeQueue 单例 → SwapManager 薄层 → Updater）
  const upgradeQueue = new UpgradeQueue();
  const swapManager = new SwapManager(overlay);
  const dismissStore = new DismissStore({ userDataPath });
  // S4：版本通道（ChannelService → Updater 注入；httpGet 默认走 registry fetch）
  const channelService = new ChannelService({ settings, logger });
  const updater = new Updater({
    overlayManager: overlay,
    swapManager,
    runtimeManager: runtime,
    registry: (opts) => checkLatestVersion({ ...opts, getRegistry: () => settings.getSettings().registry }), // S6 B7
    queue: upgradeQueue,
    channelService,
    settingsProvider: settings, // S6 B4：autoCheckDsh 门控
    logger,
  });
  // 改进 2：pkgMgrRunner onLine → Updater 输出缓冲（升级输出框数据源）
  npmOutputTarget.fn = (line) => updater.pushOutput(line);
  // S5：Hull 自更新栈（adapter → HullUpdater；与 dsh Updater 共享 UpgradeQueue 互斥）
  // owner/repo：发布链核对注记（与 electron-builder.yml publish 一致，S6/发布时确认）
  // updaterCacheDir：与 electron-updater AppAdapter.getAppCacheDir 同源（mac=~/Library/Caches /
  // win=%LOCALAPPDATA% / linux=XDG_CACHE_HOME||~/.cache）+ app-update.yml updaterCacheDirName
  // （electron-builder 默认写 <package.name>-updater；userData basename = package.name）
  const cacheBase =
    process.platform === 'win32'
      ? process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local')
      : process.platform === 'darwin'
        ? join(homedir(), 'Library', 'Caches')
        : process.env.XDG_CACHE_HOME || join(homedir(), '.cache');
  const updaterCacheDir = join(cacheBase, `${basename(userDataPath)}-updater`);
  const hullUpdater = new HullUpdater({
    adapter: createElectronUpdaterAdapter({ owner: 'phper666', repo: 'dsh-hull-desktop', logger }),
    queue: upgradeQueue,
    runtimeManager: runtime,
    settingsProvider: settings,
    getVersion: () => app.getVersion(),
    logger,
    updaterCacheDir,
  });
  const winMgr = new WindowManager({
    runtime,
    // S8 D5：hull:status 载荷的 getDshStatus 形状部分（与 hull:getDshStatus handler 同源）
    getStatus: () => ({
      runtime: runtime.snapshot(),
      upgrade: updater.snapshot(),
      currentVersion: overlay.currentVersion(),
      // M1-重构：nav 状态区「Hull 版本」行（HullUpdater 同源——getVersion = app.getVersion）
      hullVersion: app.getVersion(),
      canRollback: swapManager.canRollback(),
    }),
    isCloseToQuit: () => settings.getSettings().closeToQuit,
    onCloseToQuit: () => void quitOrchestration(),
    // P1-1：updater 状态迁移 → hull:status payload 刷新（nav 状态区"升级"列实时）
    onUpgradeStatus: (cb) => {
      updater.on('status', cb);
    },
    logger,
  });
  winMgrRef = winMgr; // §8.1：工作流通知点击跳转的晚绑定引用回填
  // S8' D5：托盘补充入口（聚焦主窗口 + 切视图；设置 → showSettings，检查 dsh → 聚焦主窗口 + 切 settings 视图渲染确认）
  const tray = new TrayController({
    runtime,
    updater,
    hullUpdater,
    queue: upgradeQueue,
    onOpenMain: () => {
      winMgr.show();
      winMgr.focus();
      winMgr.restore();
    },
    onOpenSettings: () => {
      winMgr.show();
      winMgr.focus();
      winMgr.restore();
      winMgr.showSettings();
    },
    onCheckUpdates: () => void runCheck(),
    onCheckHullUpdates: () => void runHullCheck(),
    onQuit: () => void quitOrchestration(),
    getDshVersion: () => overlay.currentVersion(),
  });

  // 退出编排（设计 §4.3 + S3 §4.5）：双 flag 防递归与中途二次退出漏防
  // - quitting：编排进行中（升级取消/等待 + stop + 500ms 延时）
  // - quitProceeding：最终 app.quit() 已发出 → before-quit 放行默认退出
  let quitting = false;
  let quitProceeding = false;
  const quitOrchestration = async (): Promise<void> => {
    if (quitting) return;
    quitting = true;
    // S3（B8/D12）：升级中退出 → installing 段 cancelInstall；swapping+ 段等待完成
    // （超时强退 → 半替换残留由 Q-004 ensure 启动自愈注记）
    const inflight = updater.inFlightUpgrade();
    if (inflight) {
      if (updater.snapshot().phase === UpgradePhase.Installing) {
        try {
          await updater.cancel();
        } catch (err) {
          logger.warn(`退出取消升级失败: ${(err as Error).message}`);
        }
      }
      // swapping/verifying/rollback 段：等待完成（上限 90s = 就绪预算 60s + kill 宽限 5s + 余量）
      await Promise.race([inflight.catch(() => {}), new Promise((r) => setTimeout(r, 90_000))]);
      if (updater.snapshot().phase !== UpgradePhase.Idle) {
        logger.warn('升级完成等待超时，强退（半替换残留由 Q-004 ensure 启动自愈）');
      }
    }
    // S2：install 流程中退出 → 先取消安装（kill npm），防孤儿 npm 子进程（首装路径，updater 未参与）
    if (overlay.installStatus().phase === InstallPhase.Installing) {
      try {
        overlay.cancelInstall();
      } catch (err) {
        logger.warn(`退出取消安装失败: ${(err as Error).message}`);
      }
      pkgMgrRunner.cancel();
    }
    try {
      await runtime.stop();
    } catch (err) {
      logger.warn(`退出 stop 失败: ${(err as Error).message}`);
    }
    await new Promise((r) => setTimeout(r, 500)); // SIGKILL 后短延时，防 zombie（T1-02）
    quitProceeding = true; // 🟡-A：最终 quit 发出前标记，before-quit 据此放行
    winMgr.setQuitting(); // 退出编排收尾：close 事件放行（防 closeToQuit=false 阻断最终退出）
    app.quit();
  };
  app.on('before-quit', (e) => {
    workflowScheduler.dispose(); // v2：定时调度器 timer 清理（无未决任务，不阻塞退出编排）
    if (hullUpdater.isQuitAndInstallMode()) return; // S5：自更新退出放行（S1 双 flag 零改动，D5）
    if (quitProceeding) return; // 最终 quit 已发出 → 放行默认退出
    e.preventDefault(); // 编排进行中任何二次退出触发都拦截，防跳过 SIGKILL 升级与延时
    if (!quitting) void quitOrchestration();
  });
  app.on('window-all-closed', () => {
    /* macOS 不退出（T1-06 语义：托盘常驻，dsh 继续跑） */
  });
  app.on('activate', () => {
    winMgr.show();
    winMgr.focus();
    winMgr.restore();
  });

  // 单实例唤醒（T1-03）：second-instance → show + focus + restore
  lock.onSecondInstance(() => {
    winMgr.show();
    winMgr.focus();
    winMgr.restore();
  });

  // 崩溃提示（T1-04 / 设计 §4.2）：dialog [重启/忽略]；忽略 → 占位页 failed 态
  runtime.on('crash', (_info: CrashInfo) => {
    void dialog
      .showMessageBox({
        type: 'error',
        title: 'dsh 崩溃',
        message: 'dsh 已崩溃，是否重启？',
        buttons: ['重启', '忽略'],
        defaultId: 0,
      })
      .then(({ response }) => {
        if (quitting) return; // 🟡-3：退出期间不再重启，防孤儿 dsh
        if (response === 0) {
          runtime.start().catch((err: Error) => logger.warn(`崩溃重启失败: ${err.message}`));
        } else {
          winMgr.showPlaceholder('failed', 'dsh 已崩溃');
        }
      });
  });

  // preload 桥（契约 #7）：hull:retry / hull:openLogs
  ipcMain.handle('hull:retry', async () => {
    if (quitting) return { ok: false, message: '正在退出' }; // 🟡-3：退出期间禁止重启
    try {
      const snap = await runtime.start();
      return { ok: true, phase: snap.phase };
    } catch (err) {
      return { ok: false, message: (err as Error).message };
    }
  });
  ipcMain.handle('hull:openLogs', async () => {
    const errMsg = await shell.openPath(join(userDataPath, 'logs'));
    return { ok: !errMsg, message: errMsg };
  });

  // S2：首装/重装编排（自动触发 + 引导态重装共用同一入口）
  // ⚠️ 防重入锁（2026-09-01 实测）：hull:install 的 Installing 检查有竞态——runInstallFlow
  // 是 void 异步，第一次点击后 handler 已返回但 install() 尚未把 phase 置为 Installing，
  // 快速连续点击会并发进入多次 installFlow.run → 后续并发的 install() 直接返回快照后
  // 继续 swap() 空 staging（预改写 seen=0）→ 空 dsh → 安装错乱。用 installRunning 锁兜住。
  let installRunning = false;
  const runInstallFlow = async (targetVersion: string): Promise<void> => {
    if (quitting || installRunning) return;
    installRunning = true;
    try {
    // PK2 补充：首装前确保捆绑 node 解压——否则 nodePath 走 PATH 兜底（'node'），
    // pnpm 的 corepackBin（nodePath 同目录/corepack）路径错 → spawn corepack pnpm 127（command not found）
    await ensureBundledNode(userDataPath, logger);
    winMgr.showPlaceholder('installing', `正在安装 dsh@${targetVersion}…`);
    const result = await installFlow.run(targetVersion);
    if (quitting) return;
    if (result.ok) {
      logger.info(`dsh 安装成功 v${result.version}`);
      // B7：install success 即提交；start() 失败归 S1 failed 态（占位页重试），不触发安装回滚
      try {
        await runtime.start();
      } catch (err) {
        // Windows junction 窗口兜底（2026-09-01 冷装实测）：swap 后立即 relink 常被
        // pnpm 收尾/Windows Defender 对新路径 dsh 的扫描锁住（EISDIR/EPERM），
        // 窗口实测 3~5 分钟（120s 仍失败、几分钟后成功）。启动失败后轮询重建：
        // 每 30s 尝试一次（内部带退避），成功立即启动，最长 6 分钟。
        if (overlay.hasRelinkFailure()) {
          logger.warn(`安装后启动失败（junction 重建未完成），轮询等待重建: ${(err as Error).message}`);
          winMgr.showPlaceholder('installing', '正在完成 dsh 启动准备…');
          let relinkOk = false;
          for (let i = 0; i < 12; i++) {
            await new Promise((r) => setTimeout(r, 30_000));
            if (quitting) return;
            const r = await overlay.ensureJunctions();
            logger.info(`junction 重建兜底[${i + 1}]: fixed=${r.fixed} seen=${r.seen} failed=${r.failed.length}`);
            if (r.failed.length === 0) {
              relinkOk = true;
              break;
            }
          }
          if (quitting) return;
          if (relinkOk) {
            runtime.start().catch((e: Error) => logger.warn(`兜底重建后启动失败: ${e.message}`));
          } else {
            showNotInstalled(`dsh 安装后启动失败（junction 重建持续失败）: ${(err as Error).message}`);
          }
        } else {
          logger.warn(`安装后启动失败: ${(err as Error).message}`);
        }
      }
    } else {
      // failed/cancelled → 引导态（错误提示 + 安装按钮重试）
      showNotInstalled(result.message);
    }
    } finally {
      installRunning = false;
    }
  };

  // 未安装引导态：异步解析将装版本（channelService.resolveTarget → latest/pinned）拼进文案；
  // registry 不可达/解析失败 → 纯文案兜底（不阻塞引导态显示）
  const showNotInstalled = (message = 'dsh 尚未安装，点击「安装 dsh」开始安装'): void => {
    // 引导提示：当前包管理器非 pnpm 时，提示切 pnpm 安装更快（pnpm 冷装 ~30s vs npm ~28min，实测）
    const isPnpm = settings.getSettings().packageManager === 'pnpm';
    const hint = isPnpm ? '' : '（提示：在设置页切到 pnpm，安装速度会快很多）';
    const msg = message + hint;
    winMgr.showPlaceholder('not-installed', msg);
    void channelService
      .resolveTarget()
      .then((v) => {
        if (quitting) return;
        if (!v) return;
        winMgr.showPlaceholder('not-installed', `${msg}（将安装 dsh@${v}）`);
      })
      .catch(() => {
        /* registry 不可达 → 保持纯文案，不阻塞 */
      });
  };

  // S2 IPC（契约 v0.2 #6~#8）：install / cancelInstall / installStatus（renderer 250ms 轮询，B6）
  ipcMain.handle('hull:install', async () => {
    if (quitting) return { ok: false, message: '正在退出' };
    // installRunning 锁（runInstallFlow 重入防护）+ Installing 阶段检查，双保险防并发
    if (installRunning || overlay.installStatus().phase === InstallPhase.Installing) {
      return { ok: false, message: '安装进行中' };
    }
    // S4 版本通道：resolveTarget 解析真实目标版本（latest → registry 最新 / pinned → 锁定版）；失败回退 latest
    let target = 'latest';
    try {
      target = await channelService.resolveTarget();
    } catch {
      /* registry 不可达 → 回退 latest，安装仍可尝试 */
    }
    void runInstallFlow(target);
    return { ok: true };
  });
  ipcMain.handle('hull:cancelInstall', async () => {
    void overlay.cancelInstall();
    pkgMgrRunner.cancel();
    return { ok: true };
  });
  ipcMain.handle('hull:installStatus', async () => overlay.installStatus());

  // S8' §4.5 M1 确认流（M1-重构：升级并入设置视图）：runCheck → phase=confirm → hull:status
  // （upgrade.phase=confirm + latest/current）→ 设置视图升级区块渲染确认卡片 → 「立即升级」→ hull:upgradeDsh。
  // 手动触发（托盘）→ 聚焦主窗口 + 切 settings 视图渲染确认；自动检查（maybeAutoCheck，M2）→ 不强制切 view（nav 打标）。
  const runCheck = async (auto = false): Promise<void> => {
    if (quitting) return;
    const result = await updater.check();
    if (quitting) return;
    if (result.phase === UpgradePhase.Confirm && result.latest) {
      if (!auto) {
        winMgr.show();
        winMgr.focus();
        winMgr.restore();
        winMgr.showSettings();
      }
      return;
    }
    // checkFailed：设置视图升级区块失败卡片（按钮下方红字，S3 契约 T3-05 语义）——hull:status 推送驱动，无 dialog
    // 无更新：静默（设置视图升级区块 / nav 状态区显示「无」）
  };

  // 启动自动检查（🟢-2：start() 成功后触发更稳；S6 B4：autoCheckDsh 门控 + DismissStore 当日去重 T3-06）
  const maybeAutoCheck = (): void => {
    if (!updater.isAutoCheckEnabled()) {
      logger.info('autoCheckDsh 关闭，跳过 dsh 自动检查');
      return;
    }
    if (dismissStore.isDismissedToday('dsh')) {
      logger.info('当日已稍后再说，跳过自动检查');
      return;
    }
    logger.info('启动自动检查更新');
    void runCheck(true); // M2：自动检查不强制切 view（nav 打标），仅手动触发才切 upgrade 视图
  };

  // S3 IPC（S6 设置页接线预留；S3 侧托盘已直连同一入口——注记）
  ipcMain.handle('hull:checkForUpdates', async () => {
    if (quitting) return { ok: false, message: '正在退出' };
    const result = await updater.check();
    return { ok: true, hasUpdate: result.hasUpdate, latest: result.latest, phase: result.phase };
  });

  // S5：Hull 自更新编排（M1-重构：预防性提示 dialog → 设置视图升级区块重启安装提示卡片；编排零改动 CON-R005）
  hullUpdater.on('preventive-prompt', () => {
    if (quitting) return;
    // H2 裁决 2：预防性提示（T5-05：更新后无法打开 → 右键打开 / 重下载引导）收进设置视图升级区块重启安装提示区
    winMgr.show();
    winMgr.focus();
    winMgr.restore();
    winMgr.showSettings();
  });

  const runHullCheck = async (auto = false): Promise<void> => {
    if (quitting) return;
    const result = await hullUpdater.check();
    if (quitting) return;
    if (result.hasUpdate && result.targetVersion) {
      // M1-重构：Hull 确认流壳内化——切 settings 视图升级区块渲染 Hull 确认卡片；「立即下载」→ hull:downloadHullUpdate
      // 自动检查（M2 同 dsh）不强制切 view（nav 打标），仅手动触发切
      if (!auto) {
        winMgr.show();
        winMgr.focus();
        winMgr.restore();
        winMgr.showSettings();
      }
      return;
    }
    // checkFailed：设置视图升级区块 Hull 失败卡片（hull:status 推送驱动，无 dialog）
  };

  // 启动自动检查（Hull）：autoCheckHull 门控 + DismissStore('hull') 当日去重（T5-06）
  const maybeAutoCheckHull = (): void => {
    if (!hullUpdater.isAutoCheckEnabled()) {
      logger.info('autoCheckHull 关闭，跳过 Hull 自动检查');
      return;
    }
    if (dismissStore.isDismissedToday('hull')) {
      logger.info('Hull 当日已稍后再说，跳过自动检查');
      return;
    }
    logger.info('启动自动检查 Hull 更新');
    void runHullCheck(true); // M2：Hull 自动检查不强制切 view（同 dsh）
  };

  // S6 设置页 Hull 区块接线（S5 预留版由 S6 完整实现替代——删除防重复注册）
  ipcMain.handle('hull:hullUpdateStatus', async () => hullUpdater.snapshot());

  // S4 IPC 三通道预留（S6 设置页接线启用；S4 期间已注册 UI 未接——通道配置属设置页面，托盘不新增入口）
  ipcMain.handle('hull:getChannel', async () => {
    if (quitting) return { ok: false, message: '正在退出' };
    return { ok: true, ...channelService.get() };
  });
  ipcMain.handle('hull:setChannel', async (_e, channel: string, version?: string) => {
    if (quitting) return { ok: false, message: '正在退出' };
    try {
      await channelService.set(channel, version);
      return { ok: true };
    } catch (err) {
      return { ok: false, code: err instanceof HullError ? err.code : 'unknown', message: (err as Error).message };
    }
  });
  ipcMain.handle('hull:listVersions', async () => {
    if (quitting) return { ok: false, message: '正在退出' };
    try {
      const list = await channelService.listVersions();
      return { ok: true, versions: list.versions, latest: list.latest };
    } catch (err) {
      return { ok: false, code: err instanceof HullError ? err.code : 'unknown', message: (err as Error).message };
    }
  });

  // S6：设置页 IPC（独立窗口 + 独立 preload）
  ipcMain.handle('hull:getSettings', async () => settings.getSettings());
  ipcMain.handle('hull:setSettings', async (_e, patch) => {
    if (quitting) return { ok: false, message: '正在退出' };
    try {
      settings.set(patch);
      return { ok: true, settings: settings.getSettings() };
    } catch (err) {
      return {
        ok: false,
        code: err instanceof HullError ? err.code : 'unknown',
        message: (err as Error).message,
      };
    }
  });

  ipcMain.handle('hull:getDshStatus', async () => winMgr.hullStatus());
  // S8' §4.3 H1：壳导航设置入口 → 主进程切 settings 视图（独立窗口移除，S8' D1）。
  // 原 hull:openSettings（独立 SettingsWindow）已删——showSettings 封装 showPlaceholder + 推送。
  ipcMain.handle('hull:showSettings', async () => {
    if (quitting) return { ok: false, message: '正在退出' };
    winMgr.showSettings();
    return { ok: true };
  });
  // B2：壳导航任务看板入口 → 主进程切 view 到 placeholder:board（官方 WebContentsView 隐藏，
  // 渲染侧 section#board 显示；复用 showPlaceholder 机制，D6 view 单一事实源不破）
  ipcMain.handle('hull:showBoard', async () => {
    if (quitting) return { ok: false, message: '正在退出' };
    winMgr.showPlaceholder('board', '');
    return { ok: true };
  });
  // S1：壳导航 Skills 入口 → 主进程切 view 到 placeholder:skills（官方 WebContentsView 隐藏，
  // 渲染侧 section#skills 显示；镜像 showBoard，D6 view 单一事实源不破）
  ipcMain.handle('hull:showSkills', async () => {
    if (quitting) return { ok: false, message: '正在退出' };
    winMgr.showSkills();
    return { ok: true };
  });
  // Token 消耗视图（Skills 之后，镜像 showSkills）
  ipcMain.handle('hull:showTokens', async () => {
    if (quitting) return { ok: false, message: '正在退出' };
    winMgr.showTokens();
    return { ok: true };
  });
  // 工作台连接视图（设置之前，镜像 showTokens）
  ipcMain.handle('hull:showConnections', async () => {
    if (quitting) return { ok: false, message: '正在退出' };
    winMgr.showConnections();
    return { ok: true };
  });
  // 工作流视图（设置之前，镜像 showConnections）
  ipcMain.handle('hull:showWorkflows', async () => {
    if (quitting) return { ok: false, message: '正在退出' };
    winMgr.showWorkflows();
    return { ok: true };
  });
  // B2 补丁：壳导航 dsh web 入口 → 恢复官方 view（与 showBoard 对称；无新通道）
  // 语义照 onStatus 映射：Ready → loadOfficialUrl（officialDirty 则重载，否则复用）；
  // Failed → failed 占位；NotInstalled（未安装）→ not-installed 引导态；
  // 其余（idle/starting）→ starting 占位
  ipcMain.handle('hull:showWeb', async () => {
    if (quitting) return { ok: false, message: '正在退出' };
    const s = runtime.snapshot();
    if (s.phase === RuntimePhase.Ready && s.url) {
      winMgr.loadOfficialUrl(s.url);
    } else if (s.phase === RuntimePhase.Failed) {
      winMgr.showPlaceholder('failed', s.message);
    } else if (overlay.installStatus().phase === InstallPhase.NotInstalled) {
      showNotInstalled();
    } else if (overlay.installStatus().phase === InstallPhase.Installing) {
      // 安装中切走再切回 → 显示安装进度视图（renderer pollInstall 250ms 轮询恢复进度）
      winMgr.showPlaceholder('installing', '正在安装 dsh…');
    } else {
      winMgr.showPlaceholder('starting', '');
    }
    return { ok: true };
  });
  // S8' §4.3 H1 收敛：统一 checkDshUpdate（无 dialog 返回结果）——设置区块「检查更新」消费。
  // 渲染侧调 checkDshUpdate → phase=confirm → 切 settings 视图渲染确认卡片。
  // 原 hull:promptDshUpdate 孤儿通道已删除（托盘走 runCheck 直连，不经过本通道）。
  ipcMain.handle('hull:checkDshUpdate', async () => {
    if (quitting) return { hasUpdate: false, current: null, latest: null, phase: UpgradePhase.Idle };
    return updater.check();
  });
  ipcMain.handle('hull:upgradeDsh', async (_e, target: string) => {
    if (quitting) return { ok: false, message: '正在退出' };
    try {
      const status = await updater.upgrade(target);
      return { ok: true, status };
    } catch (err) {
      return {
        ok: false,
        code: err instanceof HullError ? err.code : 'unknown',
        message: (err as Error).message,
      };
    }
  });
  // Bug 修复：升级取消同步 kill npm——Updater.cancel() 只清 staging 不杀 npm（install 仍 await 至
  // 120s 超时/完成才 finally release queue），用户取消后立刻 recheck 会被 queueBusy 静默挡掉。
  // 与 hull:cancelInstall 同模式（overlay.cancelInstall + pkgMgrRunner.cancel），杀 npm → install 快返回
  // → doUpgrade finally 快 release → recheck 立即可用。
  ipcMain.handle('hull:cancelDshUpgrade', async () => {
    const status = updater.cancel();
    pkgMgrRunner.cancel();
    return status;
  });
  ipcMain.handle('hull:dismissDshUpdate', async () => updater.dismiss());
  ipcMain.handle('hull:rollbackDsh', async () => updater.rollback());

  ipcMain.handle('hull:checkHullUpdate', async () => {
    if (quitting) return { hasUpdate: false, targetVersion: null, changeNotes: null, error: null };
    return hullUpdater.check();
  });
  ipcMain.handle('hull:getHullUpdateStatus', async () => hullUpdater.snapshot());
  ipcMain.handle('hull:downloadHullUpdate', async () => {
    if (quitting) return { ok: false, message: '正在退出' };
    try {
      const status = await hullUpdater.download();
      if (status.phase === HullUpdatePhase.Restarting && !quitting) {
        void hullUpdater.installAndRestart();
      }
      return { ok: true, status };
    } catch (err) {
      return {
        ok: false,
        code: err instanceof HullError ? err.code : 'unknown',
        message: (err as Error).message,
      };
    }
  });
  ipcMain.handle('hull:cancelHullUpdate', async () => hullUpdater.cancel());
  ipcMain.handle('hull:dismissHullUpdate', async () => hullUpdater.dismiss());

  ipcMain.handle('hull:openDataDir', async () => {
    const errMsg = await shell.openPath(userDataPath);
    return { ok: !errMsg, message: errMsg };
  });

  // 复制文本到剪贴板（dsh web 地址复制按钮/左下角地址点击；渲染侧 file:// 无 clipboard 权限，走主进程）
  ipcMain.handle('hull:copyText', async (_e, text: string) => {
    if (typeof text !== 'string' || text.length > 4096) return { ok: false, message: '无效文本' };
    clipboard.writeText(text);
    return { ok: true };
  });

  // 打开外部浏览器（shell.openExternal 校验防任意协议注入）。
  // S1 收紧（CON-R-skills-007/Q-038）：https 全放行；http 仅限本机回环（dsh web 地址行
  // http://127.0.0.1:port 依赖此通道打开，不能一刀切拒绝）；file:/javascript:/data:/任意 host http 全拒。
  // skill 来源跳转在渲染侧额外强制 ^https://（skills.js），双层防御。
  const isSafeExternalUrl = (url: string): boolean =>
    /^https:\/\/.+/.test(url) || /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?([/?#]|$)/.test(url);
  ipcMain.handle('hull:openExternal', async (_e, url: string) => {
    if (typeof url !== 'string' || !isSafeExternalUrl(url)) return { ok: false, message: '无效 URL' };
    try {
      await shell.openExternal(url);
      return { ok: true };
    } catch (err) {
      return { ok: false, message: (err as Error).message };
    }
  });

  // e2e 测试钩子（S7，HULL_E2E=1 时暴露；生产零影响——原生托盘菜单 Playwright 无法点击，需程序化入口）
  if (process.env.HULL_E2E === '1') {
    (globalThis as Record<string, unknown>).__hullTest = {
      openSettings: () => winMgr.showSettings(), // S8'：设置入口 = 切 settings 视图（独立窗口移除）
      openMain: () => {
        winMgr.show();
        winMgr.focus();
        winMgr.restore();
      },
      quit: () => void quitOrchestration(),
      trayMenu: () => tray.getMenu(),
      mainWindow: () => winMgr.getWindow(),
      officialView: () => winMgr.officialViewState(), // S8 R2：Playwright 对 WebContentsView page 暴露兜底断言
    };
  }

  await app.whenReady();
  tray.create();
  // S2 启动分支（设计 D9 B4）：ensure 三态 → 就位则窗口 ∥ start()（S1 既有流程）；首装 → 自动触发 InstallFlow
  const overlayPhase = await overlay.ensure();
  winMgr.create();
  if (overlayPhase === InstallPhase.Ready) {
    try {
      // PK2 补充：就位（dsh 已装）时也确保捆绑 node 解压——extractNode 原绑定安装流程，
      // dsh 已装重启不触发 → userData/node 缺失 → resolveNodePath 回退 PATH → 打包环境无 node → spawn ENOENT
      await ensureBundledNode(userDataPath, logger);
      await runtime.start();
      maybeAutoCheck(); // S3：dsh 就绪后自动检查（🟢-2）
      maybeAutoCheckHull(); // S5：Hull 自动检查（autoCheckHull + DismissStore('hull') 门控）
    } catch (err) {
      if (err instanceof DshMissingError) {
        winMgr.showPlaceholder('not-installed', err.message); // 兜底（ensure 已分流，理论不可达）
      }
      // 其余失败：failed 迁移已由 status 订阅驱动占位页 failed 态
    }
  } else {
    // 首装：进「未安装」引导态，用户手动点「安装 dsh」再走安装流程（需求变更 2026-08-24：不再自动触发）
    showNotInstalled();
  }
}

/**
 * PK2 补充：幂等确保捆绑 node 解压到 <userData>/node（CON-R-packaging-003/008）。
 * - 已解压（bin/node + 版本文件）→ 跳过
 * - dev / 无打包资源 → extractBundledNode 抛错 → 告警跳过（PATH 兜底）
 * - 失败 → 告警不阻断启动（resolveNodePath 仍会 PATH 兜底，但打包环境会 ENOENT——留日志可查）
 * 就位分支（dsh 已装）也要调用：extractNode 原绑定安装流程，重启不触发 → 缺失 node 会 spawn ENOENT。
 */
async function ensureBundledNode(userDataPath: string, logger: Logger): Promise<void> {
  const nodeDir = join(userDataPath, 'node');
  if (isNodeExtracted(nodeDir)) return; // 幂等：已解压跳过
  try {
    await extractBundledNode(process.resourcesPath, nodeDir);
  } catch (err) {
    logger.warn(`捆绑 node 解压失败（PATH 兜底）: ${(err as Error).message}`);
  }
}

/** 兜底清理（FR-7）：读 dsh.pid → ps 校验命令行签名 → 通过则按组杀 → 删 pid 文件 */
function cleanupStaleDsh(userDataPath: string): void {
  const pidFile = join(userDataPath, 'dsh.pid');
  let pid: number;
  try {
    const parsed = JSON.parse(readFileSync(pidFile, 'utf8')) as { pid?: unknown };
    if (typeof parsed.pid !== 'number') return; // 损坏 → 跳过清理（无害降级）
    pid = parsed.pid;
  } catch {
    return; // 不存在/损坏 → 跳过
  }
  let cmdline = '';
  try {
    cmdline = spawnSync('ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8' }).stdout.trim();
  } catch {
    return; // ps 不可用 → 跳过
  }
  if (!cmdline) {
    // 进程已不存在 → 陈旧 pid 文件，直接清理
    try {
      unlinkSync(pidFile);
    } catch {
      /* 无害 */
    }
    return;
  }
  if (!matchesDshSignature(cmdline)) {
    console.warn(`[hull] dsh.pid 命令行签名不匹配（${pid}），跳过清理（防误杀）`);
    return;
  }
  try {
    process.kill(-pid, 'SIGTERM'); // detached 进程组整组清理（设计 D3）
  } catch {
    /* 进程组不存在 */
  }
  try {
    unlinkSync(pidFile);
  } catch {
    /* 无害 */
  }
  console.warn(`[hull] 兜底清理残留 dsh 进程组 ${pid}`);
}
