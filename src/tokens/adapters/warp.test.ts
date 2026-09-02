import { test } from 'node:test';
import { equal } from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createWarpSource, parseWarpSource } from './warp';

const FALLBACK = '1970-01-01T00:00:00.000Z';

test('warp：token_usage JSON 数组（按模型）→ 每模型一条记录', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hull-warp-'));
  const dbPath = join(dir, 'index.sqlite');
  const db = new DatabaseSync(dbPath);
  try {
    db.exec('CREATE TABLE conversations (id TEXT, conversation_usage_metadata TEXT, created_at INTEGER)');
    const meta = JSON.stringify({
      token_usage: [
        { model: 'gpt-5', input_tokens: 800, output_tokens: 200, cache_read_input_tokens: 100 },
        { model: 'claude-4', input_tokens: 400, output_tokens: 80 },
      ],
    });
    db.prepare('INSERT INTO conversations (id, conversation_usage_metadata, created_at) VALUES (?,?,?)').run('c1', meta, 1785000000000);
  } finally {
    db.close();
  }
  const recs = parseWarpSource(dbPath, FALLBACK);
  equal(recs.length, 2, 'JSON 数组按模型展开');
  equal(recs[0].platform, 'warp');
  equal(recs[0].model, 'gpt-5');
  equal(recs[0].inputTokens, 800);
  equal(recs[0].outputTokens, 200);
  equal(recs[0].cacheReadTokens, 100);
  equal(recs[0].ts, new Date(1785000000000).toISOString());
  equal(recs[1].model, 'claude-4');
});

test('warp：无含 token 列的表 → []', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hull-warp-noschema-'));
  const dbPath = join(dir, 'index.sqlite');
  const db = new DatabaseSync(dbPath);
  try {
    db.exec('CREATE TABLE other (id TEXT, name TEXT)');
    db.prepare('INSERT INTO other (id, name) VALUES (?,?)').run('x', 'y');
  } finally {
    db.close();
  }
  try {
    equal(parseWarpSource(dbPath, FALLBACK).length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('warp：token_usage 空/非法 JSON → 跳过', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hull-warp-bad-'));
  const dbPath = join(dir, 'index.sqlite');
  const db = new DatabaseSync(dbPath);
  try {
    db.exec('CREATE TABLE usage_events (id TEXT, token_usage TEXT)');
    db.prepare('INSERT INTO usage_events (id, token_usage) VALUES (?,?)').run('e1', 'not-json');
  } finally {
    db.close();
  }
  try {
    equal(parseWarpSource(dbPath, FALLBACK).length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('warp：createWarpSource → listFiles 存在性 + parseFile', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hull-warp-home-'));
  try {
    const rel = join(dir, '.warp', 'remote-server', 'codebase-indexes');
    mkdirSync(rel, { recursive: true });
    const dbPath = join(rel, 'index.sqlite');
    const db = new DatabaseSync(dbPath);
    try {
      db.exec('CREATE TABLE conversations (id TEXT, conversation_usage_metadata TEXT)');
      db.prepare('INSERT INTO conversations (id, conversation_usage_metadata) VALUES (?,?)').run('c1', JSON.stringify({ token_usage: [{ model: 'gpt-5', input_tokens: 321, output_tokens: 12 }] }));
    } finally {
      db.close();
    }
    const src = createWarpSource(dir);
    equal(src.listFiles().length, 1);
    const recs = src.parseFile?.('', FALLBACK) ?? [];
    equal(recs.length, 1);
    equal(recs[0].inputTokens, 321);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
