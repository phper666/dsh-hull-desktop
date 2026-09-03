import { test } from 'node:test';
import { equal } from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createZcodeSource, parseZcodeSource } from './zcode';

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

test('zcode：model_usage 精确路径——真实 schema 映射（unix ms → ISO、status 有值即计）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hull-zcode-mu-'));
  try {
    const dbPath = makeModelUsageDb(dir, [
      { model_id: 'deepseek-v4', started_at: 1785000000000, status: 'completed', input_tokens: 700, output_tokens: 150, reasoning_tokens: 40, cache_creation_input_tokens: 30, cache_read_input_tokens: 200 },
      { model_id: 'gpt-5.2', started_at: 1785003600000, status: 'error', input_tokens: 800, output_tokens: 60, reasoning_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 50 },
      { model_id: 'zero-m', started_at: 1785007200000, status: 'cancelled', input_tokens: 0, output_tokens: 0, reasoning_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
    ]);
    const recs = parseZcodeSource(dbPath);
    equal(recs.length, 2, 'completed+error 计入（有值即计），全零 cancelled 跳过');
    equal(recs[0].platform, 'zcode');
    equal(recs[0].model, 'deepseek-v4');
    equal(recs[0].ts, new Date(1785000000000).toISOString(), 'started_at unix ms → ISO');
    equal(recs[0].inputTokens, 700);
    equal(recs[0].outputTokens, 150);
    equal(recs[0].reasoningTokens, 40);
    equal(recs[0].cacheWriteTokens, 30);
    equal(recs[0].cacheReadTokens, 200);
    equal(recs[1].model, 'gpt-5.2');
    equal(recs[1].inputTokens, 800);
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
    makeModelUsageDb(rel, [{ model_id: 'o4-mini', started_at: 1785000000000, status: 'completed', input_tokens: 222, output_tokens: 33, reasoning_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }]);
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
