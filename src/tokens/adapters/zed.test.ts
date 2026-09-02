import { test } from 'node:test';
import { equal } from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createZedSource, parseZedSource } from './zed';

const FALLBACK = '1970-01-01T00:00:00.000Z';

function makeThreadsDb(rows: Array<{ model: string; cumulative: string; updated_at: string | null }>): string {
  const dir = mkdtempSync(join(tmpdir(), 'hull-zed-'));
  const dbPath = join(dir, 'threads.db');
  const db = new DatabaseSync(dbPath);
  try {
    db.exec('CREATE TABLE threads (id TEXT PRIMARY KEY, model TEXT, cumulative_token_usage TEXT, updated_at TEXT)');
    for (const r of rows) {
      db.prepare('INSERT INTO threads (id, model, cumulative_token_usage, updated_at) VALUES (?,?,?,?)').run(
        `t-${Math.random()}`,
        r.model,
        r.cumulative,
        r.updated_at
      );
    }
  } finally {
    db.close();
  }
  return dbPath;
}

test('zed：cumulative_token_usage JSON → 记录（含缓存读/写）', () => {
  const dbPath = makeThreadsDb([
    {
      model: 'gpt-5',
      cumulative: JSON.stringify({ input_tokens: 800, output_tokens: 200, cache_read_input_tokens: 500, cache_creation_input_tokens: 50 }),
      updated_at: '2026-08-30T10:00:00.000Z',
    },
  ]);
  const recs = parseZedSource(dbPath, FALLBACK);
  equal(recs.length, 1);
  equal(recs[0].platform, 'zed');
  equal(recs[0].model, 'gpt-5');
  equal(recs[0].inputTokens, 800);
  equal(recs[0].outputTokens, 200);
  equal(recs[0].cacheReadTokens, 500);
  equal(recs[0].cacheWriteTokens, 50);
  equal(recs[0].ts, '2026-08-30T10:00:00.000Z');
});

test('zed：拆列模式（无 cumulative_token_usage 列）+ ts 缺省 → fallbackTs', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hull-zed-col-'));
  const dbPath = join(dir, 'threads.db');
  const db = new DatabaseSync(dbPath);
  try {
    db.exec('CREATE TABLE threads (id TEXT, model TEXT, input_tokens INTEGER, output_tokens INTEGER)');
    db.prepare('INSERT INTO threads (id, model, input_tokens, output_tokens) VALUES (?,?,?,?)').run('t1', 'o4-mini', 300, 90);
  } finally {
    db.close();
  }
  const recs = parseZedSource(dbPath, FALLBACK);
  equal(recs.length, 1);
  equal(recs[0].inputTokens, 300);
  equal(recs[0].outputTokens, 90);
  equal(recs[0].ts, FALLBACK);
});

test('zed：表缺失 → []；无 token 数据行 → 跳过', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hull-zed-empty-'));
  const dbPath = join(dir, 'threads.db');
  const db = new DatabaseSync(dbPath);
  db.close();
  try {
    equal(parseZedSource(dbPath, FALLBACK).length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  const noUsage = makeThreadsDb([{ model: 'gpt-5', cumulative: '{}', updated_at: '2026-08-30T10:00:00.000Z' }]);
  equal(parseZedSource(noUsage, FALLBACK).length, 0, '全 0 → 跳过');
});

test('zed：createZedSource → 递归找 *.db + readFile 标记分派', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hull-zed-home-'));
  try {
    const rel = join(dir, 'Library', 'Application Support', 'Zed', 'threads');
    mkdirSync(rel, { recursive: true });
    const dbPath = join(rel, 'threads.db');
    const db = new DatabaseSync(dbPath);
    try {
      db.exec('CREATE TABLE threads (id TEXT, model TEXT, cumulative_token_usage TEXT, updated_at TEXT)');
      db.prepare('INSERT INTO threads (id, model, cumulative_token_usage, updated_at) VALUES (?,?,?,?)').run('t1', 'gpt-5', JSON.stringify({ input_tokens: 111, output_tokens: 22 }), '2026-08-30T10:00:00.000Z');
    } finally {
      db.close();
    }
    const src = createZedSource(dir);
    equal(src.listFiles().length, 1);
    equal(src.listFiles()[0], dbPath);
    const text = src.readFile?.(dbPath) ?? '';
    const recs = src.parseFile?.(text, FALLBACK) ?? [];
    equal(recs.length, 1);
    equal(recs[0].inputTokens, 111);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
