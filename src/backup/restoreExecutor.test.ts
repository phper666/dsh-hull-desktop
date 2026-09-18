/**
 * B2b 启动期执行器单测：
 * - decideHeal 表驱动（设计 §2.5 全 11 行 + 回滚安全线）；
 * - nextStep/STEP_ORDER 边界；
 * - replace happy path（真 FS，临时 userData/包）；
 * - 半成品自愈：step='staged' + incoming/源缺失 → rolledBack 且现数据 hash 复原。
 */
import { test, after } from 'node:test';
import { equal, ok, deepEqual } from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { NOOP_LOGGER } from '../shared/types';

import { buildManifest, MANIFEST_FILENAME, type Manifest, type ManifestItem } from './manifest';
import { readPending, readResult, writePending, type PendingFile } from './result';
import {
  decideHeal,
  nextStep,
  runRestoreIfPending,
  STEP_ORDER,
  type ObservedState,
} from './restoreExecutor';
import { BACKUP_SCOPE, enumerateFiles, resolveItemPaths, type ScopeItemId } from './scope';

const tempDirs: string[] = [];
after(() => {
  for (const d of tempDirs) rmSync(d, { recursive: true, force: true });
});

function mkTemp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value));
}

function writeText(path: string, value: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, value);
}

// ─────────────────────────── decideHeal 表驱动（§2.5 全表） ───────────────────────────

function st(over: Partial<ObservedState>): ObservedState {
  return {
    hasPending: false,
    step: 'requested',
    phase: 'forward',
    sourceDirExists: false,
    incomingComplete: false,
    backupComplete: false,
    itemsInPlace: 'all',
    ...over,
  };
}

const HEAL_TABLE: Array<{ name: string; state: ObservedState; action: ReturnType<typeof decideHeal> }> = [
  { name: '#1 无 pending + 无 incoming/backup → cleanup', state: st({}), action: 'cleanup' },
  {
    name: '#2 无 pending + backup 有内容 + 现数据齐全 → cleanup（保留 backup）',
    state: st({ backupComplete: true, itemsInPlace: 'all' }),
    action: 'cleanup',
  },
  {
    name: '#3 无 pending + backup 有内容 + 现数据缺项 → rollback',
    state: st({ backupComplete: true, itemsInPlace: 'partial' }),
    action: 'rollback',
  },
  {
    name: '#4 pending(forward,requested) + sourceDir 存在 → continue',
    state: st({ hasPending: true, step: 'requested', sourceDirExists: true }),
    action: 'continue',
  },
  {
    name: '#5 pending(forward,requested) + sourceDir 不存在 → finish',
    state: st({ hasPending: true, step: 'requested', sourceDirExists: false }),
    action: 'finish',
  },
  {
    name: '#6 pending(forward,staged) + incoming 完整 → continue',
    state: st({ hasPending: true, step: 'staged', incomingComplete: true }),
    action: 'continue',
  },
  {
    name: '#7 pending(forward,staged) + incoming 不完整 → continue（重做 staging）',
    state: st({ hasPending: true, step: 'staged', incomingComplete: false }),
    action: 'continue',
  },
  {
    name: '#8 pending(forward,verified) → finish',
    state: st({ hasPending: true, step: 'verified' }),
    action: 'finish',
  },
  {
    name: '#9 pending(rolling-back) + backup 在 → rollback（续做）',
    state: st({ hasPending: true, step: 'applied', phase: 'rolling-back', backupComplete: true }),
    action: 'rollback',
  },
  {
    name: '#9b pending(rolling-back) + backup 空但 incoming 在 → rollback（N2：无原件但可清包内路径）',
    state: st({
      hasPending: true,
      step: 'backedUp',
      phase: 'rolling-back',
      backupComplete: false,
      incomingComplete: true,
    }),
    action: 'rollback',
  },
  {
    name: '#10 回滚续做 + 项既不在原位也不在 backup → rollback（N2/N3：回滚非破坏且幂等，不再 manual）',
    state: st({ hasPending: true, step: 'applied', phase: 'rolling-back', backupComplete: true, itemsInPlace: 'missing-unknown' }),
    action: 'rollback',
  },
  {
    name: '#10b 正向 + 项不可判定（backup 侧也无）→ continue（换机语义：无数据可保护，交 apply 落位）',
    state: st({ hasPending: true, step: 'applied', backupComplete: true, itemsInPlace: 'missing-unknown' }),
    action: 'continue',
  },
  {
    name: '#10c 无 pending + backup 有内容 + 项不可判定 → rollback（按 #3 补齐，不再 manual）',
    state: st({ backupComplete: true, itemsInPlace: 'missing-unknown' }),
    action: 'rollback',
  },
  {
    name: '#11 pending + backup 与 incoming 均缺失且 step ≥ backedUp → manual',
    state: st({ hasPending: true, step: 'backedUp', backupComplete: false, incomingComplete: false }),
    action: 'manual',
  },
  {
    name: '#11b rolling-back + step ≥ backedUp 且 backup 与 incoming 均缺失 → manual（无源可还原）',
    state: st({ hasPending: true, step: 'backedUp', phase: 'rolling-back', backupComplete: false }),
    action: 'manual',
  },
];

for (const row of HEAL_TABLE) {
  test(`decideHeal ${row.name}`, () => {
    equal(decideHeal(row.state), row.action);
  });
}

test('STEP_ORDER / nextStep：链式推进，verified 终点，未知 step 抛错', () => {
  deepEqual([...STEP_ORDER], ['requested', 'staged', 'backedUp', 'applied', 'verified']);
  equal(nextStep('requested'), 'staged');
  equal(nextStep('staged'), 'backedUp');
  equal(nextStep('backedUp'), 'applied');
  equal(nextStep('applied'), 'verified');
  equal(nextStep('verified'), null);
  let threw = false;
  try {
    nextStep('bogus' as never);
  } catch {
    threw = true;
  }
  ok(threw, '未知 step 必须抛错');
});

// ─────────────────────────── 真 FS fixture ───────────────────────────

/** 写一个含全部 7 项的合法包（内容按 profile 区分） */
function writeProfile(root: string, opts: { theme: string; note: string }): void {
  writeJson(join(root, 'settings.json'), { schemaVersion: 4, theme: opts.theme, notesDir: join(root, 'notes') });
  writeJson(join(root, 'kanban', 'boards.json'), { version: 2, boards: [] });
  writeJson(join(root, 'workflows', 'workflows.json'), { version: 1, workflows: [] });
  writeJson(join(root, 'notes', 'trash.json'), { entries: [] });
  writeJson(join(root, 'skills', 'disabled.json'), { version: 1, entries: [] });
  writeJson(join(root, 'skills', 'trash.json'), { version: 1, entries: [] });
  writeJson(join(root, 'notifications', 'notifications.json'), { version: 1, notifications: [] });
  writeJson(join(root, 'dismiss.json'), {});
  mkdirSync(join(root, 'notes', '.trash'), { recursive: true });
  writeFileSync(join(root, 'notes', opts.note), opts.note === 'a.md' ? '# pkg' : '# local');
}

/** 按 scope 规则从包目录生成 manifest（size/fileCount 与包实际一致） */
function manifestOfPackage(root: string): Manifest {
  const versions: Partial<Record<ScopeItemId, number | null>> = { settings: 4, kanban: 2, workflows: 1, notifs: 1 };
  const items: ManifestItem[] = [];
  for (const scope of BACKUP_SCOPE) {
    const resolved = resolveItemPaths(scope, { userDataPath: root, notesDir: join(root, 'notes') });
    if (!resolved) continue;
    const files = enumerateFiles(resolved.absSource, scope);
    if (files.length === 0) continue;
    let size = 0;
    for (const rel of files) {
      const abs = scope.kind === 'file' ? resolved.absSource : join(resolved.absSource, rel);
      size += statSync(abs).size;
    }
    items.push({
      id: scope.id,
      path: resolved.packRel,
      kind: scope.kind,
      version: versions[scope.id] ?? null,
      size,
      fileCount: files.length,
    });
  }
  return buildManifest({
    appVersion: '0.1.9',
    platform: process.platform,
    exportedAt: new Date('2026-09-18T00:00:00.000Z'),
    notesDirHint: join(root, 'notes'),
    items,
  });
}

function pendingOf(sourceDir: string, manifest: Manifest, step: PendingFile['step']): PendingFile {
  return {
    version: 1,
    mode: 'replace',
    phase: 'forward',
    step,
    sourceDir,
    items: manifest.items.map((i) => i.id),
    createdAt: '2026-09-18T00:00:00.000Z',
    failAt: null,
  };
}

/** 只含指定项 id 的假 manifest（回滚/异常路径用；不参与 fileCount 对账） */
function fakeManifestFor(ids: ScopeItemId[], notesDir: string): Manifest {
  return buildManifest({
    appVersion: '0.1.9',
    platform: process.platform,
    exportedAt: new Date('2026-09-18T00:00:00.000Z'),
    notesDirHint: notesDir,
    items: ids.map((id) => {
      const scope = BACKUP_SCOPE.find((s) => s.id === id)!;
      return { id, path: scope.packRel ?? scope.rel, kind: scope.kind, version: null, size: 1, fileCount: 1 };
    }),
  });
}

/** 手工模拟已完成的 S1：按 scope 规则把包内容拷入 `.restore/incoming` + manifest 拷入 `.restore/manifest.json` */
function stagePackageInto(pkgRoot: string, ud: string, manifest: Manifest): void {
  const incoming = join(ud, '.restore', 'incoming');
  for (const scope of BACKUP_SCOPE) {
    const resolved = resolveItemPaths(scope, { userDataPath: pkgRoot, notesDir: join(pkgRoot, 'notes') });
    if (!resolved) continue;
    for (const rel of enumerateFiles(resolved.absSource, scope)) {
      const src = scope.kind === 'file' ? resolved.absSource : join(resolved.absSource, rel);
      const dst = scope.kind === 'file' ? join(incoming, resolved.packRel) : join(incoming, resolved.packRel, rel);
      mkdirSync(dirname(dst), { recursive: true });
      copyFileSync(src, dst);
    }
  }
  mkdirSync(join(ud, '.restore'), { recursive: true });
  copyFileSync(join(pkgRoot, MANIFEST_FILENAME), join(ud, '.restore', MANIFEST_FILENAME));
}

function sha256File(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

// ─────────────────────────── replace happy path ───────────────────────────

test('runRestoreIfPending：replace 全量恢复 + result(success) + pending 清除 + 旧数据进 backup', () => {
  const pkg = mkTemp('hull-b2-pkg-');
  writeProfile(pkg, { theme: 'dark', note: 'a.md' });
  const manifest = manifestOfPackage(pkg);
  writeFileSync(join(pkg, MANIFEST_FILENAME), JSON.stringify(manifest, null, 2));

  const ud = mkTemp('hull-b2-ud-');
  writeProfile(ud, { theme: 'light', note: 'old.md' });
  writePending(ud, pendingOf(pkg, manifest, 'requested'));

  const outcome = runRestoreIfPending({ userDataPath: ud, logger: NOOP_LOGGER });

  equal(outcome.status, 'success');
  const restored = JSON.parse(readFileSync(join(ud, 'settings.json'), 'utf8')) as { theme: string; notesDir: string };
  equal(restored.theme, 'dark');
  equal(restored.notesDir, join(pkg, 'notes'), '原路径存在 → notesDir 原样保留');
  ok(existsSync(join(ud, 'notes', 'a.md')), '包内笔记应换入');
  ok(!existsSync(join(ud, 'notes', 'old.md')), '本地旧笔记应移入 backup');
  ok(!existsSync(join(ud, '.restore', 'backup')), 'R3：成功后活跃 backup 已归档（不再残留）');
  const archived = readResult(ud)?.bakDir;
  ok(archived, 'R3：result.bakDir 指向归档路径');
  ok(existsSync(join(archived!, 'notes', 'old.md')), '旧数据应在归档 backup-<ts> 中');
  equal(readPending(ud), null, 'pending 应清除');
  const result = readResult(ud);
  ok(result, 'result.json 应存在');
  equal(result!.status, 'success');
  equal(result!.mode, 'replace');
  equal(result!.merge, null);
  equal(result!.notices.some((n) => n.code === 'notes-dir-fallback'), false, '正常路径不产生回退提示');
});

test('runRestoreIfPending：replace 包内 notesDir 指向不存在路径 → 回退默认目录 + result.notices 记 notes-dir-fallback', () => {
  const pkg = mkTemp('hull-b2-pkg-');
  writeProfile(pkg, { theme: 'dark', note: 'a.md' });
  const missingNotesDir = join(pkg, 'gone-notes');
  writeJson(join(pkg, 'settings.json'), { schemaVersion: 4, theme: 'dark', notesDir: missingNotesDir });
  const manifest = manifestOfPackage(pkg);
  writeFileSync(join(pkg, MANIFEST_FILENAME), JSON.stringify(manifest));

  const ud = mkTemp('hull-b2-ud-');
  writeProfile(ud, { theme: 'light', note: 'old.md' });
  writePending(ud, pendingOf(pkg, manifest, 'requested'));

  const outcome = runRestoreIfPending({ userDataPath: ud, logger: NOOP_LOGGER });

  equal(outcome.status, 'success');
  const restored = JSON.parse(readFileSync(join(ud, 'settings.json'), 'utf8')) as { theme: string; notesDir: string };
  equal(restored.theme, 'dark', '其余字段仍为包内值');
  equal(restored.notesDir, join(ud, 'notes'), '不存在的原路径应回退默认目录');
  const result = readResult(ud);
  const notice = result?.notices.find((n) => n.code === 'notes-dir-fallback');
  ok(notice, 'result.notices 应含 notes-dir-fallback');
  ok(notice!.message.includes(missingNotesDir), 'notice 应含原路径');
  ok(notice!.message.includes(join(ud, 'notes')), 'notice 应含回退目录');
});

// ─────────────────────────── merge happy path ───────────────────────────

test('runRestoreIfPending：merge 同名笔记冲突 → 双份都在（改名）+ result.merge.conflicts 非空', () => {
  const pkg = mkTemp('hull-b2-pkg-');
  writeJson(join(pkg, 'settings.json'), { schemaVersion: 4, theme: 'dark', notesDir: join(pkg, 'notes') });
  mkdirSync(join(pkg, 'notes'), { recursive: true });
  writeFileSync(join(pkg, 'notes', 'a.md'), '# pkg');
  const manifest = manifestOfPackage(pkg);
  writeFileSync(join(pkg, MANIFEST_FILENAME), JSON.stringify(manifest));

  const ud = mkTemp('hull-b2-ud-');
  writeJson(join(ud, 'settings.json'), { schemaVersion: 4, theme: 'light', notesDir: join(ud, 'notes') });
  mkdirSync(join(ud, 'notes'), { recursive: true });
  writeFileSync(join(ud, 'notes', 'a.md'), '# local');
  writePending(ud, { ...pendingOf(pkg, manifest, 'requested'), mode: 'merge' });

  const outcome = runRestoreIfPending({ userDataPath: ud, logger: NOOP_LOGGER });

  equal(outcome.status, 'success');
  const notes = readdirSync(join(ud, 'notes'));
  const docs = notes.filter((n) => n.endsWith('.md'));
  equal(docs.length, 2, `冲突双方都应保留（实际 ${docs.join(',')}）`);
  equal(readFileSync(join(ud, 'notes', 'a.md'), 'utf8'), '# local', '本地版本保留原名（设计 §4.2）');
  ok(docs.some((n) => n.includes('恢复冲突')), '包内版本应改名存放');
  const result = readResult(ud);
  ok(result?.merge, 'merge 模式 result.merge 应非空');
  ok(result!.merge!.conflicts.length > 0, '冲突清单应非空');
});

// ─────────────────────────── 半成品自愈 ───────────────────────────

test('runRestoreIfPending：step=staged + incoming 缺 + 源缺失 → rolledBack 且现数据 hash 复原', () => {
  const ud = mkTemp('hull-b2-ud-');
  writeProfile(ud, { theme: 'light', note: 'keep.md' });
  const before = sha256File(join(ud, 'settings.json'));
  const beforeNote = sha256File(join(ud, 'notes', 'keep.md'));

  const fakeManifest = buildManifest({
    appVersion: '0.1.9',
    platform: process.platform,
    exportedAt: new Date('2026-09-18T00:00:00.000Z'),
    notesDirHint: join(ud, 'notes'),
    items: [{ id: 'settings', path: 'settings.json', kind: 'file', version: 4, size: 1, fileCount: 1 }],
  });
  const pending: PendingFile = {
    ...pendingOf(join(ud, 'missing-pkg'), fakeManifest, 'staged'),
  };
  writePending(ud, pending);

  const outcome = runRestoreIfPending({ userDataPath: ud, logger: NOOP_LOGGER });

  equal(outcome.status, 'rolledBack');
  equal(sha256File(join(ud, 'settings.json')), before, 'settings 必须原样复原');
  equal(sha256File(join(ud, 'notes', 'keep.md')), beforeNote, '笔记必须原样复原');
  equal(readPending(ud), null, 'pending 应清除');
  const result = readResult(ud);
  equal(result?.status, 'rolledBack');
});

test('runRestoreIfPending：无 pending 且 .restore 干净 → none，无副作用', () => {
  const ud = mkTemp('hull-b2-ud-');
  writeProfile(ud, { theme: 'light', note: 'x.md' });
  const outcome = runRestoreIfPending({ userDataPath: ud, logger: NOOP_LOGGER });
  equal(outcome.status, 'none');
  equal(readResult(ud), null, '未发生恢复时不写 result');
});

// ─────────────────────────── replace 侧 missingPath 标注（CON-R-backup-008） ───────────────────────────

test('runRestoreIfPending：replace 后处理标注 skills 索引 missingPath（路径/实体缺失标 true，symlink 免实体判定）', () => {
  const pkg = mkTemp('hull-b2-pkg-');
  writeProfile(pkg, { theme: 'dark', note: 'a.md' });
  const alivePath = join(pkg, 'skills'); // 存在的原路径（正常启用路径语义）
  const gonePath = join(pkg, 'skills', 'gone-skill'); // 不存在的原路径（跨机失效）
  writeText(join(pkg, 'skills', 'trash', 'tr_alive', 'SKILL.md'), '# alive entity'); // 实体随包落位
  writeJson(join(pkg, 'skills', 'disabled.json'), {
    version: 1,
    entries: [
      { id: 'd_gone', skillName: 'gone-skill', originalPath: gonePath, kind: 'dir', affectedPlatforms: [], disabledAt: '2026-09-01T00:00:00.000Z' },
      { id: 'd_alive', skillName: 'alive-skill', originalPath: alivePath, kind: 'symlink', affectedPlatforms: [], disabledAt: '2026-09-01T00:00:00.000Z' },
      { id: 'd_entity', skillName: 'entity-skill', originalPath: alivePath, kind: 'dir', affectedPlatforms: [], disabledAt: '2026-09-01T00:00:00.000Z' },
    ],
  });
  writeJson(join(pkg, 'skills', 'trash.json'), {
    version: 1,
    entries: [
      { id: 'tr_gone', skillName: 'gone-skill', originalPath: gonePath, deletedAt: '2026-09-01T00:00:00.000Z', sizeBytes: 1, affectedPlatforms: [] },
      { id: 'tr_alive', skillName: 'alive-skill', originalPath: alivePath, deletedAt: '2026-09-01T00:00:00.000Z', sizeBytes: 2, affectedPlatforms: [] },
      { id: 'tr_entity', skillName: 'entity-skill', originalPath: alivePath, deletedAt: '2026-09-01T00:00:00.000Z', sizeBytes: 3, affectedPlatforms: [] },
    ],
  });
  const manifest = manifestOfPackage(pkg);
  writeFileSync(join(pkg, MANIFEST_FILENAME), JSON.stringify(manifest));

  const ud = mkTemp('hull-b2-ud-');
  writeProfile(ud, { theme: 'light', note: 'old.md' });
  writePending(ud, pendingOf(pkg, manifest, 'requested'));

  const outcome = runRestoreIfPending({ userDataPath: ud, logger: NOOP_LOGGER });

  equal(outcome.status, 'success');
  const disabled = JSON.parse(readFileSync(join(ud, 'skills', 'disabled.json'), 'utf8')) as { entries: Array<Record<string, unknown>> };
  equal(disabled.entries.length, 3, '标注不得增删条目');
  equal(disabled.entries[0].missingPath, true, '不存在原路径 → 标 missingPath');
  equal('missingPath' in disabled.entries[1], false, 'symlink 条目免实体判定（原路径存在 → 不标）');
  equal(disabled.entries[2].missingPath, true, '原路径存在但 disabled 实体目录缺失 → 标 missingPath');
  const trash = JSON.parse(readFileSync(join(ud, 'skills', 'trash.json'), 'utf8')) as { entries: Array<Record<string, unknown>> };
  equal(trash.entries[0].missingPath, true);
  equal('missingPath' in trash.entries[1], false, '实体目录随包落位 → 不标');
  equal(trash.entries[2].missingPath, true, '原路径存在但 trash 实体目录缺失 → 标 missingPath');
  ok(existsSync(join(ud, 'skills', 'trash', 'tr_alive', 'SKILL.md')), '实体已落位（判定依据）');
});

test('runRestoreIfPending：replace 后处理已标注且无变更 → 不重复写（保持包内文件格式）', () => {
  const pkg = mkTemp('hull-b2-pkg-');
  writeProfile(pkg, { theme: 'dark', note: 'a.md' });
  const gonePath = join(pkg, 'skills', 'gone-already');
  writeFileSync(
    join(pkg, 'skills', 'disabled.json'),
    JSON.stringify(
      {
        version: 1,
        entries: [
          { id: 'd_1', skillName: 'x', originalPath: gonePath, kind: 'dir', affectedPlatforms: [], disabledAt: '2026-09-01T00:00:00.000Z', missingPath: true },
        ],
      },
      null,
      2,
    ),
  );
  const manifest = manifestOfPackage(pkg);
  writeFileSync(join(pkg, MANIFEST_FILENAME), JSON.stringify(manifest));

  const ud = mkTemp('hull-b2-ud-');
  writeProfile(ud, { theme: 'light', note: 'old.md' });
  writePending(ud, pendingOf(pkg, manifest, 'requested'));

  const outgoing = runRestoreIfPending({ userDataPath: ud, logger: NOOP_LOGGER });

  equal(outgoing.status, 'success');
  const raw = readFileSync(join(ud, 'skills', 'disabled.json'), 'utf8');
  ok(raw.includes('\n'), '已标注且无变更时不重写（应保持包内 2 空格缩进格式）');
  const parsed = JSON.parse(raw) as { entries: Array<Record<string, unknown>> };
  equal(parsed.entries.length, 1);
  equal(parsed.entries[0].missingPath, true);
});

// ─────────────────────────── R1：换机/缺项不再误判 manual ───────────────────────────

test('R1 全新 userData 多项缺失（backup 侧也无）→ replace 正常完成（不再 manual）', () => {
  const pkg = mkTemp('hull-b2-pkg-');
  writeProfile(pkg, { theme: 'dark', note: 'a.md' });
  const manifest = manifestOfPackage(pkg);
  writeFileSync(join(pkg, MANIFEST_FILENAME), JSON.stringify(manifest));

  const ud = mkTemp('hull-b2-ud-');
  // 全新目标机：只有 settings.json；workflows/notifications/notes/skills/... 本地无、backup 也无
  writeJson(join(ud, 'settings.json'), { schemaVersion: 4, theme: 'light', notesDir: join(ud, 'notes') });
  writePending(ud, pendingOf(pkg, manifest, 'requested'));

  const outcome = runRestoreIfPending({ userDataPath: ud, logger: NOOP_LOGGER });

  equal(outcome.status, 'success', '缺项两处皆无 = 无数据可保护，不得 manual');
  equal(readResult(ud)?.status, 'success');
  for (const rel of ['kanban/boards.json', 'workflows/workflows.json', 'notes/a.md', 'notifications/notifications.json', 'dismiss.json']) {
    ok(existsSync(join(ud, rel)), `缺项应直接落位：${rel}`);
  }
  equal((JSON.parse(readFileSync(join(ud, 'settings.json'), 'utf8')) as { theme: string }).theme, 'dark');
  equal(readPending(ud), null);
});

// ─────────────────────────── N2/N3：回滚幂等（copy 还原 + 包内残留清除） ───────────────────────────

test('N3 回滚 copy 还原：backup 不消费 + 包内独有文件清除 + 崩溃重跑幂等', () => {
  const ud = mkTemp('hull-b2-ud-');
  // 本机原件（backup 中；copy 语义下不被消费）
  writeJson(join(ud, '.restore', 'backup', 'settings.json'), { schemaVersion: 4, theme: 'local' });
  writeText(join(ud, '.restore', 'backup', 'notes', 'keep.md'), '# keep');
  // 已换入的包内容（含包内独有 pkg.md：本机从未有）
  writeJson(join(ud, 'settings.json'), { schemaVersion: 4, theme: 'pkg' });
  writeText(join(ud, 'notes', 'pkg.md'), '# pkg');
  // 本轮冻结快照
  writeJson(join(ud, '.restore', 'incoming', 'settings.json'), { schemaVersion: 4, theme: 'pkg' });
  writeText(join(ud, '.restore', 'incoming', 'notes', 'pkg.md'), '# pkg');
  const pending: PendingFile = {
    ...pendingOf(join(ud, 'gone-pkg'), fakeManifestFor(['settings', 'notes'], join(ud, 'notes')), 'applied'),
    phase: 'rolling-back',
  };
  writePending(ud, pending);

  const outcome = runRestoreIfPending({ userDataPath: ud, logger: NOOP_LOGGER });

  equal(outcome.status, 'rolledBack');
  equal(
    (JSON.parse(readFileSync(join(ud, 'settings.json'), 'utf8')) as { theme: string }).theme,
    'local',
    '原件已还原',
  );
  equal(readFileSync(join(ud, 'notes', 'keep.md'), 'utf8'), '# keep', 'backup 原件继续还原');
  ok(!existsSync(join(ud, 'notes', 'pkg.md')), 'N3：包内独有文件被清除（回滚后 = 恢复前状态）');
  ok(existsSync(join(ud, '.restore', 'backup', 'settings.json')), 'N3：backup 不被消费（原件保留）');
  equal(readResult(ud)?.status, 'rolledBack');

  // 模拟崩溃在清 pending 前：包内容再次落位 + 重写 pending → 重跑收敛同一状态（幂等）
  writeJson(join(ud, 'settings.json'), { schemaVersion: 4, theme: 'pkg' });
  writeText(join(ud, 'notes', 'pkg.md'), '# pkg');
  writePending(ud, pending);
  const out2 = runRestoreIfPending({ userDataPath: ud, logger: NOOP_LOGGER });
  equal(out2.status, 'rolledBack', 'backup 保留 → 重跑仍可完成');
  equal((JSON.parse(readFileSync(join(ud, 'settings.json'), 'utf8')) as { theme: string }).theme, 'local');
  ok(!existsSync(join(ud, 'notes', 'pkg.md')), '重跑仍清除包内独有文件');
  equal(readFileSync(join(ud, 'notes', 'keep.md'), 'utf8'), '# keep');
});

test('N2 半应用失败 + 包内独有项：回滚完成（不 manual）+ 包内独有清除 + 原件还原', () => {
  const ud = mkTemp('hull-b2-ud-');
  // applied 后崩溃/回滚中断：workflows 项为本机从未有的包内独有项（userData 与 backup 皆无）
  writeJson(join(ud, '.restore', 'backup', 'settings.json'), { schemaVersion: 4, theme: 'local' });
  writeJson(join(ud, '.restore', 'incoming', 'settings.json'), { schemaVersion: 4, theme: 'pkg' });
  writeJson(join(ud, '.restore', 'incoming', 'workflows', 'workflows.json'), { version: 1, workflows: [] });
  writePending(ud, {
    ...pendingOf(join(ud, 'gone-pkg'), fakeManifestFor(['settings', 'workflows'], join(ud, 'notes')), 'applied'),
    phase: 'rolling-back',
  });

  const outcome = runRestoreIfPending({ userDataPath: ud, logger: NOOP_LOGGER });

  equal(outcome.status, 'rolledBack', 'N2：missing-unknown 不再拦 manual');
  equal(readResult(ud)?.error, null);
  equal((JSON.parse(readFileSync(join(ud, 'settings.json'), 'utf8')) as { theme: string }).theme, 'local', '原件还原');
  ok(!existsSync(join(ud, 'workflows')), '包内独有项不残留（本机从未有 → 回滚后仍无）');
});

// ─────────────────────────── N3-1：#3 无 pending = repair-only（不删/不覆盖） ───────────────────────────

test('N3-1 #3 repair-only：显式回滚后删项再启动 → 缺失项补齐、现有文件不被旧数据覆盖', () => {
  const ud = mkTemp('hull-b2-ud-');
  // 显式回滚现场：现数据 = 已换入包内容；backup = 本机原件；incoming = 冻结快照
  writeJson(join(ud, 'settings.json'), { schemaVersion: 4, theme: 'pkg' });
  writeText(join(ud, 'notes', 'pkg.md'), '# pkg');
  writeJson(join(ud, '.restore', 'backup', 'settings.json'), { schemaVersion: 4, theme: 'local' });
  writeText(join(ud, '.restore', 'backup', 'notes', 'keep.md'), '# keep');
  writeJson(join(ud, '.restore', 'incoming', 'settings.json'), { schemaVersion: 4, theme: 'pkg' });
  writeText(join(ud, '.restore', 'incoming', 'notes', 'pkg.md'), '# pkg');
  writePending(ud, {
    ...pendingOf(join(ud, 'gone-pkg'), fakeManifestFor(['settings', 'notes'], join(ud, 'notes')), 'applied'),
    phase: 'rolling-back',
  });

  equal(runRestoreIfPending({ userDataPath: ud, logger: NOOP_LOGGER }).status, 'rolledBack', '显式回滚完成');
  ok(existsSync(join(ud, '.restore', 'backup', 'notes', 'keep.md')), 'N3：backup 保留（#3 场景前提）');

  // 回滚成功后：用户继续改数据 + 删掉一个 backup 中存在的项
  writeJson(join(ud, 'settings.json'), { schemaVersion: 4, theme: 'edited' });
  rmSync(join(ud, 'notes'), { recursive: true, force: true });

  const out = runRestoreIfPending({ userDataPath: ud, logger: NOOP_LOGGER });

  equal(out.status, 'rolledBack');
  equal(readFileSync(join(ud, 'notes', 'keep.md'), 'utf8'), '# keep', '缺失项从 backup 补齐');
  equal(
    (JSON.parse(readFileSync(join(ud, 'settings.json'), 'utf8')) as { theme: string }).theme,
    'edited',
    'N3-1：现数据不被旧 backup 覆盖（repair-only）',
  );
  ok(existsSync(join(ud, '.restore', 'backup', 'notes', 'keep.md')), 'N3：repair-only 仍不消费 backup');
});

test('N3-1 #3 repair-only：不删包内残留、不复制 backup 外内容（与 N3 显式回滚路径区分）', () => {
  const ud = mkTemp('hull-b2-ud-');
  // 活跃 backup（N3 copy 语义：回滚后保留）+ 无 pending
  writeJson(join(ud, '.restore', 'backup', 'settings.json'), { schemaVersion: 4, theme: 'local' });
  writeText(join(ud, '.restore', 'backup', 'notes', 'keep.md'), '# keep');
  // 冻结快照残留：settings.json 与本机现文件同名（显式回滚会先删再还原）；workflows.json 为包内独有
  writeJson(join(ud, '.restore', 'incoming', 'settings.json'), { schemaVersion: 4, theme: 'pkg' });
  writeJson(join(ud, '.restore', 'incoming', 'workflows', 'workflows.json'), { version: 1, workflows: [{ id: 'pkg-only' }] });
  writeJson(join(ud, 'settings.json'), { schemaVersion: 4, theme: 'kept' });
  // notes 项整体缺失 = #3 触发条件（backup 中有、本机无）

  const out = runRestoreIfPending({ userDataPath: ud, logger: NOOP_LOGGER });

  equal(out.status, 'rolledBack');
  equal(
    (JSON.parse(readFileSync(join(ud, 'settings.json'), 'utf8')) as { theme: string }).theme,
    'kept',
    '已存在文件不被删除/覆盖（repair-only 跳过步骤 1）',
  );
  ok(!existsSync(join(ud, 'workflows', 'workflows.json')), 'repair 只从 backup 补，不复制 incoming 独有内容');
  ok(existsSync(join(ud, '.restore', 'incoming', 'settings.json')), 'repair-only 不清理包内残留');
  equal(readFileSync(join(ud, 'notes', 'keep.md'), 'utf8'), '# keep', '缺失项仍从 backup 补齐');
});

// ─────────────────────────── R3：成功归档 + 活跃 backup 歧义消除 ───────────────────────────

test('R3 成功后 backup 归档：活跃 backup 消失；之后缺项不触发静默回滚', () => {
  const pkg = mkTemp('hull-b2-pkg-');
  writeProfile(pkg, { theme: 'dark', note: 'pkg.md' });
  const manifest = manifestOfPackage(pkg);
  writeFileSync(join(pkg, MANIFEST_FILENAME), JSON.stringify(manifest));

  const ud = mkTemp('hull-b2-ud-');
  writeProfile(ud, { theme: 'light', note: 'local.md' });
  writePending(ud, pendingOf(pkg, manifest, 'requested'));

  const outcome = runRestoreIfPending({ userDataPath: ud, logger: NOOP_LOGGER });
  equal(outcome.status, 'success');
  const result = readResult(ud);
  ok(result?.bakDir, 'result.bakDir 指向归档路径');
  ok(result!.bakDir!.startsWith(join(ud, '.restore', 'backup-')), `归档命名 backup-<ts>：${result!.bakDir}`);
  ok(existsSync(join(result!.bakDir!, 'notes', 'local.md')), '旧数据在归档中（人工兜底）');
  ok(!existsSync(join(ud, '.restore', 'backup')), '活跃 backup 不存在（歧义态消除）');

  // 数月后本机某白名单项缺失 → 不得按旧 backup 静默全量回滚
  rmSync(join(ud, 'workflows'), { recursive: true, force: true });
  const out2 = runRestoreIfPending({ userDataPath: ud, logger: NOOP_LOGGER });
  equal(out2.status, 'none');
  ok(!existsSync(join(ud, 'workflows')), '缺项不被静默回滚');
  equal(readResult(ud)?.status, 'success', 'result 不被覆盖');
  equal(readResult(ud)?.bakDir, result!.bakDir, '归档路径保持不变');
});

test('R3b 第二轮恢复：旧轮归档隔离，新轮 backup 只含本轮预映像（不混入旧轮）', () => {
  const pkg1 = mkTemp('hull-b2-pkg-');
  writeProfile(pkg1, { theme: 'dark', note: 'one.md' });
  const m1 = manifestOfPackage(pkg1);
  writeFileSync(join(pkg1, MANIFEST_FILENAME), JSON.stringify(m1));
  const ud = mkTemp('hull-b2-ud-');
  writeProfile(ud, { theme: 'light', note: 'local1.md' });
  writePending(ud, pendingOf(pkg1, m1, 'requested'));
  equal(runRestoreIfPending({ userDataPath: ud, logger: NOOP_LOGGER }).status, 'success');
  const arch1 = readResult(ud)!.bakDir;
  ok(arch1 && existsSync(join(arch1, 'notes', 'local1.md')), '第一轮归档含旧数据');

  // 第二轮：另一份包（不同笔记名/主题）
  const pkg2 = mkTemp('hull-b2-pkg-');
  writeProfile(pkg2, { theme: 'second', note: 'two.md' });
  const m2 = manifestOfPackage(pkg2);
  writeFileSync(join(pkg2, MANIFEST_FILENAME), JSON.stringify(m2));
  writePending(ud, pendingOf(pkg2, m2, 'requested'));
  equal(runRestoreIfPending({ userDataPath: ud, logger: NOOP_LOGGER }).status, 'success');

  const arch2 = readResult(ud)!.bakDir;
  ok(arch2 && arch2 !== arch1, '第二轮生成新归档');
  ok(!existsSync(arch1!), 'N1：旧成功归档被修剪（成功归档只保留最新 1 个）');
  ok(!existsSync(join(arch2!, 'notes', 'local1.md')), '新轮 backup 只含本轮预映像');
  ok(existsSync(join(arch2!, 'notes', 'one.md')), '第一轮恢复出的文件进入第二轮预映像');
  ok(existsSync(join(ud, 'notes', 'two.md')), '第二轮包内容落位');
  ok(!existsSync(join(ud, 'notes', 'one.md')), '第一轮文件已被本轮预映像移走');
  equal((JSON.parse(readFileSync(join(ud, 'settings.json'), 'utf8')) as { theme: string }).theme, 'second');
});

// ─────────────────────────── N1：新请求不删上轮唯一副本 ───────────────────────────

test('N1 新恢复请求：上轮未还原原件（backup）改名 backup-orphan-<ts> 保留，绝不 rm', () => {
  const pkg = mkTemp('hull-b2-pkg-');
  writeProfile(pkg, { theme: 'dark', note: 'a.md' });
  const manifest = manifestOfPackage(pkg);
  writeFileSync(join(pkg, MANIFEST_FILENAME), JSON.stringify(manifest));

  const ud = mkTemp('hull-b2-ud-');
  writeProfile(ud, { theme: 'light', note: 'old.md' });
  // 上轮回滚失败（result failed）：原件只存在于 .restore/backup
  writeJson(join(ud, '.restore', 'backup', 'settings.json'), { schemaVersion: 4, theme: 'only-copy' });
  writeText(join(ud, '.restore', 'backup', 'notes', 'lost.md'), '# only-copy');
  writePending(ud, pendingOf(pkg, manifest, 'requested'));

  const outcome = runRestoreIfPending({ userDataPath: ud, logger: NOOP_LOGGER });

  equal(outcome.status, 'success');
  const orphans = readdirSync(join(ud, '.restore')).filter((n) => n.startsWith('backup-orphan-'));
  equal(orphans.length, 1, `唯一副本应改名保留（实际 ${orphans.join(',')}）`);
  const orphan = join(ud, '.restore', orphans[0]);
  equal(
    (JSON.parse(readFileSync(join(orphan, 'settings.json'), 'utf8')) as { theme: string }).theme,
    'only-copy',
    '孤儿目录内原件未被删',
  );
  equal(readFileSync(join(orphan, 'notes', 'lost.md'), 'utf8'), '# only-copy');
  ok(!existsSync(join(ud, '.restore', 'backup')), '本轮成功 → 活跃 backup 已归档');
  const archived = readResult(ud)!.bakDir!;
  ok(archived.startsWith(join(ud, '.restore', 'backup-')), `归档路径 ${archived}`);
  equal(readFileSync(join(archived, 'notes', 'old.md'), 'utf8'), '# local', '归档只含本轮预映像');
  ok(!existsSync(join(archived, 'notes', 'lost.md')), '上轮孤儿不混入本轮归档');
  ok(existsSync(orphan), 'N1：孤儿目录不被修剪（清理入口记 v2）');
});

// ─────────────────────────── O6/O7：冻结快照 + 本地 manifest ───────────────────────────

test('O6 回滚删除集优先冻结快照 incoming：sourceDir 不可枚举时回滚仍完成', () => {
  const ud = mkTemp('hull-b2-ud-');
  writeText(join(ud, 'notes', 'keep.md'), '# keep-local');
  writeText(join(ud, 'notes', 'from-pkg.md'), '# pkg'); // 本轮已应用（userData + incoming 快照都在）
  writeText(join(ud, '.restore', 'backup', 'notes', 'keep.md'), '# keep-local'); // 待还原原件
  writeText(join(ud, '.restore', 'incoming', 'notes', 'from-pkg.md'), '# pkg'); // 本轮冻结快照
  // sourceDir 存在但不可枚举（包被移动/损坏）：旧逻辑优先枚举它 → 抛错 → 回滚失败
  const pkg = mkTemp('hull-b2-pkg-');
  writeJson(join(pkg, 'manifest.json'), {});
  writeText(join(pkg, 'notes', 'x.md'), '# x');
  chmodSync(join(pkg, 'notes'), 0o000);
  writePending(ud, {
    ...pendingOf(pkg, fakeManifestFor(['notes'], join(ud, 'notes')), 'applied'),
    phase: 'rolling-back',
  });

  try {
    const outcome = runRestoreIfPending({ userDataPath: ud, logger: NOOP_LOGGER });
    equal(outcome.status, 'rolledBack', 'incoming 优先 → 不枚举坏 sourceDir，回滚完成');
  } finally {
    chmodSync(join(pkg, 'notes'), 0o755);
  }
  equal(readResult(ud)?.status, 'rolledBack');
  equal(readFileSync(join(ud, 'notes', 'keep.md'), 'utf8'), '# keep-local', 'backup 原件已还原');
  ok(
    !existsSync(join(ud, 'notes', 'from-pkg.md')),
    'N3：包内独有文件被清除（回滚后 = 恢复前状态，不再保留残留）',
  );
  ok(existsSync(join(ud, '.restore', 'backup', 'notes', 'keep.md')), 'N3：backup 不消费（原件保留）');
});

test('O7 staging 后包被移走：本地 manifest 副本仍可完成恢复（step ≥ staged 不依赖 sourceDir）', () => {
  const pkg = mkTemp('hull-b2-pkg-');
  writeProfile(pkg, { theme: 'dark', note: 'a.md' });
  const manifest = manifestOfPackage(pkg);
  writeFileSync(join(pkg, MANIFEST_FILENAME), JSON.stringify(manifest));

  const ud = mkTemp('hull-b2-ud-');
  writeProfile(ud, { theme: 'light', note: 'old.md' });
  stagePackageInto(pkg, ud, manifest); // 模拟已完成的 S1：incoming + .restore/manifest.json
  writePending(ud, pendingOf(pkg, manifest, 'staged'));
  rmSync(pkg, { recursive: true, force: true }); // 包被移动/拔出

  const outcome = runRestoreIfPending({ userDataPath: ud, logger: NOOP_LOGGER });

  equal(outcome.status, 'success', '本地 manifest 副本可用 → 不依赖已移走的包');
  equal((JSON.parse(readFileSync(join(ud, 'settings.json'), 'utf8')) as { theme: string }).theme, 'dark');
  ok(existsSync(join(ud, 'notes', 'a.md')), '包内容仍落位');
  const result = readResult(ud);
  equal(result?.status, 'success');
  ok(
    result?.notices.some((n) => n.code === 'notes-dir-fallback'),
    '包内 notesDir 随包移走 → 回退默认目录（证明走完 apply 后处理）',
  );
});

// ─────────────────────────── Y1：顶层异常落盘 result ───────────────────────────

test('Y1 顶层异常 → 落盘 result(failed) + 清标记（不再每次启动静默重试）', () => {
  const ud = mkTemp('hull-b2-ud-');
  writeJson(join(ud, 'settings.json'), { schemaVersion: 4, theme: 'light' });
  writeText(join(ud, 'notes', 'a.md'), '# a');
  writeJson(join(ud, '.restore', 'backup', 'settings.json'), { schemaVersion: 4, theme: 'local' });
  // 不可读目录：回滚枚举 backup 时抛顶层异常（doRollback 无内层捕获）
  const bad = join(ud, '.restore', 'backup', 'notes');
  writeText(join(bad, 'x.md'), '# x');
  chmodSync(bad, 0o000);
  writePending(ud, {
    ...pendingOf(join(ud, 'gone-pkg'), fakeManifestFor(['settings', 'notes'], join(ud, 'notes')), 'applied'),
    phase: 'rolling-back',
  });

  let outcome: ReturnType<typeof runRestoreIfPending>;
  try {
    outcome = runRestoreIfPending({ userDataPath: ud, logger: NOOP_LOGGER });
  } finally {
    chmodSync(bad, 0o755);
  }

  equal(outcome.status, 'failed');
  const result = readResult(ud);
  equal(result?.status, 'failed', '异常也落盘 result.json（UI 可见）');
  equal(result?.error?.code, 'restore-apply-failed');
  equal(readPending(ud), null, 'pending 已清（不再静默重试）');
});
