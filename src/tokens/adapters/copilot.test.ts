import { test } from 'node:test';
import { equal } from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createCopilotSource, parseCopilotSource } from './copilot';

const FALLBACK = '1970-01-01T00:00:00.000Z';

test('copilot：assistant_usage_events 正常行 → 记录（含缓存读/写/推理）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hull-copilot-'));
  const dbPath = join(dir, 'session-store.db');
  const db = new DatabaseSync(dbPath);
  try {
    db.exec('CREATE TABLE assistant_usage_events (id INTEGER, session_id TEXT, model TEXT, input_tokens INTEGER, output_tokens INTEGER, cache_read_tokens INTEGER, cache_write_tokens INTEGER, reasoning_tokens INTEGER, created_at TEXT)');
    db.prepare('INSERT INTO assistant_usage_events (id, session_id, model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, reasoning_tokens, created_at) VALUES (?,?,?,?,?,?,?,?,?)').run(1, 's1', 'gpt-5', 900, 180, 400, 30, 20, '2026-08-30T10:00:00.000Z');
  } finally {
    db.close();
  }
  const recs = parseCopilotSource(dbPath, FALLBACK);
  equal(recs.length, 1);
  equal(recs[0].platform, 'copilot');
  equal(recs[0].model, 'gpt-5');
  equal(recs[0].inputTokens, 900);
  equal(recs[0].outputTokens, 180);
  equal(recs[0].cacheReadTokens, 400);
  equal(recs[0].cacheWriteTokens, 30);
  equal(recs[0].reasoningTokens, 20);
  equal(recs[0].ts, '2026-08-30T10:00:00.000Z');
});

test('copilot：全 0 行 → 跳过；模型缺 → unknown', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hull-copilot-zero-'));
  const dbPath = join(dir, 'session-store.db');
  const db = new DatabaseSync(dbPath);
  try {
    db.exec('CREATE TABLE assistant_usage_events (id INTEGER, model TEXT, input_tokens INTEGER, output_tokens INTEGER)');
    db.prepare('INSERT INTO assistant_usage_events (id, model, input_tokens, output_tokens) VALUES (?,?,?,?)').run(1, null, 0, 0);
  } finally {
    db.close();
  }
  try {
    equal(parseCopilotSource(dbPath, FALLBACK).length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('copilot：表缺失 → []', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hull-copilot-empty-'));
  const dbPath = join(dir, 'session-store.db');
  const db = new DatabaseSync(dbPath);
  db.close();
  try {
    equal(parseCopilotSource(dbPath, FALLBACK).length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('copilot：createCopilotSource → listFiles 存在性 + parseFile', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hull-copilot-home-'));
  try {
    const rel = join(dir, '.copilot');
    mkdirSync(rel, { recursive: true });
    const dbPath = join(rel, 'session-store.db');
    const db = new DatabaseSync(dbPath);
    try {
      db.exec('CREATE TABLE assistant_usage_events (id INTEGER, model TEXT, input_tokens INTEGER, output_tokens INTEGER, created_at TEXT)');
      db.prepare('INSERT INTO assistant_usage_events (id, model, input_tokens, output_tokens, created_at) VALUES (?,?,?,?,?)').run(1, 'claude-4', 555, 66, '2026-08-30T10:00:00.000Z');
    } finally {
      db.close();
    }
    const src = createCopilotSource(dir);
    equal(src.listFiles().length, 1);
    const recs = src.parseFile?.('', FALLBACK) ?? [];
    equal(recs.length, 1);
    equal(recs[0].inputTokens, 555);
    equal(recs[0].outputTokens, 66);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
