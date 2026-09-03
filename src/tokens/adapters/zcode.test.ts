import { test } from 'node:test';
import { equal, ok } from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createZcodeSource, matchZaiModel, parseZcodeSource } from './zcode';

/** 建真实 schema model_usage fixture → db 路径 */
function makeModelUsageDb(dir: string, rows: Array<Record<string, unknown>>): string {
  const dbPath = join(dir, 'db.sqlite');
  const db = new DatabaseSync(dbPath);
  try {
    db.exec(`CREATE TABLE model_usage (
      model_id TEXT, started_at INTEGER, status TEXT,
      input_tokens INTEGER, output_tokens INTEGER, reasoning_tokens INTEGER,
      cache_creation_input_tokens INTEGER, cache_read_input_tokens INTEGER
    )`);
    const cols = ['model_id', 'started_at', 'status', 'input_tokens', 'output_tokens', 'reasoning_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens'];
    const ins = db.prepare(`INSERT INTO model_usage (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`);
    for (const r of rows) ins.run(...cols.map((c) => (r[c] ?? null) as string | number | null));
  } finally {
    db.close();
  }
  return dbPath;
}

test('zcode：model_usage 精确路径——真实 schema 映射（unix ms → ISO、status 有值即计、GLM 过滤）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hull-zcode-mu-'));
  try {
    const dbPath = makeModelUsageDb(dir, [
      { model_id: 'GLM-5.3-Flash', started_at: 1785000000000, status: 'completed', input_tokens: 700, output_tokens: 150, reasoning_tokens: 40, cache_creation_input_tokens: 30, cache_read_input_tokens: 200 },
      { model_id: 'claude-sonnet-4-5', started_at: 1785001800000, status: 'completed', input_tokens: 999, output_tokens: 99, reasoning_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }, // 捆绑子代理 → 排除
      { model_id: 'glm-5.3', started_at: 1785003600000, status: 'error', input_tokens: 800, output_tokens: 60, reasoning_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 50 },
      { model_id: 'zero-m', started_at: 1785007200000, status: 'cancelled', input_tokens: 0, output_tokens: 0, reasoning_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
    ]);
    const recs = parseZcodeSource(dbPath);
    equal(recs.length, 2, 'GLM 两行计入（有值即计）；claude 子代理排除；全零 cancelled 跳过');
    equal(recs[0].platform, 'zcode');
    equal(recs[0].model, 'GLM-5.3-Flash');
    equal(recs[0].ts, new Date(1785000000000).toISOString(), 'started_at unix ms → ISO');
    equal(recs[0].inputTokens, 700);
    equal(recs[0].outputTokens, 150);
    equal(recs[0].reasoningTokens, 40);
    equal(recs[0].cacheWriteTokens, 30);
    equal(recs[0].cacheReadTokens, 200);
    equal(recs[1].model, 'glm-5.3');
    equal(recs[1].inputTokens, 800);
    ok(!recs.some((r) => r.model === 'claude-sonnet-4-5'), '非 GLM 系不出现');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('zcode：matchZaiModel——GLM/Z.ai/BigModel 系大小写不敏感；非 GLM/缺失 → null', () => {
  equal(matchZaiModel('GLM-5.3-Flash'), 'GLM-5.3-Flash');
  equal(matchZaiModel('glm-5.3'), 'glm-5.3');
  equal(matchZaiModel('ZAI-GLM-5'), 'ZAI-GLM-5');
  equal(matchZaiModel('bigmodel-glm-5'), 'bigmodel-glm-5');
  equal(matchZaiModel('claude-sonnet-4-5'), null, '捆绑 Claude 子代理排除');
  equal(matchZaiModel('gpt-5.2'), null);
  equal(matchZaiModel('codex-gpt'), null);
  equal(matchZaiModel('gemini-3-pro'), null);
  equal(matchZaiModel('kimi-k3'), null);
  equal(matchZaiModel('deepseek-v4-pro'), null);
  equal(matchZaiModel(''), null, '空串 → null');
  equal(matchZaiModel(null), null, 'model_id 缺失 → null');
  equal(matchZaiModel(undefined), null);
  equal(matchZaiModel(123), null, '非字符串 → null');
});

test('zcode：model_usage model_id 缺失的行跳过（防御）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hull-zcode-nomodel-'));
  try {
    const dbPath = makeModelUsageDb(dir, [
      { model_id: null, started_at: 1785000000000, status: 'completed', input_tokens: 500, output_tokens: 50, reasoning_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      { model_id: 'GLM-5.3-Flash', started_at: 1785003600000, status: 'completed', input_tokens: 100, output_tokens: 10, reasoning_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
    ]);
    const recs = parseZcodeSource(dbPath);
    equal(recs.length, 1, 'model_id 缺失行跳过');
    equal(recs[0].model, 'GLM-5.3-Flash');
    equal(recs[0].inputTokens, 100);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('zcode：model_usage 缺关键列（schema 漂移）→ []（不降级误读）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hull-zcode-drift-'));
  const dbPath = join(dir, 'db.sqlite');
  const db = new DatabaseSync(dbPath);
  try {
    db.exec('CREATE TABLE model_usage (model_id TEXT, started_at INTEGER, input_tokens INTEGER, status TEXT)'); // 缺 output_tokens
    db.prepare('INSERT INTO model_usage (model_id, started_at, input_tokens, status) VALUES (?,?,?,?)').run('m', 1785000000000, 100, 'completed');
  } finally {
    db.close();
  }
  try {
    equal(parseZcodeSource(dbPath).length, 0, '缺关键列 → []');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('zcode：无 model_usage 表 → 降级泛化（messages + created_at）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hull-zcode-gen-'));
  const dbPath = join(dir, 'db.sqlite');
  const db = new DatabaseSync(dbPath);
  try {
    db.exec('CREATE TABLE messages (id TEXT, model TEXT, input_tokens INTEGER, output_tokens INTEGER, cache_read_tokens INTEGER, created_at TEXT)');
    db.prepare('INSERT INTO messages (id, model, input_tokens, output_tokens, cache_read_tokens, created_at) VALUES (?,?,?,?,?,?)').run('m1', 'gpt-5', 700, 150, 300, '2026-08-30T10:00:00.000Z');
  } finally {
    db.close();
  }
  const recs = parseZcodeSource(dbPath);
  equal(recs.length, 1);
  equal(recs[0].platform, 'zcode');
  equal(recs[0].model, 'gpt-5');
  equal(recs[0].inputTokens, 700);
  equal(recs[0].outputTokens, 150);
  equal(recs[0].cacheReadTokens, 300);
  equal(recs[0].ts, '2026-08-30T10:00:00.000Z');
});

test('zcode：降级路径无行级 ts → 跳过该行（禁止 mtime 兜底）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hull-zcode-nots-'));
  const dbPath = join(dir, 'db.sqlite');
  const db = new DatabaseSync(dbPath);
  try {
    db.exec('CREATE TABLE messages (id TEXT, model TEXT, input_tokens INTEGER, output_tokens INTEGER)'); // 无任何 ts 列
    db.prepare('INSERT INTO messages (id, model, input_tokens, output_tokens) VALUES (?,?,?,?)').run('m1', 'gpt-5', 700, 150);
  } finally {
    db.close();
  }
  try {
    equal(parseZcodeSource(dbPath).length, 0, '无行级真实 ts → 跳过，不再 mtime 兜底');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('zcode：无 token 列的表不产出记录', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hull-zcode-noschema-'));
  const dbPath = join(dir, 'db.sqlite');
  const db = new DatabaseSync(dbPath);
  try {
    db.exec('CREATE TABLE sessions (id TEXT, title TEXT)');
    db.exec('INSERT INTO sessions (id, title) VALUES (\'s1\', \'demo\')');
  } finally {
    db.close();
  }
  try {
    equal(parseZcodeSource(dbPath).length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('zcode：createZcodeSource → listFiles 存在性 + parseFile（model_usage 端到端）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hull-zcode-home-'));
  try {
    const rel = join(dir, '.zcode', 'cli', 'db');
    mkdirSync(rel, { recursive: true });
    makeModelUsageDb(rel, [{ model_id: 'GLM-5.3-Flash', started_at: 1785000000000, status: 'completed', input_tokens: 222, output_tokens: 33, reasoning_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }]);
    const src = createZcodeSource(dir);
    equal(src.listFiles().length, 1);
    const recs = src.parseFile?.('', 'ignored') ?? [];
    equal(recs.length, 1);
    equal(recs[0].inputTokens, 222);
    equal(recs[0].outputTokens, 33);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
