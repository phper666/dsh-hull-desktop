/**
 * Skills IPC handler 工厂单测（S1 契约 4 通道 + S2 契约 7 通道）
 * 纯工厂不依赖 electron：scan 返回快照包裹 / searchRemote 校验 / getStatus 计数 / 操作层包裹
 */
import { test } from 'node:test';
import { deepEqual, equal, ok } from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { createSkillsHandlers } from './skillsHandlers';
import { SkillsScanner } from '../SkillsScanner';
import { SkillsOps } from '../ops/SkillsOps';
import { RestoreConflictError, SkillsUpgradeFailedError } from '../errors';

const tempDirs: string[] = [];
test.after(() => {
  for (const d of tempDirs) rmSync(d, { recursive: true, force: true });
});

async function makeFixture(): Promise<{ scanner: SkillsScanner; ops: SkillsOps }> {
  const home = mkdtempSync(join(tmpdir(), 'hull-skills-ipc-'));
  tempDirs.push(home);
  const dir = join(home, '.claude/skills/one');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'SKILL.md'), '---\nname: one\ndescription: d\n---\n');
  const scanner = new SkillsScanner({ homeDir: home, userDataPath: join(home, 'ud') });
  await scanner.scan();
  const ops = new SkillsOps({ homeDir: home, userDataPath: join(home, 'ud'), scanner });
  return { scanner, ops };
}

test('handlers 覆盖契约 13 通道（S1 4 + S2 7 + O-3 installRemote + setSource）', async () => {
  const { scanner, ops } = await makeFixture();
  const handlers = createSkillsHandlers(scanner, ops);
  deepEqual(Object.keys(handlers).sort(), [
    'skills:getDisabledList',
    'skills:getOperationLog',
    'skills:getSnapshot',
    'skills:getStatus',
    'skills:getTrashList',
    'skills:installRemote',
    'skills:remove',
    'skills:restoreFromTrash',
    'skills:scan',
    'skills:searchRemote',
    'skills:setEnabled',
    'skills:setSource',
    'skills:upgrade',
  ]);
});

test('skills:scan → ok:true + ScanSnapshot（ready 后 entries 就绪）', async () => {
  const { scanner, ops } = await makeFixture();
  const h = createSkillsHandlers(scanner, ops);
  const trig = await h['skills:scan']();
  equal(trig.ok, true);
  await h['skills:scan'](); // 再触发至 ready（首次触发返回 scanning 态）
  const snapRes = (await h['skills:getSnapshot']()) as { ok: true; data: { status: string; entries: unknown[] } };
  equal(snapRes.ok, true);
  equal(snapRes.data.status, 'ready');
  equal(snapRes.data.entries.length, 1);
});

test('skills:getStatus → StatusCounts；searchRemote 空 query → validation-error 包裹', async () => {
  const { scanner, ops } = await makeFixture();
  const h = createSkillsHandlers(scanner, ops);
  await h['skills:scan']();
  await h['skills:scan']();
  const status = (await h['skills:getStatus']()) as { ok: true; data: { total: number } };
  equal(status.data.total, 1);

  const bad = (await h['skills:searchRemote']('')) as { ok: false; code: string };
  equal(bad.ok, false);
  equal(bad.code, 'validation-error');

  const remote = await h['skills:searchRemote']('q', {
    runner: async () => ({ code: 0, stdout: JSON.stringify([{ name: 'r1' }]) }),
  });
  ok(remote.ok === true && remote.data.entries[0]!.installed === false);
});

test('S2 操作通道经门面：remove/setEnabled/getTrashList/getOperationLog 包裹形态', async () => {
  const { scanner, ops } = await makeFixture();
  const h = createSkillsHandlers(scanner, ops);
  const p = join(tempDirs[tempDirs.length - 1]!, '.claude/skills/one');

  const rm = (await h['skills:remove']([p])) as { ok: true; data: Array<{ status: string; trashId?: string }> };
  equal(rm.ok, true);
  equal(rm.data[0]!.status, 'removed');
  ok(rm.data[0]!.trashId!.startsWith('tr_'));

  const trash = (await h['skills:getTrashList']()) as { ok: true; data: { entries: unknown[] } };
  equal(trash.data.entries.length, 1);

  const restored = (await h['skills:restoreFromTrash'](rm.data[0]!.trashId!)) as { ok: true; data: { restoredPath: string } };
  equal(restored.data.restoredPath, p);

  const dis = (await h['skills:setEnabled'](p, false)) as { ok: true; data: { entryId?: string } };
  ok(dis.data.entryId!.startsWith('d_'));
  equal(((await h['skills:getDisabledList']()) as { ok: true; data: { entries: unknown[] } }).data.entries.length, 1);

  const logRes = (await h['skills:getOperationLog'](10)) as { ok: true; data: { entries: Array<{ action: string }> } };
  ok(logRes.data.entries.length >= 3); // remove/restore/disable 均留痕
});

test('S2 错误扩展字段达 IPC 响应（P1-2：契约异常表 method+rolledBack / targetPath）', async () => {
  const { scanner } = await makeFixture();
  const failOps = {
    upgrade: async () => {
      throw new SkillsUpgradeFailedError('升级替换失败已回滚: mock', 'git-staging', true);
    },
    restoreFromTrash: async () => {
      throw new RestoreConflictError('原路径已被占用，请先移走冲突项或手动处理', '/fake/original/path');
    },
  } as unknown as SkillsOps;
  const h = createSkillsHandlers(scanner, failOps);

  const up = (await h['skills:upgrade']('/p')) as { ok: false; code: string; message: string; method?: string; rolledBack?: boolean };
  equal(up.ok, false);
  equal(up.code, 'skills-upgrade-failed');
  equal(up.method, 'git-staging');
  equal(up.rolledBack, true);

  const rc = (await h['skills:restoreFromTrash']('tr_x')) as { ok: false; code: string; targetPath?: string };
  equal(rc.ok, false);
  equal(rc.code, 'restore-conflict');
  equal(rc.targetPath, '/fake/original/path');
});
