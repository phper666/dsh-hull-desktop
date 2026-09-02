import { test } from 'node:test';
import { equal } from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createKiroSource, parseKiroJsonlLine, parseKiroSource, parseKiroSourceText } from './kiro';

const FALLBACK = '1970-01-01T00:00:00.000Z';

test('kiro：tokens_generated 表 → 记录', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hull-kiro-db-'));
  const dbPath = join(dir, 'devdata.sqlite');
  const db = new DatabaseSync(dbPath);
  try {
    db.exec('CREATE TABLE tokens_generated (id INTEGER, model TEXT, provider TEXT, tokens_prompt INTEGER, tokens_generated INTEGER, timestamp TEXT)');
    db.prepare('INSERT INTO tokens_generated (id, model, provider, tokens_prompt, tokens_generated, timestamp) VALUES (?,?,?,?,?,?)').run(1, 'agent', 'kiro', 1200, 300, '2026-08-30T10:00:00.000Z');
  } finally {
    db.close();
  }
  try {
    const recs = parseKiroSource(dbPath, FALLBACK);
    equal(recs.length, 1);
    equal(recs[0].platform, 'kiro');
    equal(recs[0].model, 'agent');
    equal(recs[0].inputTokens, 1200);
    equal(recs[0].outputTokens, 300);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('kiro：JSONL 行 {model, promptTokens, generatedTokens} → 记录；坏行/空 → 跳过', () => {
  const rec = parseKiroJsonlLine(JSON.stringify({ model: 'gpt-5', provider: 'kiro', promptTokens: 800, generatedTokens: 90 }), FALLBACK);
  equal(rec?.platform, 'kiro');
  equal(rec?.inputTokens, 800);
  equal(rec?.outputTokens, 90);
  equal(rec?.ts, FALLBACK, 'JSONL 无时间戳 → fallbackTs');
  equal(parseKiroJsonlLine('not-json', FALLBACK), null);
  equal(parseKiroJsonlLine(JSON.stringify({ model: 'x', promptTokens: 0, generatedTokens: 0 }), FALLBACK), null);
});

test('kiro：JSONL 全文解析', () => {
  const text = [JSON.stringify({ model: 'a', promptTokens: 1, generatedTokens: 2 }), '', JSON.stringify({ model: 'b', promptTokens: 3, generatedTokens: 4 })].join('\n');
  const recs = parseKiroSourceText(text, FALLBACK);
  equal(recs.length, 2);
});

test('kiro：createKiroSource → 混合 *.db + *.jsonl 分派', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hull-kiro-home-'));
  try {
    const rel = join(dir, '.kiro', 'dev');
    mkdirSync(rel, { recursive: true });
    const dbPath = join(rel, 'devdata.sqlite');
    const db = new DatabaseSync(dbPath);
    try {
      db.exec('CREATE TABLE tokens_generated (id INTEGER, model TEXT, tokens_prompt INTEGER, tokens_generated INTEGER)');
      db.prepare('INSERT INTO tokens_generated (id, model, tokens_prompt, tokens_generated) VALUES (?,?,?,?)').run(1, 'agent', 500, 40);
    } finally {
      db.close();
    }
    const jsonlPath = join(rel, 'tokens_generated.jsonl');
    writeFileSync(jsonlPath, JSON.stringify({ model: 'gpt-5', promptTokens: 100, generatedTokens: 10 }) + '\n');

    const src = createKiroSource(dir);
    equal(src.listFiles().length, 2, 'db + jsonl 都列出');
    // db 走标记分派
    const dbRecs = src.parseFile?.(src.readFile?.(dbPath) ?? '', FALLBACK) ?? [];
    equal(dbRecs.length, 1);
    equal(dbRecs[0].inputTokens, 500);
    // jsonl 走文本分派
    const jsonlRecs = src.parseFile?.(src.readFile?.(jsonlPath) ?? '', FALLBACK) ?? [];
    equal(jsonlRecs.length, 1);
    equal(jsonlRecs[0].model, 'gpt-5');
    equal(jsonlRecs[0].inputTokens, 100);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('kiro：无 db/表缺失 → []；无文件 → listFiles []', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hull-kiro-empty-'));
  try {
    const src = createKiroSource(dir);
    equal(src.listFiles().length, 0);
    equal((src.parseFile?.('', FALLBACK) ?? []).length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
