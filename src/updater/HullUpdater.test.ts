import { test } from 'node:test';
import { equal, deepEqual, ok, rejects, throws } from 'node:assert/strict';

import { HullUpdater } from './HullUpdater';
import { UpgradeQueue } from './UpgradeQueue';
import { HullUpdatePhase, type HullUpdateStatus } from '../shared/types';
import type { ElectronUpdaterAdapter, UpdateInfo } from './electronUpdaterAdapter';

interface AdapterKnobs {
  checkResult?: UpdateInfo | null;
  checkThrow?: boolean;
  downloadThrow?: Error | null;
  downloadPending?: boolean;
  quitAndInstallThrow?: boolean;
}

function makeFakeAdapter(knobs: AdapterKnobs = {}) {
  const calls: string[] = [];
  let token: { cancel(): void } | null = null;
  let downloadGate: { resolve: () => void; reject: (e: Error) => void } | null = null;
  let errorCb: ((e: Error) => void) | null = null;
  const adapter: ElectronUpdaterAdapter = {
    checkForUpdates: async () => {
      calls.push('check');
      if (knobs.checkThrow) throw new Error('network');
      return knobs.checkResult === undefined ? { version: '0.2.0', releaseNotes: 'notes' } : knobs.checkResult;
    },
    downloadUpdate: async (t) => {
      calls.push('download');
      token = t ?? null;
      if (token) {
        const orig = token.cancel.bind(token);
        token.cancel = () => {
          calls.push('token.cancel');
          orig();
        };
      }
      if (knobs.downloadPending) {
        await new Promise<void>((resolve, reject) => {
          downloadGate = { resolve, reject };
        });
      }
      if (knobs.downloadThrow) throw knobs.downloadThrow;
    },
    quitAndInstall: () => {
      calls.push('quitAndInstall');
      if (knobs.quitAndInstallThrow) throw new Error('quit failed');
    },
    on: (event, cb) => {
      if (event === 'error') errorCb = cb as (e: Error) => void;
    },
  };
  return {
    adapter,
    calls,
    getToken: () => token,
    releaseDownload: (err?: Error) => {
      if (err) downloadGate?.reject(err);
      else downloadGate?.resolve();
    },
    emitError: (e: Error) => errorCb?.(e),
  };
}

/** 暴露受保护 transition 供测试 */
class ExposedHullUpdater extends HullUpdater {
  callTransition(to: HullUpdatePhase, message: string): boolean {
    return this.transition(to, message);
  }
}

function makeHullUpdater(overrides: { adapter?: AdapterKnobs; stopThrow?: boolean; settings?: { autoCheckHull?: boolean } } = {}) {
  const calls: string[] = [];
  const queue = new UpgradeQueue();
  const runtime = {
    stop: async () => {
      calls.push('runtime.stop');
      if (overrides.stopThrow) throw new Error('stop failed');
    },
  };
  const settings = { getSettings: () => ({ autoCheckHull: overrides.settings?.autoCheckHull ?? true }) };
  const fake = makeFakeAdapter(overrides.adapter);
  const updater = new ExposedHullUpdater({
    adapter: fake.adapter,
    queue,
    runtimeManager: runtime as unknown as import('../runtime/RuntimeManager').RuntimeManager,
    settingsProvider: settings as unknown as import('../settings/SettingsProvider').SettingsProvider,
    getVersion: () => '0.1.0',
    dev: true,
  });
  const events: HullUpdateStatus[] = [];
  updater.on('status', (s) => events.push(s));
  const prompts: Array<{ stage: string }> = [];
  updater.on('preventive-prompt', (p) => prompts.push(p));
  return { updater, queue, calls, fake, events, prompts };
}

test('① 6 态合法迁移 + status 事件序列', async () => {
  const { updater, events } = makeHullUpdater();
  await updater.check();
  equal(updater.snapshot().phase, 'confirm');
  await updater.download();
  equal(updater.snapshot().phase, 'restarting');
  await updater.installAndRestart();
  equal(updater.snapshot().phase, 'done');
  deepEqual(
    events.map((s) => s.phase),
    ['checking', 'confirm', 'downloading', 'restarting', 'done']
  );
});

test('② 非法迁移 dev 下 throw（idle → downloading）', () => {
  const { updater } = makeHullUpdater();
  throws(() => updater.callTransition(HullUpdatePhase.Downloading, 'x'), /非法状态迁移: idle -> downloading/);
});

test('③ check 有新版 → confirm + targetVersion/changeNotes', async () => {
  const { updater } = makeHullUpdater();
  const r = await updater.check();
  equal(r.hasUpdate, true);
  equal(updater.snapshot().phase, 'confirm');
  equal(updater.snapshot().targetVersion, '0.2.0');
  equal(updater.snapshot().changeNotes, 'notes');
});

test('④ check 无新版 → idle', async () => {
  const { updater } = makeHullUpdater({ adapter: { checkResult: null } });
  const r = await updater.check();
  equal(r.hasUpdate, false);
  equal(updater.snapshot().phase, 'idle');
});

test('⑤ check 失败 → idle + check-failed', async () => {
  const { updater } = makeHullUpdater({ adapter: { checkThrow: true } });
  const r = await updater.check();
  equal(r.hasUpdate, false);
  equal(updater.snapshot().phase, 'idle');
  equal(updater.snapshot().error, 'check-failed');
});

test('⑥ check 占槽（B2 全占槽）：有新版后队列持续持有', async () => {
  const { updater, queue } = makeHullUpdater();
  await updater.check();
  equal(queue.inFlight().channel, 'hull', 'check 后占槽');
  await updater.download();
  equal(queue.inFlight().channel, 'hull', 'download 续用同槽');
  await updater.installAndRestart();
  equal(queue.inFlight().channel, null, '终态释放');
});

test('⑦ download 完成 → restarting（Q-012 自动）', async () => {
  const { updater } = makeHullUpdater();
  await updater.check();
  await updater.download();
  equal(updater.snapshot().phase, 'restarting');
});

test('⑧ download 失败 → idle + download-failed', async () => {
  const { updater } = makeHullUpdater({ adapter: { downloadThrow: new Error('ECONNRESET') } });
  await updater.check();
  await rejects(updater.download(), (e: unknown) => (e as { code: string }).code === 'download-failed');
  equal(updater.snapshot().phase, 'idle');
  equal(updater.snapshot().error, 'download-failed');
});

test('⑨ cancel（downloading）→ token.cancel + idle', async () => {
  const { updater, fake } = makeHullUpdater({ adapter: { downloadPending: true } });
  await updater.check();
  const p = updater.download();
  equal(updater.snapshot().phase, 'downloading');
  updater.cancel();
  ok(fake.calls.includes('token.cancel'), 'CancellationToken.cancel 被调');
  fake.releaseDownload(new Error('cancelled'));
  await p;
  equal(updater.snapshot().phase, 'idle');
});

test('⑩ installAndRestart 全链路：acquire → stop → quitAndInstallMode → quitAndInstall', async () => {
  const { updater, calls, fake } = makeHullUpdater();
  await updater.check();
  await updater.download();
  await updater.installAndRestart();
  deepEqual(fake.calls, ['check', 'download', 'quitAndInstall'], 'adapter 调用序');
  ok(calls.includes('runtime.stop'), 'stop 在 quitAndInstall 前');
  equal(updater.isQuitAndInstallMode(), true, 'quitAndInstallMode 置位（before-quit 放行凭据）');
  equal(updater.snapshot().phase, 'done');
});

test('⑪ stop 失败 → idle + install-failed + 不调 quitAndInstall（B3）', async () => {
  const { updater, fake } = makeHullUpdater({ stopThrow: true });
  await updater.check();
  await updater.download();
  await rejects(updater.installAndRestart(), (e: unknown) => (e as { code: string }).code === 'install-failed');
  equal(updater.snapshot().phase, 'idle');
  equal(updater.snapshot().error, 'install-failed');
  ok(!fake.calls.includes('quitAndInstall'), '不调 quitAndInstall');
});

test('⑫ queue-busy（hull 被占）→ check 错误语义', async () => {
  const { updater, queue, events } = makeHullUpdater();
  queue.acquire('hull'); // 外部占用
  const r = await updater.check();
  equal(r.hasUpdate, false);
  equal(updater.snapshot().error, 'queue-busy');
  ok(!events.some((s) => s.phase === 'checking'), '无 checking 闪事件');
});

test('⑬ 预防性提示事件：仅 download 完成（confirm 不弹，🟡-1）', async () => {
  const { updater, prompts } = makeHullUpdater();
  await updater.check();
  ok(!prompts.some((p) => p.stage === 'confirm'), 'confirm 阶段不弹预防提示');
  await updater.download();
  ok(prompts.some((p) => p.stage === 'download-complete'), '下载完成预防性提示');
});

test('🔴-1 dismiss（稍后再说）：confirm → idle + 队列释放 + dsh 升级可恢复', async () => {
  const { updater, queue } = makeHullUpdater();
  await updater.check();
  equal(updater.snapshot().phase, 'confirm');
  equal(queue.inFlight().channel, 'hull');
  updater.dismiss();
  equal(updater.snapshot().phase, 'idle');
  equal(queue.inFlight().channel, null, '互斥槽释放');
  equal(queue.acquire('dsh'), true, 'dsh 升级可恢复（T5-03 不被永久锁死）');
});

test('🟡-2 adapter error 事件 → 映射 download-failed + idle + 队列释放', async () => {
  const { updater, fake, queue } = makeHullUpdater({ adapter: { downloadPending: true } });
  await updater.check();
  const p = updater.download();
  fake.emitError(new Error('download aborted'));
  equal(updater.snapshot().phase, 'idle');
  equal(updater.snapshot().error, 'download-failed');
  equal(queue.inFlight().channel, null, '队列已释放');
  fake.releaseDownload(new Error('cancelled')); // 下载 promise 随后 reject → 已被 error 处理，不双处理
  await p;
  equal(updater.snapshot().phase, 'idle');
});

test('🟡-3 quitAndInstall 抛错 → 复位 quitAndInstallMode + install-failed', async () => {
  const { updater, fake } = makeHullUpdater({ adapter: { quitAndInstallThrow: true } });
  await updater.check();
  await updater.download();
  await rejects(updater.installAndRestart(), (e: unknown) => (e as { code: string }).code === 'install-failed');
  equal(updater.isQuitAndInstallMode(), false, 'quitAndInstallMode 复位（防后续正常退出跳过 stop → 孤儿 dsh）');
  equal(updater.snapshot().phase, 'idle');
});

test('⑭ currentVersion = getVersion 注入（B8）', async () => {
  const { updater } = makeHullUpdater();
  equal(updater.snapshot().currentVersion, '0.1.0');
  await updater.check();
  equal(updater.snapshot().currentVersion, '0.1.0');
});

test('S6-⑨ autoCheckHull=false → isAutoCheckEnabled false', () => {
  const a = makeHullUpdater();
  equal(a.updater.isAutoCheckEnabled(), true, '默认 true');
  const b = makeHullUpdater({ settings: { autoCheckHull: false } });
  equal(b.updater.isAutoCheckEnabled(), false);
});
