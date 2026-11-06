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

/** v2 session_message 表 fixture（type 列区分角色；data 无 role，model 为对象）；可选同库附带 v1 message 表 */
function makeV2Db(
  dir: string,
  v2Rows: Array<{ id: string; type?: string; session_id?: string; time_created: number | null; data: string }>,
  v1Rows?: Array<{ id: string; session_id?: string; time_created: number | null; data: string }>,
  name = 'opencode.db',
): string {
  const dbPath = join(dir, name);
  const db = new DatabaseSync(dbPath);
  try {
    db.exec('CREATE TABLE session_message (id TEXT, session_id TEXT, type TEXT, seq INTEGER, time_created INTEGER, time_updated INTEGER, data TEXT)');
    const ins2 = db.prepare('INSERT INTO session_message (id, session_id, type, seq, time_created, time_updated, data) VALUES (?,?,?,?,?,?,?)');
    v2Rows.forEach((r, i) => ins2.run(r.id, r.session_id ?? 'ses_x', r.type ?? 'assistant', i, r.time_created, r.time_created, r.data));
    if (v1Rows) {
      db.exec('CREATE TABLE message (id TEXT, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT)');
      const ins1 = db.prepare('INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?,?,?,?,?)');
      for (const r of v1Rows) ins1.run(r.id, r.session_id ?? 'ses_x', r.time_created, r.time_created, r.data);
    }
  } finally {
    db.close();
  }
  return dbPath;
}

/** v2 data JSON 构造：无 role，model 为对象 {id,providerID,variant} */
const v2Data = (tokens: unknown, model?: string | Record<string, unknown>, extra: Record<string, unknown> = {}): string =>
  JSON.stringify({
    time: { created: 1 },
    ...(model ? { model: typeof model === 'string' ? { id: model } : model } : {}),
    ...(tokens !== undefined ? { tokens } : {}),
    ...extra,
  });

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

test('parseOpenCodeMessages：assistant 行 → per-request 快照逐行计（modelID/ts unix ms/output 含 reasoning）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hull-oc-msg-'));
  try {
    const t1 = 1785000000000;
    const t2 = 1785003600000;
    const dbPath = makeMessageDb(dir, [
      // per-request 快照：每行 tokens 即该请求用量（total 单调递增只是 context 增长表象，非累计）
      { id: 'm1', time_created: t1, data: msgData('assistant', { input: 700, output: 150, reasoning: 40, cache: { read: 200, write: 30 } }, 'deepseek-v4') },
      { id: 'm2', time_created: t2, data: msgData('assistant', { input: 900, output: 200, reasoning: 50, cache: { read: 300, write: 40 } }, 'gpt-5.2') },
    ]);
    const recs = parseOpenCodeMessages(dbPath);
    equal(recs.length, 2);
    equal(recs[0].platform, 'opencode');
    equal(recs[0].model, 'deepseek-v4', 'model 取 modelID');
    equal(recs[0].ts, new Date(t1).toISOString(), 'time_created unix ms → ISO');
    equal(recs[0].inputTokens, 700, '逐行直接计（快照即用量）');
    equal(recs[0].outputTokens, 150 + 40, 'output 含 reasoning（对齐 opencode 语义）');
    equal(recs[0].reasoningTokens, 40);
    equal(recs[0].cacheReadTokens, 200);
    equal(recs[0].cacheWriteTokens, 30);
    equal(recs[1].model, 'gpt-5.2');
    equal(recs[1].inputTokens, 900, '不做 session 级差分——每行独立计');
    equal(recs[1].outputTokens, 200 + 50, 'output 含 reasoning');
    equal(recs[1].reasoningTokens, 50);
    equal(recs[1].cacheReadTokens, 300);
    equal(recs[1].cacheWriteTokens, 40);
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

// ── per-request 快照语义边界（对齐 TokenTracker normalizeOpencodeTokens）──

test('parseOpenCodeMessages：cache.read 回退行独立计（不差分钳制）；reasoning 折入 output', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hull-oc-snap-'));
  try {
    // 真实形态：context 缩小时 cache.read 回退（70528 < 71424），但每行仍是独立请求用量
    const dbPath = makeMessageDb(dir, [
      { id: 'm1', time_created: 1000, data: msgData('assistant', { input: 5868, output: 65, reasoning: 15, cache: { read: 71424, write: 0 } }, 'mimo-v2.5-pro') },
      { id: 'm2', time_created: 2000, data: msgData('assistant', { input: 9356, output: 165, reasoning: 212, cache: { read: 70528, write: 0 } }, 'big-pickle') },
    ]);
    const recs = parseOpenCodeMessages(dbPath);
    equal(recs.length, 2);
    equal(recs[1].cacheReadTokens, 70528, 'cache.read 回退仍全量计（非 max(0) 钳制的 0）');
    equal(recs[1].model, 'big-pickle', '各行模型独立归属');
    equal(recs[1].outputTokens, 165 + 212);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── opencode v2：session_message 表（data 无 role，model 为对象）──

test('parseOpenCodeMessages：v2-only 库（session_message）→ 正确产出，model 取 data.model.id', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hull-oc-v2-'));
  try {
    const t1 = 1793900000000;
    const t2 = 1793903600000;
    const dbPath = makeV2Db(dir, [
      { id: 'e1', time_created: t1, data: v2Data({ input: 1000, output: 200, reasoning: 50, total: 1250, cache: { read: 400, write: 20 } }, 'deepseek-v4.1-flash') },
      { id: 'e2', time_created: t2, data: v2Data({ input: 300, output: 40, reasoning: 5, cache: { read: 0, write: 0 } }, { id: 'glm-5.3-flash', providerID: 'opencode-go', variant: 'max' }) },
    ]);
    const recs = parseOpenCodeMessages(dbPath);
    equal(recs.length, 2);
    equal(recs[0].model, 'deepseek-v4.1-flash', 'model 取 data.model.id');
    equal(recs[0].ts, new Date(t1).toISOString());
    equal(recs[0].inputTokens, 1000);
    equal(recs[0].outputTokens, 250, 'output 含 reasoning（口径不变）');
    equal(recs[0].cacheReadTokens, 400);
    equal(recs[0].cacheWriteTokens, 20);
    equal(recs[0].reasoningTokens, 50);
    equal(recs[1].model, 'glm-5.3-flash');
    equal(recs[1].outputTokens, 45);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('parseOpenCodeMessages：v1+v2 重叠库 → v2 全量 + v1 差集（session_id+time_created 去重，不重复计）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hull-oc-v2overlap-'));
  try {
    const shared = { input: 100, output: 10, reasoning: 1, cache: { read: 5, write: 0 } };
    const dbPath = makeV2Db(
      dir,
      [
        { id: 'e1', time_created: 1000, data: v2Data(shared, 'deepseek-v4.1-flash') },
        { id: 'e2', time_created: 2000, data: v2Data(shared, 'deepseek-v4.1-flash') },
      ],
      [
        // 与 v2 完全对齐的两行（重复，应被差集排除）
        { id: 'm1', time_created: 1000, data: msgData('assistant', shared, 'deepseek-v4.1-flash') },
        { id: 'm2', time_created: 2000, data: msgData('assistant', shared, 'deepseek-v4.1-flash') },
        // v2 缺失（v1 独有，应补回）
        { id: 'm3', time_created: 3000, data: msgData('assistant', shared, 'deepseek-flash') },
        // 非 assistant（始终跳过）
        { id: 'm4', time_created: 4000, data: msgData('user', shared, 'deepseek-flash') },
      ],
    );
    const recs = parseOpenCodeMessages(dbPath);
    equal(recs.length, 3, '2 v2 + 1 v1 独有（v1 重叠两行不计）');
    equal(recs.filter((r) => r.ts === new Date(1000).toISOString()).length, 1, '1447 对齐行只计一次');
    equal(recs.filter((r) => r.ts === new Date(3000).toISOString()).length, 1, 'v1 独有行补回');
    equal(recs.find((r) => r.ts === new Date(3000).toISOString())?.model, 'deepseek-flash');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('parseOpenCodeMessages：v2 无 tokens / 非 assistant / 全零 → 跳过；model 缺失 → unknown', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hull-oc-v2def-'));
  try {
    const t = 1793900000000;
    const dbPath = makeV2Db(dir, [
      { id: 'a', type: 'user', time_created: t, data: v2Data({ input: 9, output: 9, cache: { read: 0, write: 0 } }, 'm1') }, // 非 assistant → 跳过
      { id: 'b', time_created: t, data: v2Data(undefined, 'm2') }, // 无 tokens → 跳过
      { id: 'c', time_created: t, data: v2Data({ input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }, 'm3') }, // 全零 → 跳过
      { id: 'd', time_created: null, data: v2Data({ input: 5, output: 1, cache: { read: 0, write: 0 } }, 'm4') }, // 无 ts → 跳过
      { id: 'e', time_created: t, data: v2Data({ input: 7, output: 2, cache: { read: 0, write: 0 } }) }, // 无 model → unknown
    ]);
    const recs = parseOpenCodeMessages(dbPath);
    equal(recs.length, 1, '只留有值 assistant 行');
    equal(recs[0].model, 'unknown');
    equal(recs[0].inputTokens, 7);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('createOpenCodeSource：db 只有 v2 session_message 表 → 视为可用主源（不降级 token-history）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hull-oc-v2pick-'));
  try {
    const rel = join(dir, '.local', 'share', 'opencode');
    mkdirSync(rel, { recursive: true });
    makeV2Db(rel, [{ id: 'e1', time_created: 1793900000000, data: v2Data({ input: 11, output: 3, cache: { read: 0, write: 0 } }, 'deepseek-v4.1-flash') }]);
    const th = join(dir, '.opencode', 'token-history');
    mkdirSync(th, { recursive: true });
    writeFileSync(join(th, '2026-09.json'), JSON.stringify([ENTRY]));

    const src = createOpenCodeSource(dir);
    const files = src.listFiles();
    equal(files.length, 1);
    ok(files[0].endsWith('opencode.db'), 'listFiles 返回 db（v2 表可用）');
    const recs = src.parseFile?.(src.readFile?.(files[0]) ?? '', FALLBACK) ?? [];
    equal(recs.length, 1, 'v2 db 数据生效');
    ok(recs.every((r) => r.model !== 'new-api/glm-5.3-flash'), 'token-history 诱饵未混入');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
