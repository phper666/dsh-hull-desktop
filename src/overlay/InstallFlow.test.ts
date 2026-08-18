import { test, after } from 'node:test';
import { equal, deepEqual, ok } from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { InstallFlow } from './InstallFlow';
import { OverlayManager } from './OverlayManager';

const tempDirs: string[] = [];
after(() => {
  for (const d of tempDirs) rmSync(d, { recursive: true, force: true });
});

/** 构造完整 staging（门禁通过）：package.json{version,bin} + node_modules/.bin/dsh */
function populateStaging(userDataPath: string, version: string): void {
  const staging = join(userDataPath, 'dsh-staging');
  mkdirSync(join(staging, 'node_modules', '@deepseek-ai', 'dsh'), { recursive: true });
  writeFileSync(
    join(staging, 'node_modules', '@deepseek-ai', 'dsh', 'package.json'),
    JSON.stringify({ name: '@deepseek-ai/dsh', version, bin: { dsh: 'cli.js' } })
  );
  mkdirSync(join(staging, 'node_modules', '.bin'), { recursive: true });
  writeFileSync(join(staging, 'node_modules', '.bin', 'dsh'), '#!/usr/bin/env node\n');
}

/** 成功的 node 解压注入：建 bin/node + 版本文件 */
async function goodExtract(nodeDir: string): Promise<void> {
  mkdirSync(join(nodeDir, 'bin'), { recursive: true });
  writeFileSync(join(nodeDir, 'bin', 'node'), '#!/bin/sh\n');
  writeFileSync(join(nodeDir, 'node-version.txt'), 'v24.x\n');
}

interface MakeFlowOpts {
  extractNode?: (nodeDir: string) => Promise<void>;
  isDev?: boolean;
  diskFreeBytes?: () => number;
  pendingNpm?: boolean;
}

function makeFlow(opts: MakeFlowOpts = {}) {
  const userDataPath = mkdtempSync(join(tmpdir(), 'hull-flow-'));
  tempDirs.push(userDataPath);
  const events: Array<{ type: string; payload?: unknown }> = [];
  let npmControl: { resolve: () => void; reject: (e: Error) => void } | undefined;
  const overlay = new OverlayManager({
    userDataPath,
    runNpmInstall: async (stagingDir) => {
      if (opts.pendingNpm) {
        await new Promise<void>((resolve, reject) => {
          npmControl = { resolve, reject };
        });
      }
      populateStaging(userDataPath, '1.0.0');
    },
  });
  const flow = new InstallFlow({
    userDataPath,
    overlay,
    ...(opts.isDev !== undefined ? { isDev: opts.isDev } : {}),
    ...(opts.extractNode ? { extractNode: opts.extractNode } : {}),
    ...(opts.diskFreeBytes ? { diskFreeBytes: opts.diskFreeBytes } : {}),
  });
  flow.on('progress', (p) => events.push({ type: 'progress', payload: p }));
  return { flow, overlay, userDataPath, events, getNpmControl: () => npmControl };
}

test('⑨ node 解压失败：prod → runtime-unavailable；dev → 告警跳过继续', async () => {
  // prod：解压失败 → runtime-unavailable
  const a = makeFlow({
    extractNode: async () => {
      throw new Error('解压失败');
    },
  });
  const ra = await a.flow.run('1.0.0');
  equal(ra.ok, false);
  equal((ra as { code: string }).code, 'runtime-unavailable');
  // dev：解压失败 → 告警跳过（PATH 兜底）→ 全流程继续成功
  const b = makeFlow({
    extractNode: async () => {
      throw new Error('解压失败');
    },
    isDev: true,
  });
  const rb = await b.flow.run('1.0.0');
  equal(rb.ok, true);
  equal((rb as { version: string }).version, '1.0.0');
});

test('⑩ 磁盘不足 → disk-insufficient（注入 statfs 假数据）', async () => {
  const { flow } = makeFlow({
    extractNode: goodExtract,
    diskFreeBytes: () => 0,
  });
  const r = await flow.run('1.0.0');
  equal(r.ok, false);
  equal((r as { code: string }).code, 'disk-insufficient');
});

test('⑪ 全流程：解压 → 预检 → install → swap → success(version)', async () => {
  const { flow, userDataPath } = makeFlow({ extractNode: goodExtract });
  const r = await flow.run('1.0.0');
  equal(r.ok, true);
  equal((r as { version: string }).version, '1.0.0');
  ok(existsSync(join(userDataPath, 'dsh')), 'dsh 就位');
  ok(existsSync(join(userDataPath, 'node', 'node-version.txt')), 'node 版本文件落位');
});

test('⑫ 进度事件序列：download/10 → npm-install/50 → 90 → swap/100', async () => {
  const { flow, events } = makeFlow({ extractNode: goodExtract });
  await flow.run('1.0.0');
  deepEqual(
    events.map((e) => e.payload),
    [
      { phase: 'download', pct: 10 },
      { phase: 'npm-install', pct: 50 },
      { phase: 'npm-install', pct: 90 },
      { phase: 'swap', pct: 100 },
    ]
  );
});

test('🟡-1 InstallFlow：取消后 swap 返回非 ready → cancelled 语义（非 version-invalid）', async () => {
  const { flow, overlay, getNpmControl } = makeFlow({ extractNode: goodExtract, pendingNpm: true });
  const p = flow.run('1.0.0');
  // 等 install 进入 installing（npm pending），有界轮询防挂死
  for (let i = 0; i < 200 && overlay.installStatus().phase !== 'installing'; i++) {
    await new Promise((r) => setTimeout(r, 5));
  }
  equal(overlay.installStatus().phase, 'installing');
  await overlay.cancelInstall();
  getNpmControl()!.resolve();
  const r = await p;
  equal(r.ok, false);
  equal((r as { code: string }).code, 'cancelled');
});
