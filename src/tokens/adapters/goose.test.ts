import { test } from 'node:test';
import { equal } from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createGooseSource, parseGooseSource } from './goose';

const FALLBACK = '1970-01-01T00:00:00.000Z';

function makeDb(tables: Record<string, string[]>, rows: Record<string, (string | number | null)[][]>): string {
  const dir = mkdtempSync(join(tmpdir(), 'hull-goose-'));
  const dbPath = join(dir, 'sessions.db');
  const db = new DatabaseSync(dbPath);
  try {
    for (const [table, cols] of Object.entries(tables)) {
      db.exec(`CREATE TABLE ${table} (${cols.map((c) => `${c}`).join(', ')})`);
      for (const r of rows[table] ?? []) {
        const ph = cols.map(() => '?').join(', ');
        db.prepare(`INSERT INTO ${table} (${cols.join(', ')}) VALUES (${ph})`).run(...r);
      }
    }
  } finally {
    db.close();
  }
  return dbPath;
}

test('goose：正常行 → 记录（accumulated_* 优先、模型取自 model_config_json、ts 取 created_at）', () => {
  const dbPath = makeDb(
    { sessions: ['id', 'model_config_json', 'created_at', 'input_tokens', 'output_tokens', 'accumulated_total_tokens', 'accumulated_input_tokens', 'accumulated_output_tokens'] },
    {
      sessions: [
        ['s1', JSON.stringify({ model: 'gpt-5' }), 1785000000000, 100, 50, 5000, 4000, 900],
        ['s2', JSON.stringify({ model_name: 'o4-mini' }), 1785000600000, 200, 80, null, null, null],
        ['s3', JSON.stringify({ model: 'claude-4' }), null, 0, 0, null, null, null],
      ],
    }
  );
  const recs = parseGooseSource(dbPath, FALLBACK);
  equal(recs.length, 2, '无 token 行跳过');
  equal(recs[0].platform, 'goose');
  equal(recs[0].model, 'gpt-5');
  equal(recs[0].inputTokens, 4000, 'accumulated 优先');
  equal(recs[0].outputTokens, 900);
  equal(recs[0].ts, new Date(1785000000000).toISOString());
  equal(recs[1].model, 'o4-mini', 'model_name 退化路径');
  equal(recs[1].inputTokens, 200, '无累计列回退单轮');
});

test('goose：表缺失 → []；空表 → []', () => {
  const empty = makeDb({}, {});
  equal(parseGooseSource(empty, FALLBACK).length, 0);
  const noRows = makeDb({ sessions: ['id', 'model_config_json', 'created_at', 'input_tokens', 'output_tokens'] }, { sessions: [] });
  equal(parseGooseSource(noRows, FALLBACK).length, 0);
});

test('goose：列缺失 → 防御式 0（无 accumulated 列仍出单轮值）', () => {
  const dbPath = makeDb({ sessions: ['id', 'model', 'created_at', 'total_tokens', 'input_tokens', 'output_tokens'] }, {
    sessions: [['s1', 'gpt-4o', 1785000000000, 300, 210, 90]],
  });
  const recs = parseGooseSource(dbPath, FALLBACK);
  equal(recs.length, 1);
  equal(recs[0].inputTokens, 210);
  equal(recs[0].outputTokens, 90);
});

test('goose：createGooseSource → listFiles 只返回存在路径 + parseFile 出记录', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hull-goose-home-'));
  try {
    const rel = join(dir, '.local', 'share', 'goose', 'sessions');
    mkdirSync(rel, { recursive: true });
    const dbPath = join(rel, 'sessions.db');
    const db = new DatabaseSync(dbPath);
    try {
      db.exec('CREATE TABLE sessions (id TEXT, model_config_json TEXT, created_at INTEGER, input_tokens INTEGER, output_tokens INTEGER)');
      db.prepare('INSERT INTO sessions (id, model_config_json, created_at, input_tokens, output_tokens) VALUES (?,?,?,?,?)').run('s1', JSON.stringify({ model: 'gpt-5' }), 1785000000000, 111, 22);
    } finally {
      db.close();
    }
    const src = createGooseSource(dir);
    equal(src.platform, 'goose');
    equal(src.listFiles().length, 1);
    equal(src.listFiles()[0], dbPath);
    const recs = src.parseFile?.('', FALLBACK) ?? [];
    equal(recs.length, 1);
    equal(recs[0].inputTokens, 111);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('goose：无 db 文件 → listFiles []，parseFile 空', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hull-goose-none-'));
  try {
    const src = createGooseSource(dir);
    equal(src.listFiles().length, 0);
    equal((src.parseFile?.('', FALLBACK) ?? []).length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
