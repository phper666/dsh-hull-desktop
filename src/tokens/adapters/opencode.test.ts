import { test } from 'node:test';
import { equal, ok } from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { createOpenCodeSource, opencodeDbPaths, parseOpenCodeMessages, parseOpenCodeEntry, parseOpenCodeFile } from './opencode';

const FALLBACK = '1970-01-01T00:00:00.000Z';

/** 建 message 表 fixture（data JSON 行），db 落在 dir 内并返回路径（dir 由调用方 rmSync 清理） */
function makeMessageDb(dir: string, rows: Array<{ id: string; time_created: number | null; data: string }>, name = 'opencode.db'): string {
  const dbPath = join(dir, name);
  const db = new DatabaseSync(dbPath);
  try {
    db.exec('CREATE TABLE message (id TEXT, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT)');
    const ins = db.prepare('INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?,?,?,?,?)');
    for (const r of rows) ins.run(r.id, 'ses_x', r.time_created, r.time_created, r.data);
  } finally {
    db.close();
  }
  return dbPath;
}

/** message.data JSON 构造 */
const msgData = (role: string, tokens: unknown, modelID?: string, extra: Record<string, unknown> = {}): string =>
  JSON.stringify({ role, ...(modelID ? { modelID } : {}), ...(tokens !== undefined ? { tokens } : {}), ...extra });

// 真实格式样本：按月 JSON 数组，每条含 totals + byModel（2 模型）——token-history 降级源格式
const ENTRY = {
  sessionID: 'ses_faa0e8ea8ffeTZylJzRTHnlOYu',
  projectID: '4f604cd87b5debc04b049a33bf94b14756d97915',
  timestamp: 1788319278155,
  totals: { input: 5344536, output: 116446, total: 5460982, reasoning: 71023, cache: { read: 102265280, write: 0 } },
  byModel: {
    'new-api/glm-5.3-flash': { input: 2704149, output: 55577, total: 2759726, reasoning: 61966, cache: { read: 58605248, write: 0 } },
    'new-api/deepseek-v4-flash-ga-260731': { input: 2640387, output: 60869, total: 2701256, reasoning: 9057, cache: { read: 43660032, write: 123 } },
  },
  cost: 0,
};

test('parseOpenCodeEntry：byModel 拆多条 UsageRecord（2 模型，ts 由 ms 转 ISO）', () => {
  const rs = parseOpenCodeEntry(ENTRY, '1970-01-01T00:00:00Z');
  equal(rs.length, 2, '2 模型 → 2 条');
  const byModel = Object.fromEntries(rs.map((r) => [r.model, r]));
  ok(byModel['new-api/glm-5.3-flash'], '有 glm 模型');
  ok(byModel['new-api/deepseek-v4-flash-ga-260731'], '有 deepseek 模型');
  for (const r of rs) {
    equal(r.platform, 'opencode');
    equal(r.ts, new Date(1788319278155).toISOString(), 'ms 转 ISO');
    ok(r.inputTokens > 0 && r.outputTokens > 0);
  }
  equal(byModel['new-api/glm-5.3-flash'].inputTokens, 2704149);
  equal(byModel['new-api/glm-5.3-flash'].outputTokens, 55577 + 61966, 'output 含 reasoning（reasoning>output 用例）');
  equal(byModel['new-api/glm-5.3-flash'].cacheReadTokens, 58605248);
  equal(byModel['new-api/glm-5.3-flash'].reasoningTokens, 61966);
  equal(byModel['new-api/deepseek-v4-flash-ga-260731'].outputTokens, 60869 + 9057, 'output 含 reasoning');
  equal(byModel['new-api/deepseek-v4-flash-ga-260731'].cacheWriteTokens, 123);
  equal(byModel['new-api/deepseek-v4-flash-ga-260731'].cacheReadTokens, 43660032);
});

test('parseOpenCodeEntry：无 byModel / 非对象 → 空；全零模型跳过', () => {
  equal(parseOpenCodeEntry({ timestamp: 1 }, 'x').length, 0);
  equal(parseOpenCodeEntry('str', 'x').length, 0);
  const zero = parseOpenCodeEntry({ timestamp: 1, byModel: { m: { input: 0, output: 0, cache: { read: 0, write: 0 } } } }, 'x');
  equal(zero.length, 0, '全零模型跳过');
});

test('parseOpenCodeFile：整 JSON 数组 → 全部记录', () => {
  const text = JSON.stringify([ENTRY, { sessionID: 's2', timestamp: 1788319278155, byModel: { 'model-b': { input: 5, output: 1, cache: { read: 0, write: 0 } } } }]);
  const rs = parseOpenCodeFile(text, 'fallback');
  equal(rs.length, 3);
  equal(parseOpenCodeFile('not-json', 'x').length, 0);
  equal(parseOpenCodeFile('{"a":1}', 'x').length, 0);
});

test('parseOpenCodeMessages：assistant 行 → per-message 记录（modelID/ts unix ms/output 含 reasoning）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hull-oc-msg-'));
  try {
    const t1 = 1785000000000;
    const t2 = 1785003600000;
    const dbPath = makeMessageDb(dir, [
      { id: 'm1', time_created: t1, data: msgData('assistant', { input: 700, output: 150, reasoning: 40, cache: { read: 200, write: 30 } }, 'deepseek-v4') },
      { id: 'm2', time_created: t2, data: msgData('assistant', { input: 800, output: 60, reasoning: 0, cache: { read: 0, write: 0 } }, 'gpt-5.2') },
    ]);
    const recs = parseOpenCodeMessages(dbPath);
    equal(recs.length, 2);
    equal(recs[0].platform, 'opencode');
    equal(recs[0].model, 'deepseek-v4', 'model 取 modelID');
    equal(recs[0].ts, new Date(t1).toISOString(), 'time_created unix ms → ISO');
    equal(recs[0].inputTokens, 700);
    equal(recs[0].outputTokens, 150 + 40, 'output 含 reasoning（对齐 opencode 语义）');
    equal(recs[0].reasoningTokens, 40);
    equal(recs[0].cacheReadTokens, 200);
    equal(recs[0].cacheWriteTokens, 30);
    equal(recs[1].model, 'gpt-5.2');
    equal(recs[1].outputTokens, 60, 'reasoning=0 时 output 不变');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('parseOpenCodeMessages：role 过滤 + 全零跳过 + data 损坏跳过 + 无 modelID → unknown', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hull-oc-msgdef-'));
  try {
    const t = 1785000000000;
    const dbPath = makeMessageDb(dir, [
      { id: 'a', time_created: t, data: msgData('user', { input: 100, output: 10, reasoning: 0, cache: { read: 0, write: 0 } }, 'm1') }, // 非 assistant → 跳过
      { id: 'b', time_created: t, data: msgData('assistant', { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }, 'm2') }, // 全零 → 跳过
      { id: 'c', time_created: t, data: '{broken json' }, // data 损坏 → 跳过
      { id: 'd', time_created: t, data: msgData('assistant', undefined, 'm3') }, // 无 tokens → 跳过
      { id: 'e', time_created: t, data: msgData('assistant', { input: 5, output: 1, reasoning: 0, cache: { read: 0, write: 0 } }) }, // 无 modelID → unknown
      { id: 'f', time_created: null, data: msgData('assistant', { input: 9, output: 9, reasoning: 0, cache: { read: 0, write: 0 } }, 'm4') }, // 无 ts → 跳过
    ]);
    const recs = parseOpenCodeMessages(dbPath);
    equal(recs.length, 1, '只留有值 assistant 行');
    equal(recs[0].model, 'unknown', '无 modelID → unknown');
    equal(recs[0].inputTokens, 5);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('parseOpenCodeMessages：表缺失 / db 不存在 → []（防御）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hull-oc-msgdef2-'));
  try {
    const emptyDb = join(dir, 'empty.db');
    const db0 = new DatabaseSync(emptyDb);
    db0.close();
    equal(parseOpenCodeMessages(emptyDb).length, 0, '无 message 表 → []');
    equal(parseOpenCodeMessages(join(dir, 'nope.db')).length, 0, 'db 不存在 → []');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('createOpenCodeSource：db 存在 → 主源 message 表（不读 token-history 诱饵）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hull-oc-dbfirst-'));
  try {
    // db（Linux 候选路径）+ token-history 诱饵（若误读会混入）
    const rel = join(dir, '.local', 'share', 'opencode');
    mkdirSync(rel, { recursive: true });
    const dbPath = makeMessageDb(rel, [{ id: 'm1', time_created: 1785000000000, data: msgData('assistant', { input: 700, output: 150, reasoning: 0, cache: { read: 0, write: 0 } }, 'deepseek-v4') }]);
    const th = join(dir, '.opencode', 'token-history');
    mkdirSync(th, { recursive: true });
    writeFileSync(join(th, '2026-09.json'), JSON.stringify([ENTRY]));

    const src = createOpenCodeSource(dir);
    const files = src.listFiles();
    equal(files.length, 1);
    ok(files[0].endsWith('opencode.db'), 'listFiles 返回 db（主源优先）');
    const text = src.readFile?.(files[0]) ?? '';
    const recs = src.parseFile?.(text, FALLBACK) ?? [];
    equal(recs.length, 1, '只用 db 数据');
    equal(recs[0].model, 'deepseek-v4');
    ok(recs.every((r) => r.model !== 'new-api/glm-5.3-flash'), 'token-history 诱饵未混入');
    ok(dbPath.endsWith('opencode.db'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('createOpenCodeSource：db 缺失 → token-history 兜底（端到端 parseFile）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hull-opencode-'));
  try {
    const th = join(dir, '.opencode', 'token-history');
    mkdirSync(th, { recursive: true });
    writeFileSync(join(th, '2026-09.json'), JSON.stringify([ENTRY]));
    writeFileSync(join(th, 'note.txt'), 'x');
    const src = createOpenCodeSource(dir);
    const files = src.listFiles();
    equal(files.length, 1, '只收 .json');
    ok(files[0].endsWith('.json'), 'db 缺失 → token-history json');
    equal(src.platform, 'opencode');
    const rs = src.parseFile!(JSON.stringify([ENTRY]), 'fallback');
    equal(rs.length, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('createOpenCodeSource：db 存在但 message 表缺失 → 降级 token-history', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hull-oc-nomsg-'));
  try {
    // db 存在但只有无关表（message 表不可用）
    const rel = join(dir, '.local', 'share', 'opencode');
    mkdirSync(rel, { recursive: true });
    const db = new DatabaseSync(join(rel, 'opencode.db'));
    try {
      db.exec('CREATE TABLE other (id TEXT)');
    } finally {
      db.close();
    }
    const th = join(dir, '.opencode', 'token-history');
    mkdirSync(th, { recursive: true });
    writeFileSync(join(th, '2026-09.json'), JSON.stringify([ENTRY]));

    const src = createOpenCodeSource(dir);
    const files = src.listFiles();
    ok(files.length === 1 && files[0].endsWith('.json'), 'message 表不可用 → 降级 token-history');
    const text = src.readFile?.(files[0]) ?? '';
    equal((src.parseFile?.(text, FALLBACK) ?? []).length, 2, 'token-history 数据生效');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('opencodeDbPaths：macOS 与 Linux 候选路径，只返回存在的', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hull-opencode-paths-'));
  try {
    equal(opencodeDbPaths(dir).length, 0, '无候选 → []');
    mkdirSync(join(dir, '.local', 'share', 'opencode'), { recursive: true });
    writeFileSync(join(dir, '.local', 'share', 'opencode', 'opencode.db'), 'x');
    const paths = opencodeDbPaths(dir);
    equal(paths.length, 1, 'Linux 候选存在');
    ok(paths[0].endsWith(join('.local', 'share', 'opencode', 'opencode.db')));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
