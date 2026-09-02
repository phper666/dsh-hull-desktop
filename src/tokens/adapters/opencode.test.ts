import { test } from 'node:test';
import { equal, ok } from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { createOpenCodeSource, opencodeDbPaths, parseOpenCodeDb, parseOpenCodeEntry, parseOpenCodeFile } from './opencode';

const FALLBACK = '1970-01-01T00:00:00.000Z';

/** 建 Session 表 fixture（行数组），db 落在 dir 内并返回路径（dir 由调用方 rmSync 清理；同名多次调用需传不同 name） */
function makeSessionDb(dir: string, rows: Array<Record<string, unknown>>, cols = ['id', 'Model', 'CreatedAt', 'PromptTokens', 'CompletionTokens', 'CacheCreationTokens', 'CacheReadTokens'], name = 'opencode.db'): string {
  const dbPath = join(dir, name);
  const db = new DatabaseSync(dbPath);
  try {
    db.exec(`CREATE TABLE Session (${cols.map((c) => `"${c}"`).join(', ')})`); // 无列类型声明 → 数值/字符串按原样存储
    const placeholders = cols.map(() => '?').join(', ');
    const stmt = db.prepare(`INSERT INTO Session (${cols.map((c) => `"${c}"`).join(', ')}) VALUES (${placeholders})`);
    for (const r of rows) stmt.run(...cols.map((c) => (r[c] ?? null) as string | number | null));
  } finally {
    db.close();
  }
  return dbPath;
}

// 真实格式样本：按月 JSON 数组，每条含 totals + byModel（2 模型）
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

test('createOpenCodeSource：listFiles 读 token-history/*.json + 端到端 parseFile', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hull-opencode-'));
  try {
    const th = join(dir, '.opencode', 'token-history');
    mkdirSync(th, { recursive: true });
    writeFileSync(join(th, '2026-09.json'), JSON.stringify([ENTRY]));
    writeFileSync(join(th, 'note.txt'), 'x');
    const src = createOpenCodeSource(dir);
    const files = src.listFiles();
    equal(files.length, 1, '只收 .json');
    equal(src.platform, 'opencode');
    const rs = src.parseFile!(JSON.stringify([ENTRY]), 'fallback');
    equal(rs.length, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('parseOpenCodeDb：Session 行 → UsageRecord（token 列 + 模型 + ISO 时间戳）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hull-opencode-pdb-'));
  try {
    const dbPath = makeSessionDb(dir, [
      { id: 's1', Model: 'deepseek-v4', CreatedAt: '2026-09-02T10:00:00.000Z', PromptTokens: 700, CompletionTokens: 150, CacheCreationTokens: 30, CacheReadTokens: 200 },
      { id: 's2', Model: 'gpt-5.2', CreatedAt: '2026-09-02T11:00:00.000Z', PromptTokens: 800, CompletionTokens: 60, CacheCreationTokens: 0, CacheReadTokens: 0 },
    ]);
    const recs = parseOpenCodeDb(dbPath, FALLBACK);
    equal(recs.length, 2);
    equal(recs[0].platform, 'opencode');
    equal(recs[0].model, 'deepseek-v4');
    equal(recs[0].inputTokens, 700);
    equal(recs[0].outputTokens, 150);
    equal(recs[0].cacheReadTokens, 200);
    equal(recs[0].cacheWriteTokens, 30);
    equal(recs[0].reasoningTokens, 0);
    equal(recs[0].ts, '2026-09-02T10:00:00.000Z');
    equal(recs[1].inputTokens, 800);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('parseOpenCodeDb：表缺失 / 关键列缺失 / db 不存在 → []（防御）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hull-opencode-def-'));
  try {
    // 无 Session 表
    const emptyDb = join(dir, 'empty.db');
    const db0 = new DatabaseSync(emptyDb);
    db0.close();
    equal(parseOpenCodeDb(emptyDb).length, 0, '无 Session 表 → []');
    // 列漂移：缺 CompletionTokens
    const driftDb = makeSessionDb(dir, [{ id: 's1', Model: 'm', CreatedAt: 't', PromptTokens: 100 }], ['id', 'Model', 'CreatedAt', 'PromptTokens']);
    equal(parseOpenCodeDb(driftDb).length, 0, '缺 CompletionTokens → []');
    // db 文件不存在
    equal(parseOpenCodeDb(join(dir, 'nope.db')).length, 0, 'db 不存在 → []');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('parseOpenCodeDb：cache 列缺失容忍（→0）+ 时间戳 unix ms 转 ISO + 缺 ts 列用 fallbackTs', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hull-opencode-tol-'));
  try {
    // 无 cache 列 + CreatedAt 为 unix ms 数字
    const msDb = makeSessionDb(dir, [{ id: 's1', Model: 'm1', CreatedAt: 1785000000000, PromptTokens: 111, CompletionTokens: 22 }], ['id', 'Model', 'CreatedAt', 'PromptTokens', 'CompletionTokens'], 'ms.db');
    const recs = parseOpenCodeDb(msDb, FALLBACK);
    equal(recs.length, 1);
    equal(recs[0].cacheReadTokens, 0, 'cache 列缺失 → 0');
    equal(recs[0].cacheWriteTokens, 0);
    equal(recs[0].ts, new Date(1785000000000).toISOString(), 'unix ms → ISO');
    // 无时间戳列 → fallbackTs
    const noTsDb = makeSessionDb(dir, [{ id: 's2', Model: 'm2', PromptTokens: 5, CompletionTokens: 6 }], ['id', 'Model', 'PromptTokens', 'CompletionTokens'], 'nots.db');
    const recs2 = parseOpenCodeDb(noTsDb, FALLBACK);
    equal(recs2.length, 1);
    equal(recs2[0].ts, FALLBACK);
    equal(recs2[0].model, 'm2');
    // 无模型列 → 'unknown'
    const noModelDb = makeSessionDb(dir, [{ id: 's3', PromptTokens: 7, CompletionTokens: 8 }], ['id', 'PromptTokens', 'CompletionTokens'], 'nomodel.db');
    equal(parseOpenCodeDb(noModelDb, FALLBACK)[0].model, 'unknown');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('createOpenCodeSource：token-history 有数据 → 只用 token-history（不碰 db）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hull-opencode-thonly-'));
  try {
    const th = join(dir, '.opencode', 'token-history');
    mkdirSync(th, { recursive: true });
    writeFileSync(join(th, '2026-09.json'), JSON.stringify([ENTRY]));
    // db 兜底路径存在且含不同数据——若误触发 db 会混入记录
    const rel = join(dir, 'Library', 'Application Support', 'opencode');
    mkdirSync(rel, { recursive: true });
    makeSessionDb(join(dir, 'Library', 'Application Support', 'opencode'), [{ id: 's1', Model: 'db-model', CreatedAt: 't', PromptTokens: 999, CompletionTokens: 999 }]);

    const src = createOpenCodeSource(dir);
    const files = src.listFiles();
    equal(files.length, 1);
    ok(files[0].endsWith('.json'), 'listFiles 返回 token-history json（非 db）');
    const text = src.readFile?.(files[0]) ?? '';
    const recs = src.parseFile?.(text, FALLBACK) ?? [];
    equal(recs.length, 2, '只用 token-history 数据');
    ok(recs.every((r) => r.model !== 'db-model'), 'db 记录未混入');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('createOpenCodeSource：token-history 缺失 → db 兜底（macOS 候选路径）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hull-opencode-dbfallback-'));
  try {
    const rel = join(dir, 'Library', 'Application Support', 'opencode');
    mkdirSync(rel, { recursive: true });
    makeSessionDb(rel, [{ id: 's1', Model: 'deepseek-v4', CreatedAt: '2026-09-02T10:00:00.000Z', PromptTokens: 700, CompletionTokens: 150, CacheCreationTokens: 30, CacheReadTokens: 200 }]);
    // 无 token-history 目录
    const src = createOpenCodeSource(dir);
    const files = src.listFiles();
    equal(files.length, 1);
    ok(files[0].endsWith('opencode.db'), 'listFiles 返回 db 路径兜底');
    const text = src.readFile?.(files[0]) ?? '';
    const recs = src.parseFile?.(text, FALLBACK) ?? [];
    equal(recs.length, 1);
    equal(recs[0].platform, 'opencode');
    equal(recs[0].model, 'deepseek-v4');
    equal(recs[0].inputTokens, 700);
    equal(recs[0].ts, '2026-09-02T10:00:00.000Z');
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
