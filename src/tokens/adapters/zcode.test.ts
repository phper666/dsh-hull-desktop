import { test } from 'node:test';
import { equal } from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createZcodeSource, parseZcodeSource } from './zcode';

const FALLBACK = '1970-01-01T00:00:00.000Z';

test('zcode：messages 表 token 列 → 记录', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hull-zcode-'));
  const dbPath = join(dir, 'db.sqlite');
  const db = new DatabaseSync(dbPath);
  try {
    db.exec('CREATE TABLE sessions (id TEXT, title TEXT)');
    db.exec('CREATE TABLE messages (id TEXT, session_id TEXT, model TEXT, input_tokens INTEGER, output_tokens INTEGER, cache_read_tokens INTEGER, created_at TEXT)');
    db.exec('INSERT INTO sessions (id, title) VALUES (\'s1\', \'demo\')');
    db.prepare('INSERT INTO messages (id, session_id, model, input_tokens, output_tokens, cache_read_tokens, created_at) VALUES (?,?,?,?,?,?,?)').run('m1', 's1', 'gpt-5', 700, 150, 300, '2026-08-30T10:00:00.000Z');
  } finally {
    db.close();
  }
  const recs = parseZcodeSource(dbPath, FALLBACK);
  equal(recs.length, 1);
  equal(recs[0].platform, 'zcode');
  equal(recs[0].model, 'gpt-5');
  equal(recs[0].inputTokens, 700);
  equal(recs[0].outputTokens, 150);
  equal(recs[0].cacheReadTokens, 300);
  equal(recs[0].ts, '2026-08-30T10:00:00.000Z');
});

test('zcode：无 token 列的表（sessions）不产出记录', () => {
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
    equal(parseZcodeSource(dbPath, FALLBACK).length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('zcode：token 列但数值 0 → 跳过', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hull-zcode-zero-'));
  const dbPath = join(dir, 'db.sqlite');
  const db = new DatabaseSync(dbPath);
  try {
    db.exec('CREATE TABLE messages (id TEXT, model TEXT, input_tokens INTEGER, output_tokens INTEGER)');
    db.prepare('INSERT INTO messages (id, model, input_tokens, output_tokens) VALUES (?,?,?,?)').run('m1', 'gpt-5', 0, 0);
  } finally {
    db.close();
  }
  try {
    equal(parseZcodeSource(dbPath, FALLBACK).length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('zcode：createZcodeSource → listFiles 存在性 + parseFile', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hull-zcode-home-'));
  try {
    const rel = join(dir, '.zcode', 'cli', 'db');
    mkdirSync(rel, { recursive: true });
    const dbPath = join(rel, 'db.sqlite');
    const db = new DatabaseSync(dbPath);
    try {
      db.exec('CREATE TABLE messages (id TEXT, model TEXT, tokens_in INTEGER, tokens_out INTEGER, created_at TEXT)');
      db.prepare('INSERT INTO messages (id, model, tokens_in, tokens_out, created_at) VALUES (?,?,?,?,?)').run('m1', 'o4-mini', 222, 33, '2026-08-30T10:00:00.000Z');
    } finally {
      db.close();
    }
    const src = createZcodeSource(dir);
    equal(src.listFiles().length, 1);
    const recs = src.parseFile?.('', FALLBACK) ?? [];
    equal(recs.length, 1);
    equal(recs[0].inputTokens, 222);
    equal(recs[0].outputTokens, 33);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
