import { app, dialog, ipcMain, shell } from 'electron';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

import { acquireSingleInstanceLock } from '../runtime/SingleInstance';
import { RuntimeManager, type CrashInfo } from '../runtime/RuntimeManager';
import { matchesDshSignature } from '../runtime/spawnArgs';
import { DshMissingError, HullError } from '../shared/errors';
import { HullUpdatePhase, InstallPhase, RuntimePhase, UpgradePhase } from '../shared/types';
import { OverlayManager } from '../overlay/OverlayManager';
import { InstallFlow } from '../overlay/InstallFlow';
import { NpmRunner } from '../overlay/npmRunner';
import { Updater } from '../updater/Updater';
import { SwapManager, UPGRADE_ERRORS } from '../updater/SwapManager';
import { UpgradeQueue } from '../updater/UpgradeQueue';
import { DismissStore } from '../updater/DismissStore';
import { HullUpdater, HULL_UPDATE_ERRORS } from '../updater/HullUpdater';
import { createElectronUpdaterAdapter } from '../updater/electronUpdaterAdapter';
import { checkLatestVersion } from '../updater/registry';
import { WindowManager } from '../window/WindowManager';
import { SettingsWindow } from '../window/SettingsWindow';
import { TrayController } from '../tray/TrayController';
import { SettingsProvider } from '../settings/SettingsProvider';
import { ChannelService } from '../channel/ChannelService';
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
  const runtime = new RuntimeManager({ userDataPath, logger });
  // S2：overlay 管理栈（首装自动触发 / ensure 三态 / 取消）
  const bundledNode = join(userDataPath, 'node', 'bin', 'node');
  const npmRunner = new NpmRunner({
    nodePath: existsSync(bundledNode) ? bundledNode : 'node',
    logger,
    getRegistry: () => settings.getSettings().registry, // S6 B7：settings.registry 优先 + env 兜底
  });
  const overlay = new OverlayManager({
    userDataPath,
    logger,
    runNpmInstall: npmRunner.toRunNpmInstall(), // 委托 npmRunner（错误码透传）
  });
  const installFlow = new InstallFlow({ userDataPath, overlay, isDev: !app.isPackaged, logger });
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
  // S5：Hull 自更新栈（adapter → HullUpdater；与 dsh Updater 共享 UpgradeQueue 互斥）
  // owner/repo：发布链核对注记（与 electron-builder.yml publish 一致，S6/发布时确认）
  const hullUpdater = new HullUpdater({
    adapter: createElectronUpdaterAdapter({ owner: 'dsh-hull-desktop', repo: 'dsh-hull-desktop' }),
    queue: upgradeQueue,
    runtimeManager: runtime,
    settingsProvider: settings,
    getVersion: () => app.getVersion(),
    logger,
  });
  const winMgr = new WindowManager({
    runtime,
    // S8 D5：hull:status 载荷的 getDshStatus 形状部分（与 hull:getDshStatus handler 同源）
    getStatus: () => ({
      runtime: runtime.snapshot(),
      upgrade: updater.snapshot(),
      currentVersion: overlay.currentVersion(),
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
  const settingsWindow = new SettingsWindow({ getMainWindow: () => winMgr.getWindow() });
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
    onOpenSettings: () => settingsWindow.show(),
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
      npmRunner.cancel();
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
  const runInstallFlow = async (targetVersion: string): Promise<void> => {
    if (quitting) return;
    winMgr.showPlaceholder('installing', `正在安装 dsh@${targetVersion}…`);
    const result = await installFlow.run(targetVersion);
    if (quitting) return;
    if (result.ok) {
      logger.info(`dsh 安装成功 v${result.version}`);
      // B7：install success 即提交；start() 失败归 S1 failed 态（占位页重试），不触发安装回滚
      runtime.start().catch((err: Error) => logger.warn(`安装后启动失败: ${err.message}`));
    } else {
      // failed/cancelled → 引导态（错误提示 + 安装按钮重试）
      winMgr.showPlaceholder('not-installed', result.message);
    }
  };

  // S2 IPC（契约 v0.2 #6~#8）：install / cancelInstall / installStatus（renderer 250ms 轮询，B6）
  ipcMain.handle('hull:install', async () => {
    if (quitting) return { ok: false, message: '正在退出' };
    if (overlay.installStatus().phase === InstallPhase.Installing) return { ok: false, message: '安装进行中' };
    void runInstallFlow('latest'); // S4 起 targetVersion 由版本通道决定
    return { ok: true };
  });
  ipcMain.handle('hull:cancelInstall', async () => {
    void overlay.cancelInstall();
    npmRunner.cancel();
    return { ok: true };
  });
  ipcMain.handle('hull:installStatus', async () => overlay.installStatus());

  // S3：升级编排（D11——托盘入口 + 原生 dialog 确认；B7 失败提示载体 = dialog；🟢-B 回滚提示）
  const runUpgrade = async (target: string): Promise<void> => {
    if (quitting) return;
    try {
      await updater.upgrade(target);
    } catch (err) {
      if (quitting) return;
      // 升级失败（install-failed/verify-failed/swap-broken/swap-recovered 等）→ 主窗 dialog 失败提示（可关，B7）
      const code = err instanceof HullError ? err.code : UPGRADE_ERRORS.installFailed;
      logger.warn(`升级失败（${code}）: ${(err as Error).message}`);
      void dialog
        .showMessageBox({
          type: 'error',
          title: '升级失败',
          message: `${(err as Error).message}`,
          // 🟡-2：失败后 phase 恒 idle → 重试即重新检查（状态纪律：仅 check→confirm 后 upgrade）
          buttons: ['重新检查', '关闭'],
          defaultId: 1,
        })
        .then(({ response }) => {
          if (quitting || response !== 0) return;
          void runCheck();
        });
      return;
    }
    if (quitting) return;
    // 成功路径：升级成功静默（UI 已切新版）；自动回滚成功 → 「已回滚，原版本可用」（🟢-B 非失败语义）
    const snap = updater.snapshot();
    if (snap.error === null && snap.message.startsWith('已回滚')) {
      void dialog.showMessageBox({
        type: 'info',
        title: '升级已回滚',
        message: '新版本验证失败，已自动回滚，原版本可用。',
        buttons: ['知道了'],
      });
    }
  };

  const runCheck = async (): Promise<void> => {
    if (quitting) return;
    const result = await updater.check();
    if (quitting) return;
    if (result.phase === UpgradePhase.Confirm && result.latest) {
      // 原生 dialog 确认（D11：[立即升级/稍后再说]）
      void dialog
        .showMessageBox({
          type: 'info',
          title: '发现新版本',
          message: `发现 dsh 新版本 v${result.latest}，是否立即升级？`,
          detail: `当前版本：${result.current ?? '未知'}`,
          buttons: ['立即升级', '稍后再说'],
          defaultId: 0,
        })
        .then(({ response }) => {
          if (quitting) return;
          if (response === 0) {
            void runUpgrade(result.latest as string);
          } else {
            updater.dismiss(); // 🟡-1：confirm → idle（防 phase 卡 Confirm 致 dsh 手动检查失效，与设置页路径对齐）
            dismissStore.dismissToday('dsh'); // 稍后再说：当日不再自动提示（Q-008/T3-06，S5 分通道键）
            logger.info(`稍后再说（当日不再提示）: v${result.latest}`);
          }
        });
      return;
    }
    if (updater.snapshot().error === UPGRADE_ERRORS.checkFailed) {
      void dialog.showMessageBox({
        type: 'error',
        title: '检查更新失败',
        message: updater.snapshot().message,
        buttons: ['关闭'],
      });
    }
    // 无更新：静默（手动检查无反馈属可接受——S6 设置页接线时补 UI 提示，注记）
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
    void runCheck();
  };

  // S3 IPC（S6 设置页接线预留；S3 侧托盘已直连同一入口——注记）
  ipcMain.handle('hull:checkForUpdates', async () => {
    if (quitting) return { ok: false, message: '正在退出' };
    const result = await updater.check();
    return { ok: true, hasUpdate: result.hasUpdate, latest: result.latest, phase: result.phase };
  });

  // S5：Hull 自更新编排（D5/D6/D7——预防性提示 dialog + 自动检查 + 下载流程）
  hullUpdater.on('preventive-prompt', () => {
    if (quitting) return;
    // B1 预防性提示（T5-05）：更新后若无法打开 → 右键打开 / 重下载引导（README 章节同步注记）
    void dialog.showMessageBox({
      type: 'info',
      title: '更新安装提示',
      message: '更新后若无法打开：\n① 右键 → 打开（隔离/未公证）\n② 若仍无法打开，请重新下载安装包',
      buttons: ['知道了'],
    });
  });

  const runHullDownload = async (): Promise<void> => {
    if (quitting) return;
    try {
      await hullUpdater.download();
      if (quitting) return;
      await hullUpdater.installAndRestart(); // Q-012：下载完成自动重启安装
    } catch (err) {
      if (quitting) return;
      const code = err instanceof HullError ? err.code : HULL_UPDATE_ERRORS.downloadFailed;
      logger.warn(`Hull 更新失败（${code}）: ${(err as Error).message}`);
      void dialog
        .showMessageBox({
          type: 'error',
          title: 'Hull 更新失败',
          message: (err as Error).message,
          buttons: ['重新检查', '关闭'],
          defaultId: 1,
        })
        .then(({ response }) => {
          if (quitting || response !== 0) return;
          void runHullCheck();
        });
    }
  };

  const runHullCheck = async (): Promise<void> => {
    if (quitting) return;
    const result = await hullUpdater.check();
    if (quitting) return;
    if (result.hasUpdate && result.targetVersion) {
      void dialog
        .showMessageBox({
          type: 'info',
          title: '发现 Hull 新版本',
          message: `发现 Hull 新版本 v${result.targetVersion}，是否立即下载？`,
          detail: result.changeNotes ? `变更说明：${result.changeNotes}` : undefined,
          buttons: ['立即下载', '稍后再说'],
          defaultId: 0,
        })
        .then(({ response }) => {
          if (quitting) return;
          if (response === 0) {
            void runHullDownload();
          } else {
            hullUpdater.dismiss(); // 🔴-1：confirm → idle + 释放互斥槽（防 dsh 升级永久 queue-busy）
            dismissStore.dismissToday('hull'); // 稍后再说：Hull 当日不再自动提示（Q-008）
            logger.info('Hull 稍后再说（当日不再提示）');
          }
        });
      return;
    }
    if (hullUpdater.snapshot().error === HULL_UPDATE_ERRORS.checkFailed) {
      void dialog.showMessageBox({
        type: 'error',
        title: '检查 Hull 更新失败',
        message: hullUpdater.snapshot().message,
        buttons: ['关闭'],
      });
    }
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
    void runHullCheck();
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
  // S8 D6：壳导航升级入口（main runCheck → 原生 dialog）。
  // 注：现有 hull:checkDshUpdate 被设置页占用（DOM modal 确认流，S6 零改动）→ 壳导航走独立通道；
  // 桥方法名仍为 checkDshUpdate（设计 D6 命名），实现偏离「无新通道」注记——见实现记录。
  // 与托盘 runCheck 入口一致（S3 既有约束），无 in-flight 守卫，连点叠弹窗口极小
  // （Updater queue 互斥兜底：非 idle 时 check 直接忽略，queue-busy 不弹）
  ipcMain.handle('hull:promptDshUpdate', async () => {
    if (quitting) return { hasUpdate: false, current: null, latest: null, phase: UpgradePhase.Idle };
    void runCheck();
    return { ok: true };
  });
  ipcMain.handle('hull:openSettings', async () => {
    if (quitting) return { ok: false, message: '正在退出' };
    settingsWindow.show(); // S8 D6：设置入口双入口（壳导航为主、托盘补充，S6 零改动）
    return { ok: true };
  });
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
  ipcMain.handle('hull:cancelDshUpgrade', async () => updater.cancel());
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

  // e2e 测试钩子（S7，HULL_E2E=1 时暴露；生产零影响——原生托盘菜单 Playwright 无法点击，需程序化入口）
  if (process.env.HULL_E2E === '1') {
    (globalThis as Record<string, unknown>).__hullTest = {
      openSettings: () => settingsWindow.show(),
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
    void runInstallFlow('latest'); // 首装自动触发（T2-01；进度可观察、可取消 → 取消后引导态）
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
