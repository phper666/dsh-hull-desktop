/**
 * B5 integration —— B2b 启动期自愈 + B3 merge（设计 §7.2 场景表 + 验收③④⑤）：
 * 半成品自愈（step=staged + incoming 不完整 + 源失效 → rolledBack，数据全量 hash 复原）/ 前向续做 /
 * 回滚中断续做幂等 / merge 冲突（同名笔记双份 + 工作流 id 冲突重生 + conflicts 非空）。
 */
import { test, after } from 'node:test';
import { deepEqual, equal, ok } from 'node:assert/strict';
import { existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { MANIFEST_FILENAME, type Manifest } from '../../../src/backup/manifest';
import { readPending, readResult, writePending, type PendingFile, type RestoreResult } from '../../../src/backup/result';
import { runRestoreIfPending } from '../../../src/backup/restoreExecutor';
import { NOOP_LOGGER } from '../../../src/shared/types';

import {
  cleanupTempDirs,
  mkTemp,
  readJson,
  seedFixture,
  treeHash,
  writeJson,
  writePackage,
  writeText,
} from './_helpers';

after(cleanupTempDirs);

const ALL_ITEMS = ['settings', 'kanban', 'workflows', 'notes', 'notes-trash', 'skills', 'notifs'] as const;

function pendingOf(over: Partial<PendingFile> & Pick<PendingFile, 'sourceDir' | 'step'>): PendingFile {
  return {
    version: 1,
    mode: 'replace',
    phase: 'forward',
    items: [...ALL_ITEMS],
    createdAt: '2026-09-18T00:00:00.000Z',
    failAt: null,
    ...over,
  };
}

test('⑫ 半成品自愈：step=staged + incoming 不完整 + 源失效 → rolledBack + 现数据全量 hash 复原', () => {
  const ud = mkTemp('hull-hl-ud-');
  seedFixture(ud);
  const before = treeHash(ud);

  // 手工构造半成品：incoming 只拷了 settings（不完整）+ 源目录已不可用
  const incoming = join(ud, '.restore', 'incoming');
  mkdirSync(incoming, { recursive: true });
  writeJson(join(incoming, 'settings.json'), { schemaVersion: 4, theme: 'dark' });
  writePending(ud, pendingOf({ sourceDir: join(ud, 'missing-package'), step: 'staged' }));

  const outcome = runRestoreIfPending({ userDataPath: ud, logger: NOOP_LOGGER });

  equal(outcome.status, 'rolledBack');
  equal(treeHash(ud), before, '现数据全量 hash 复原（零改动）');
  equal(readPending(ud), null, 'pending 已清');
  const result = readResult(ud);
  equal(result?.status, 'rolledBack');
  equal(result?.error, null, '回滚成功：无 failed 错误');
});

test('⑬ 崩溃后 incoming 不完整但源可用：重做 staging 续推成功（决策表 #7 前向分支）', () => {
  const pkg = mkTemp('hull-hl-pkg-');
  writePackage(pkg, { settings: { theme: 'dark' } });
  const manifest = readJson<Manifest>(join(pkg, MANIFEST_FILENAME));

  const ud = mkTemp('hull-hl-ud-');
  seedFixture(ud, { settings: { theme: 'light' } });
  const incoming = join(ud, '.restore', 'incoming');
  mkdirSync(incoming, { recursive: true });
  writeJson(join(incoming, 'settings.json'), { schemaVersion: 4, theme: 'dark' });
  writePending(
    ud,
    pendingOf({ sourceDir: pkg, step: 'staged', items: manifest.items.map((i) => i.id) }),
  );

  const outcome = runRestoreIfPending({ userDataPath: ud, logger: NOOP_LOGGER });

  equal(outcome.status, 'success');
  equal(readJson<{ theme: string }>(join(ud, 'settings.json')).theme, 'dark');
  const result = readResult(ud);
  equal(result?.status, 'success');
  equal(readPending(ud), null);
});

test('⑭ 回滚中断续做：phase=rolling-back + 部分已回 → 续做完成回滚，二次运行幂等', () => {
  const ud = mkTemp('hull-hl-ud-');
  // 现数据 = 已换入的包内内容
  writeJson(join(ud, 'settings.json'), { schemaVersion: 4, theme: 'pkg' });
  writeText(join(ud, 'notes', 'pkg.md'), '# pkg');
  // 预备份 = 本地原件
  writeJson(join(ud, '.restore', 'backup', 'settings.json'), { schemaVersion: 4, theme: 'local' });
  writeText(join(ud, '.restore', 'backup', 'notes', 'keep.md'), '# keep');
  // incoming = 包内 staging（源缺失时回滚的 pkgRoot 兜底）
  writeJson(join(ud, '.restore', 'incoming', 'settings.json'), { schemaVersion: 4, theme: 'pkg' });
  writeText(join(ud, '.restore', 'incoming', 'notes', 'pkg.md'), '# pkg');
  writePending(
    ud,
    pendingOf({
      sourceDir: join(ud, 'gone-pkg'),
      step: 'applied',
      phase: 'rolling-back',
      items: ['settings', 'notes'],
    }),
  );

  const out1 = runRestoreIfPending({ userDataPath: ud, logger: NOOP_LOGGER });
  equal(out1.status, 'rolledBack');
  equal(readJson<{ theme: string }>(join(ud, 'settings.json')).theme, 'local', '原件已还原');
  equal(readFileSync(join(ud, 'notes', 'keep.md'), 'utf8'), '# keep');
  // N3：回滚 copy 还原（backup 不消费）→ 包内独有文件必须清除，回滚后 = 恢复前状态
  ok(!existsSync(join(ud, 'notes', 'pkg.md')), '包内独有文件被清除（回滚后 = 恢复前状态）');
  ok(existsSync(join(ud, '.restore', 'backup', 'settings.json')), 'backup 不消费（原件保留）');
  equal(readResult(ud)?.status, 'rolledBack');

  // 二次运行：无 pending + 项齐全（backup 按 N3 copy 语义保留，决策表 #2 → cleanup 保留它，供人工兜底），数据与 result 不变（幂等）
  const after1 = treeHash(ud);
  const out2 = runRestoreIfPending({ userDataPath: ud, logger: NOOP_LOGGER });
  equal(out2.status, 'none');
  equal(treeHash(ud), after1, '二次运行幂等（现数据不变）');
  equal(readResult(ud)?.status, 'rolledBack', 'result 不被覆盖');
});

test('⑮ merge 冲突：同名不同内容笔记双份 + 同 id 工作流重 id + conflicts 非空（验收⑤）', () => {
  const pkg = mkTemp('hull-hl-pkg-');
  const pkgBoard = {
    id: 'b1',
    name: '包内板',
    columns: [],
    tasks: [],
    order: 0,
    createdAt: '2026-01-01',
    updatedAt: '2026-01-01',
  };
  const pkgManifest = writePackage(pkg, {
    settings: { theme: 'dark' },
    boards: { version: 2, boards: [pkgBoard] },
    notes: { 'a.md': '# pkg' },
    workflows: { version: 1, workflows: [{ id: 'wf_shared', name: '包内流', steps: [] }] },
  });
  const localBoard = {
    id: 'b1',
    name: '本地板',
    columns: [],
    tasks: [],
    order: 0,
    createdAt: '2026-01-01',
    updatedAt: '2026-01-01',
  };
  const ud = mkTemp('hull-hl-ud-');
  seedFixture(ud, {
    settings: { theme: 'light' },
    boards: { version: 2, boards: [localBoard] },
    notes: { 'a.md': '# local' },
    workflows: { version: 1, workflows: [{ id: 'wf_shared', name: '本地流', steps: [] }] },
  });
  writePending(
    ud,
    pendingOf({ sourceDir: pkg, mode: 'merge', step: 'requested', items: pkgManifest.items.map((i) => i.id) }),
  );

  const outcome = runRestoreIfPending({ userDataPath: ud, logger: NOOP_LOGGER });

  equal(outcome.status, 'success');
  // 笔记：本地版本保留原名，包内版本改名（双方均可检索）
  const mdFiles = readdirSync(join(ud, 'notes')).filter((n) => n.endsWith('.md'));
  equal(mdFiles.length, 2, `冲突双方都应保留（实际 ${mdFiles.join(',')}）`);
  equal(readFileSync(join(ud, 'notes', 'a.md'), 'utf8'), '# local');
  const conflictName = mdFiles.find((n) => n !== 'a.md');
  ok(conflictName?.includes('恢复冲突'), '包内版本改名为恢复冲突名');
  equal(readFileSync(join(ud, 'notes', conflictName!), 'utf8'), '# pkg');
  // 工作流：id 冲突重生，两条都在
  const workflows = readJson<{ workflows: Array<{ id: string; name: string }> }>(
    join(ud, 'workflows', 'workflows.json'),
  );
  equal(workflows.workflows.length, 2);
  equal(new Set(workflows.workflows.map((w) => w.id)).size, 2, 'id 不重复');
  ok(workflows.workflows.some((w) => w.id === 'wf_shared'), '包内 id 保留');
  // 看板：本地盘并入（id 冲突时重 id），包内板在
  const boards = readJson<{ boards: Array<{ name: string }> }>(join(ud, 'kanban', 'boards.json'));
  deepEqual(
    boards.boards.map((b) => b.name).sort(),
    ['包内板', '本地板'].sort(),
  );
  // result：merge 报告 + 冲突清单非空（验收④⑤）
  const result = readResult(ud) as RestoreResult;
  ok(result?.merge, 'merge 模式 result.merge 非空');
  ok(result!.merge!.conflicts.length > 0, '冲突清单非空');
  ok(
    result!.merge!.conflicts.some((c) => c.kind === 'note'),
    '含笔记冲突项',
  );
  // R3：成功后活跃 backup/ 已归档为 backup-<ts>/（result.bakDir 指向归档，供人工兜底）
  ok(result!.bakDir, 'result.bakDir 指向归档路径');
  ok(existsSync(join(result!.bakDir!, 'settings.json')), '.restore/backup 已归档（本地旧数据在归档中）');
  ok(!existsSync(join(ud, '.restore', 'backup')), '活跃 .restore/backup 不存在（歧义态消除）');
});
