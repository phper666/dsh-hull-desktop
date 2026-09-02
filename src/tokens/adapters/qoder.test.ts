import { test } from 'node:test';
import { equal } from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createQoderSource, parseQoderSource } from './qoder';

const FALLBACK = '1970-01-01T00:00:00.000Z';

function makeDb(rows: Array<{ role: string; token_info: string | null; model_info: string; gmt_create: number | null }>): string {
  const dir = mkdtempSync(join(tmpdir(), 'hull-qoder-'));
  const dbPath = join(dir, 'local.db');
  const db = new DatabaseSync(dbPath);
  try {
    db.exec('CREATE TABLE chat_message (id TEXT, session_id TEXT, role TEXT, token_info TEXT, model_info TEXT, gmt_create INTEGER)');
    for (const r of rows) {
      db.prepare('INSERT INTO chat_message (id, session_id, role, token_info, model_info, gmt_create) VALUES (?,?,?,?,?,?)').run(
        `m-${Math.random()}`,
        's1',
        r.role,
        r.token_info,
        r.model_info,
        r.gmt_create
      );
    }
  } finally {
    db.close();
  }
  return dbPath;
}

test('qoder：assistant token_info → 记录（cached 从 prompt 拆分到 cacheRead）', () => {
  const dbPath = makeDb([
    {
      role: 'assistant',
      token_info: JSON.stringify({ prompt_tokens: 1000, cached_tokens: 300, completion_tokens: 200 }),
      model_info: JSON.stringify({ model_key: 'qwen-coder' }),
      gmt_create: 1785000000000,
    },
  ]);
  const recs = parseQoderSource(dbPath, FALLBACK);
  equal(recs.length, 1);
  equal(recs[0].platform, 'qoder');
  equal(recs[0].model, 'qwen-coder');
  equal(recs[0].inputTokens, 700, 'prompt - cached');
  equal(recs[0].cacheReadTokens, 300, 'cached 拆到缓存读');
  equal(recs[0].outputTokens, 200);
  equal(recs[0].ts, new Date(1785000000000).toISOString());
});

test('qoder：非 assistant / 无 token_info 行 → 跳过', () => {
  const dbPath = makeDb([
    { role: 'user', token_info: null, model_info: '{}', gmt_create: 1785000000000 },
    { role: 'assistant', token_info: null, model_info: '{}', gmt_create: 1785000000000 },
    { role: 'assistant', token_info: '{}', model_info: JSON.stringify({ model_key: 'x' }), gmt_create: 1785000000000 },
  ]);
  equal(parseQoderSource(dbPath, FALLBACK).length, 0);
});

test('qoder：表缺失 → []', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hull-qoder-empty-'));
  const dbPath = join(dir, 'local.db');
  const db = new DatabaseSync(dbPath);
  db.close();
  try {
    equal(parseQoderSource(dbPath, FALLBACK).length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('qoder：createQoderSource → listFiles 存在性 + parseFile', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hull-qoder-home-'));
  try {
    const rel = join(dir, 'Library', 'Application Support', 'Qoder', 'SharedClientCache', 'cache', 'db');
    mkdirSync(rel, { recursive: true });
    const dbPath = join(rel, 'local.db');
    const db = new DatabaseSync(dbPath);
    try {
      db.exec('CREATE TABLE chat_message (id TEXT, role TEXT, token_info TEXT, model_info TEXT, gmt_create INTEGER)');
      db.prepare('INSERT INTO chat_message (id, role, token_info, model_info, gmt_create) VALUES (?,?,?,?,?)').run('m1', 'assistant', JSON.stringify({ prompt_tokens: 600, cached_tokens: 100, completion_tokens: 60 }), JSON.stringify({ model_key: 'qwen-coder' }), 1785000000000);
    } finally {
      db.close();
    }
    const src = createQoderSource(dir);
    equal(src.listFiles().length, 1);
    const recs = src.parseFile?.('', FALLBACK) ?? [];
    equal(recs.length, 1);
    equal(recs[0].inputTokens, 500);
    equal(recs[0].cacheReadTokens, 100);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
