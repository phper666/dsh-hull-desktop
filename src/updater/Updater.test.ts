import { test } from 'node:test';
import { equal, deepEqual, ok, rejects, throws } from 'node:assert/strict';

import { Updater } from './Updater';
import { SwapManager } from './SwapManager';
import { UpgradeQueue } from './UpgradeQueue';
import { HullError } from '../shared/errors';
import { InstallPhase, UpgradePhase, type UpgradeStatus } from '../shared/types';

interface Knobs {
  installPending?: boolean;
  installThrow?: Error;
  swapNonReady?: boolean;
  swapThrowCode?: string | null;
  swapThrowPhase?: InstallPhase;
  canRollback?: boolean;
  startRejectAt?: number | null;
  stopPending?: boolean;
  registryHasUpdate?: boolean;
  registryThrow?: boolean;
  overlayVersion?: string;
  channel?: {
    resolveTarget?: string;
    setThrow?: Error;
  };
  settings?: {
    autoCheckDsh?: boolean;
  };
}

/** fake channelService（S4 注入；record resolveTarget/set 调用） */
function makeFakeChannel(overrides: { resolveTarget?: string; setThrow?: Error } = {}) {
  const calls: string[] = [];
  const state = { channel: 'pinned' as 'latest' | 'pinned', pinnedVersion: null as string | null };
  return {
    calls,
    state,
    service: {
      resolveTarget: async () => {
        calls.push('resolveTarget');
        return overrides.resolveTarget ?? '1.0.0';
      },
      get: () => ({ channel: state.channel, pinnedVersion: state.pinnedVersion }),
      set: async (channel: string) => {
        calls.push(`set:${channel}`);
        if (overrides.setThrow) throw overrides.setThrow;
      },
    },
  };
}

/** 暴露受保护 transition 供测试 */
class ExposedUpdater extends Updater {
  callTransition(to: UpgradePhase, message: string): boolean {
    return this.transition(to, message);
  }
}

function makeUpdater(overrides: Partial<Knobs> = {}) {
  const knobs: Knobs = {
    installPending: false,
    installThrow: undefined,
    swapNonReady: false,
    swapThrowCode: null,
    canRollback: true,
    startRejectAt: null,
    stopPending: false,
    registryHasUpdate: true,
    registryThrow: false,
    overlayVersion: '0.9.0',
    ...overrides,
  };
  const calls: string[] = [];
  const starts: Array<{ n: number; probeTarget: string | undefined }> = [];
  const progressHooks: Array<(...args: unknown[]) => void> = [];
  let installGate: (() => void) | null = null;
  let stopGate: (() => void) | null = null;
  let overlayPhase: InstallPhase = InstallPhase.Ready;

  const overlay = {
    install: async () => {
      calls.push('overlay.install');
      if (knobs.installPending) await new Promise<void>((r) => (installGate = r));
      if (knobs.installThrow) throw knobs.installThrow;
    },
    installStatus: () => ({ phase: overlayPhase }),
    cancelInstall: async () => {
      calls.push('overlay.cancelInstall');
      overlayPhase = InstallPhase.NotInstalled;
    },
    currentVersion: () => (overlayPhase === InstallPhase.Ready ? knobs.overlayVersion! : null),
    canRollback: () => knobs.canRollback!,
    // Bug3 修复：Updater 构造订阅 overlay 'progress' → fake 提供 on() 存根（progressHooks 记录订阅回调供测试触发）
    on: (evt: string, cb: (...args: unknown[]) => void) => {
      if (evt === 'progress') progressHooks.push(cb);
    },
    swap: async () => {
      calls.push('overlay.swap');
      if (knobs.swapThrowCode) {
        overlayPhase = knobs.swapThrowPhase ?? InstallPhase.NotInstalled;
        throw new HullError(knobs.swapThrowCode, 'swap failed');
      }
      if (knobs.swapNonReady) {
        overlayPhase = InstallPhase.NotInstalled;
        return { phase: InstallPhase.NotInstalled, version: null, progress: null, message: '' };
      }
      overlayPhase = InstallPhase.Ready;
      knobs.overlayVersion = '1.0.0';
      return { phase: InstallPhase.Ready, version: '1.0.0', progress: null, message: '' };
    },
    swapBack: async () => {
      calls.push('overlay.swapBack');
      overlayPhase = InstallPhase.Ready;
      knobs.overlayVersion = '0.9.0';
      return { phase: InstallPhase.Ready, version: '0.9.0', progress: null, message: '' };
    },
  };

  const runtime = {
    startCalls: 0,
    stop: async () => {
      calls.push('runtime.stop');
      if (knobs.stopPending) await new Promise<void>((r) => (stopGate = r));
    },
    start: async () => {
      runtime.startCalls += 1;
      starts.push({ n: runtime.startCalls, probeTarget: process.env.HULL_PROBE_TARGET });
      calls.push(`runtime.start#${runtime.startCalls}`);
      if (knobs.startRejectAt === runtime.startCalls) throw new Error(`start#${runtime.startCalls} 验证失败`);
    },
  };

  const registry = {
    checkLatestVersion: async () => {
      calls.push('registry.check');
      if (knobs.registryThrow) throw new Error('ECONNREFUSED');
      return { hasUpdate: knobs.registryHasUpdate!, current: knobs.overlayVersion, latest: '1.0.0' };
    },
  };

  const queue = new UpgradeQueue();
  const swapManager = new SwapManager(overlay as unknown as import('../overlay/OverlayManager').OverlayManager);
  const fakeChannel = knobs.channel ? makeFakeChannel(knobs.channel) : null;
  const fakeSettings = knobs.settings
    ? { getSettings: () => ({ autoCheckDsh: knobs.settings!.autoCheckDsh ?? true }) }
    : null;
  const updater = new ExposedUpdater({
    overlayManager: overlay as unknown as import('../overlay/OverlayManager').OverlayManager,
    swapManager,
    runtimeManager: runtime as unknown as import('../runtime/RuntimeManager').RuntimeManager,
    registry: registry.checkLatestVersion as unknown as import('./registry').RegistryCheckFn,
    queue,
    ...(fakeChannel ? { channelService: fakeChannel.service as unknown as import('../channel/ChannelService').ChannelService } : {}),
    ...(fakeSettings ? { settingsProvider: fakeSettings as unknown as import('../settings/SettingsProvider').SettingsProvider } : {}),
    dev: true,
  });
  const events: UpgradeStatus[] = [];
  updater.on('status', (s) => events.push(s));
  return {
    updater,
    calls,
    starts,
    queue,
    releaseInstall: () => installGate?.(),
    releaseStop: () => stopGate?.(),
    getEvents: () => events,
    /** Bug3：触发 overlay progress（installing 段透传 pct） */
    emitProgress: (pct: number) => progressHooks.forEach((cb) => cb({ phase: 'npm-install', pct })),
    channelCalls: () => (fakeChannel ? fakeChannel.calls : []),
    setChannelState: (c: 'latest' | 'pinned') => {
      if (fakeChannel) fakeChannel.state.channel = c;
    },
  };
}

test('① check→confirm→upgrade 全链路状态迁移 + status 事件序列', async () => {
  const { updater, getEvents } = makeUpdater();
  await updater.check();
  equal(updater.snapshot().phase, 'confirm');
  await updater.upgrade('1.0.0');
  equal(updater.snapshot().phase, 'idle');
  equal(updater.snapshot().currentVersion, '1.0.0');
  deepEqual(
    getEvents().map((s) => s.phase),
    ['checking', 'confirm', 'installing', 'swapping', 'verifying', 'idle']
  );
});

test('② 非法迁移 dev 下 throw（idle → installing）', () => {
  const { updater } = makeUpdater();
  throws(() => updater.callTransition(UpgradePhase.Installing, 'x'), /非法状态迁移: idle -> installing/);
});

test('③ check 有新版本 → confirm + targetVersion', async () => {
  const { updater } = makeUpdater({ registryHasUpdate: true });
  const r = await updater.check();
  equal(r.hasUpdate, true);
  equal(updater.snapshot().phase, 'confirm');
  equal(updater.snapshot().targetVersion, '1.0.0');
});

test('④ check 无更新 → idle', async () => {
  const { updater } = makeUpdater({ registryHasUpdate: false });
  const r = await updater.check();
  equal(r.hasUpdate, false);
  equal(updater.snapshot().phase, 'idle');
});

test('⑤ check 失败 → idle + check-failed 语义', async () => {
  const { updater } = makeUpdater({ registryThrow: true });
  const r = await updater.check();
  equal(r.hasUpdate, false);
  equal(updater.snapshot().phase, 'idle');
  equal(updater.snapshot().error, 'check-failed');
});

test('⑥ upgrade 全链路成功：调用序 + currentVersion=target + 注入残留清理', async () => {
  const prev = process.env.HULL_PROBE_TARGET;
  process.env.HULL_PROBE_TARGET = 'http://127.0.0.1:1';
  try {
    const { updater, calls } = makeUpdater();
    await updater.check();
    await updater.upgrade('1.0.0');
    equal(updater.snapshot().phase, 'idle');
    equal(updater.snapshot().currentVersion, '1.0.0');
    // 调用序：install → stop → swap → start（设计 §4.1：停子进程在替换前）
    deepEqual(calls, ['registry.check', 'overlay.install', 'runtime.stop', 'overlay.swap', 'runtime.start#1']);
    equal(process.env.HULL_PROBE_TARGET, undefined, '成功路径清除注入残留');
  } finally {
    if (prev === undefined) delete process.env.HULL_PROBE_TARGET;
    else process.env.HULL_PROBE_TARGET = prev;
  }
});

test('⑦ swap 返回非 ready（overlay cancelled 标志）→ cancelled：idle + 原版保留 + 不 start', async () => {
  const { updater, calls } = makeUpdater({ swapNonReady: true });
  await updater.check();
  await rejects(updater.upgrade('1.0.0'), (e: unknown) => (e as { code: string }).code === 'cancelled');
  equal(updater.snapshot().phase, 'idle');
  equal(updater.snapshot().error, 'cancelled');
  ok(!calls.some((c) => c.startsWith('runtime.start')), '不 start');
  ok(calls.includes('runtime.stop'), '替换序列前半已执行');
});
test('⑧ start reject（verify 失败）→ 自动回滚：verify-start → stop → swapBack → 恢复 start', async () => {
  const { updater, calls } = makeUpdater({ startRejectAt: 1 });
  await updater.check();
  const s = await updater.upgrade('1.0.0'); // 回滚成功 → 🟢-B 非失败语义，resolve
  equal(s.phase, 'idle');
  equal(s.currentVersion, '0.9.0');
  const start1 = calls.indexOf('runtime.start#1');
  const stopAfterStart1 = calls.findIndex((c, i) => c === 'runtime.stop' && i > start1); // 回滚段的 stop
  const swapBackIdx = calls.indexOf('overlay.swapBack');
  const start2 = calls.indexOf('runtime.start#2');
  ok(start1 !== -1 && stopAfterStart1 !== -1 && swapBackIdx !== -1 && start2 !== -1);
  ok(start1 < stopAfterStart1 && stopAfterStart1 < swapBackIdx && swapBackIdx < start2, 'verify-start → stop → swapBack → 恢复 start');
});

test('⑨ 回滚恢复 start 前 HULL_PROBE_TARGET 已删除（注入生命周期两段）', async () => {
  const prev = process.env.HULL_PROBE_TARGET;
  process.env.HULL_PROBE_TARGET = 'http://127.0.0.1:1';
  try {
    const { updater, starts } = makeUpdater({ startRejectAt: 1 });
    await updater.check();
    await updater.upgrade('1.0.0');
    equal(starts.length, 2);
    equal(starts[0].probeTarget, 'http://127.0.0.1:1', 'verify 段注入可用');
    equal(starts[1].probeTarget, undefined, '回滚恢复段注入已清（B3）');
  } finally {
    if (prev === undefined) delete process.env.HULL_PROBE_TARGET;
    else process.env.HULL_PROBE_TARGET = prev;
  }
});

test('⑩ 回滚成功 currentVersion 回写 previous 版本 + 🟢-B 非失败语义', async () => {
  const { updater } = makeUpdater({ startRejectAt: 1 });
  await updater.check();
  const s = await updater.upgrade('1.0.0');
  equal(s.currentVersion, '0.9.0');
  equal(updater.snapshot().currentVersion, '0.9.0', 'B11 回写 previous 版本');
  equal(updater.snapshot().error, null, '🟢-B：回滚成功非失败语义');
});

test('⑪ 手动 rollback（ready 态）：stop → swapBack → start 三步', async () => {
  const { updater, calls } = makeUpdater();
  const s = await updater.rollback();
  equal(s.phase, 'idle');
  equal(s.currentVersion, '0.9.0');
  deepEqual(calls, ['runtime.stop', 'overlay.swapBack', 'runtime.start#1']);
  equal(updater.snapshot().message, '已回滚，原版本可用');
});

test('⑫ canRollback false → rollback-unavailable，不执行回滚', async () => {
  const { updater, calls } = makeUpdater({ canRollback: false });
  const s = await updater.rollback();
  equal(s.phase, 'idle');
  equal(s.error, 'rollback-unavailable');
  ok(!calls.includes('overlay.swapBack'), '未执行回滚');
});

test('⑬ cancel（installing 段）→ idle 原版保留，不 stop/swap/start', async () => {
  const { updater, calls, releaseInstall } = makeUpdater({ installPending: true });
  await updater.check();
  const p = updater.upgrade('1.0.0');
  equal(updater.snapshot().phase, 'installing');
  await updater.cancel();
  equal(updater.snapshot().phase, 'idle');
  equal(updater.snapshot().error, 'cancelled');
  releaseInstall();
  const s = await p;
  equal(s.phase, 'idle');
  ok(!calls.some((c) => c.startsWith('runtime.')), '未执行 stop/start');
  ok(!calls.includes('overlay.swap'), '未执行 swap');
});

test('⑭ swapping 段 cancel 忽略（仅 installing 可取消）', async () => {
  const { updater, releaseStop } = makeUpdater({ stopPending: true });
  await updater.check();
  const p = updater.upgrade('1.0.0');
  await new Promise((r) => setTimeout(r, 10)); // install 完成 → swapping（stop 挂起）
  equal(updater.snapshot().phase, 'swapping');
  const s = await updater.cancel();
  equal(s.phase, 'swapping', '取消被忽略');
  releaseStop();
  await p;
  equal(updater.snapshot().phase, 'idle');
});

test('⑮ 队列被 hull 占用 → upgrade queue-busy', async () => {
  const { updater, queue } = makeUpdater();
  await updater.check();
  queue.acquire('hull'); // 外部占用（S5 场景）
  await rejects(updater.upgrade('1.0.0'), (e: unknown) => (e as { code: string }).code === 'queue-busy');
  equal(updater.snapshot().phase, 'idle');
  equal(updater.snapshot().error, 'queue-busy');
});

test('⑯ inFlightUpgrade：升级中暴露句柄，完成后为 null', async () => {
  const { updater, releaseInstall } = makeUpdater({ installPending: true });
  await updater.check();
  const p = updater.upgrade('1.0.0');
  ok(updater.inFlightUpgrade() !== null, '升级中暴露完成句柄（B8）');
  releaseInstall();
  await p;
  equal(updater.inFlightUpgrade(), null, '完成后为 null');
});

test('⑰ swap 抛错 + overlay 非 ready → swap-broken', async () => {
  const { updater } = makeUpdater({ swapThrowCode: 'npm-install-failed' }); // 默认 swapThrowPhase=not-installed
  await updater.check();
  await rejects(updater.upgrade('1.0.0'), (e: unknown) => (e as { code: string }).code === 'swap-broken');
  equal(updater.snapshot().phase, 'idle');
  equal(updater.snapshot().error, 'swap-broken');
});

test('⑱ swap 抛错但 overlay 已回滚（Ready）→ swap-recovered（非 swap-broken/cancelled，B6 🟡-1）', async () => {
  const { updater } = makeUpdater({
    swapThrowCode: 'npm-install-failed',
    swapThrowPhase: InstallPhase.Ready,
  });
  await updater.check();
  await rejects(updater.upgrade('1.0.0'), (e: unknown) => (e as { code: string }).code === 'swap-recovered');
  equal(updater.snapshot().error, 'swap-recovered');
  ok(updater.snapshot().message.includes('已回滚'), '已回滚原版可用提示');
});

test('Y-1 check queue-busy：无 checking 闪事件', async () => {
  const { updater, queue, getEvents } = makeUpdater();
  queue.acquire('hull'); // 外部占用
  const r = await updater.check();
  equal(r.hasUpdate, false);
  equal(updater.snapshot().error, 'queue-busy');
  equal(updater.snapshot().phase, 'idle');
  ok(!getEvents().some((s) => s.phase === 'checking'), '无 checking 闪事件（acquire 失败直接返回）');
});

test('Y-2 canRollback 代理（契约 #8）：委托 swapManager', async () => {
  const a = makeUpdater();
  equal(a.updater.canRollback(), true);
  const b = makeUpdater({ canRollback: false });
  equal(b.updater.canRollback(), false);
});

test('S4-① upgrade() 缺省 target → resolveTarget 被调（latest 通道）', async () => {
  const { updater, channelCalls } = makeUpdater({ channel: {} });
  await updater.check();
  const s = await updater.upgrade(); // 缺省 → resolveTarget（返回 1.0.0）
  equal(s.phase, 'idle');
  equal(s.targetVersion, '1.0.0');
  ok(channelCalls().includes('resolveTarget'), '缺省目标经 resolveTarget');
});

test('S4-② upgrade() 缺省 target pinned → resolveTarget 返回 pinnedVersion', async () => {
  const { updater, channelCalls } = makeUpdater({ channel: { resolveTarget: '0.5.0' } });
  await updater.check();
  const s = await updater.upgrade();
  equal(s.targetVersion, '0.5.0', 'pinnedVersion 作为目标');
  ok(channelCalls().includes('resolveTarget'));
});

test('S4-③ 显式传参绕过 resolveTarget（解锁升级路径）', async () => {
  const { updater, channelCalls } = makeUpdater({ channel: {} });
  await updater.check();
  await updater.upgrade('1.0.0');
  ok(!channelCalls().includes('resolveTarget'), '显式目标不触发 resolveTarget');
});

test('S4-④ guard：target == 当前运行版本 → 拒绝「已在该版本」', async () => {
  const { updater, calls } = makeUpdater({ overlayVersion: '0.9.0', channel: {} });
  await updater.check();
  await rejects(updater.upgrade('0.9.0'), (e: unknown) => {
    return (e as { code: string }).code === 'version-invalid' && (e as Error).message.includes('已在该版本');
  });
  equal(updater.snapshot().phase, 'idle', '🔴-A：guard 后迁移 idle（不卡 Confirm）');
  ok(!calls.includes('overlay.install'), '未执行安装');
});

test('🔴-A guard 触发后再次 check() 可正常执行（不卡死）', async () => {
  const { updater } = makeUpdater({ overlayVersion: '0.9.0', channel: {} });
  await updater.check();
  await rejects(updater.upgrade('0.9.0'), (e: unknown) => (e as { code: string }).code === 'version-invalid');
  // 若 phase 卡 Confirm：check() 被非 idle 忽略（hasUpdate=false）；修复后正常执行（hasUpdate=true → confirm）
  const r = await updater.check();
  equal(r.hasUpdate, true, 'check 正常执行');
  equal(r.phase, 'confirm');
});

test('S4-⑤ 解锁升级成功 → set("latest") 回写（显式绕过 + pinned 通道）', async () => {
  const { updater, channelCalls } = makeUpdater({ channel: {} });
  await updater.check();
  await updater.upgrade('1.0.0'); // fake channel 默认 pinned → 解锁语义
  ok(channelCalls().includes('set:latest'), '成功后才回写 latest');
});

test('S4-⑤b 缺省 target（pinned 升级到 pinnedVersion）→ 不回写 latest', async () => {
  const { updater, channelCalls } = makeUpdater({ channel: { resolveTarget: '0.5.0' } });
  await updater.check();
  await updater.upgrade();
  ok(!channelCalls().includes('set:latest'), 'pinned 常态升级不回写');
});

test('S4-⑥ 解锁回写失败 → 告警容错，升级结果仍成功', async () => {
  const { updater } = makeUpdater({ channel: { setThrow: new Error('EACCES') } });
  await updater.check();
  const s = await updater.upgrade('1.0.0'); // set 抛错 → 不阻塞升级结果
  equal(s.phase, 'idle');
  equal(s.error, null);
});

test('S4-⑦ 不注入 channelService → 显式 upgrade 行为不变（回归）', async () => {
  const { updater, channelCalls } = makeUpdater(); // 无 channel
  await updater.check();
  const s = await updater.upgrade('1.0.0');
  equal(s.phase, 'idle');
  equal(s.currentVersion, '1.0.0');
});

test('S6-⑧ autoCheckDsh=false → isAutoCheckEnabled false', () => {
  const { updater } = makeUpdater({ settings: { autoCheckDsh: false } });
  equal(updater.isAutoCheckEnabled(), false);
});

test('S6-⑩ 默认（无 settingsProvider 注入）→ isAutoCheckEnabled true（S3 回归）', () => {
  const { updater } = makeUpdater();
  equal(updater.isAutoCheckEnabled(), true);
});

test('🟡-1 dismiss 后再次 check 可执行（S3 稍后再说路径）', async () => {
  const { updater } = makeUpdater();
  await updater.check();
  updater.dismiss();
  equal(updater.snapshot().phase, 'idle');
  const r = await updater.check(); // 若 phase 卡 Confirm 则被忽略（hasUpdate=false）
  equal(r.hasUpdate, true, '再次 check 正常执行');
  equal(r.phase, 'confirm');
});

test('Bug1 Confirm 态重新 check 返回真实结果（不误报「已是最新」）', async () => {
  const { updater, getEvents } = makeUpdater({ registryHasUpdate: true });
  await updater.check(); // idle → checking → confirm（发现新版，未点安装）
  equal(updater.snapshot().phase, 'confirm');
  equal(updater.snapshot().targetVersion, '1.0.0');
  // 再次 check：Confirm 态不拦截 → 重新查 registry（幂等刷新确认卡）
  const r = await updater.check();
  equal(r.hasUpdate, true, 'Confirm 态重新 check 返回真实结果（非 hasUpdate:false）');
  equal(r.phase, 'confirm');
  equal(updater.snapshot().targetVersion, '1.0.0');
  // 事件序列含 confirm→checking→confirm 合法迁移
  deepEqual(
    getEvents().map((s) => s.phase),
    ['checking', 'confirm', 'checking', 'confirm']
  );
});

test('Bug1 升级执行中 check 仍拦截（installing 态忽略，冲突保护保留）', async () => {
  const { updater, releaseInstall } = makeUpdater({ installPending: true });
  await updater.check();
  const p = updater.upgrade('1.0.0');
  equal(updater.snapshot().phase, 'installing');
  const r = await updater.check(); // installing = 执行中 → 拦截
  equal(r.hasUpdate, false);
  equal(r.phase, 'installing');
  releaseInstall();
  await p;
});

test('Bug3 overlay progress → installing 段 Updater pct 实时透传 + status 事件', async () => {
  const { updater, releaseInstall, emitProgress, getEvents } = makeUpdater({ installPending: true });
  await updater.check();
  const p = updater.upgrade('1.0.0');
  equal(updater.snapshot().phase, 'installing');
  // overlay 细粒度进度 50 → 75 → 90 逐帧透传（之前固定 50，Bug3 修复后实时）
  emitProgress(55);
  equal(updater.snapshot().pct, 55, 'overlay progress 55 透传 snapshot pct');
  emitProgress(72);
  equal(updater.snapshot().pct, 72, 'overlay progress 72 透传 snapshot pct');
  // 每次透传发 status 事件（event + tick 双源都读到真实进度）
  const installingEvents = getEvents().filter((s) => s.phase === 'installing');
  ok(installingEvents.some((s) => s.pct === 72), 'status 事件携带实时 pct');
  releaseInstall();
  const s = await p;
  equal(s.phase, 'idle');
  equal(s.pct, 100);
});
