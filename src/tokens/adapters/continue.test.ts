import { test } from 'node:test';
import { equal } from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createContinueSource, parseContinueSource } from './continue';

const FALLBACK = '1970-01-01T00:00:00.000Z';

function makeDb(table: string, cols: string[], rows: (string | number | null)[][]): string {
  const dir = mkdtempSync(join(tmpdir(), 'hull-continue-'));
  const dbPath = join(dir, 'devdata.sqlite');
  const db = new DatabaseSync(dbPath);
  try {
    db.exec(`CREATE TABLE ${table} (${cols.map((c) => `${c}`).join(', ')})`);
    for (const r of rows) {
      db.prepare(`INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`).run(...r);
    }
  } finally {
    db.close();
  }
  return dbPath;
}

test('continue：tokens_generated 正常行 → 记录（promptTokens→input，generatedTokens→output）', () => {
  const dbPath = makeDb(
    'tokens_generated',
    ['id', 'model', 'provider', 'promptTokens', 'generatedTokens', 'timestamp'],
    [
      [1, 'deepseek-v4', 'deepseek', 1200, 300, '2026-08-30T10:00:00.000Z'],
      [2, 'gpt-5', 'openai', 0, 0, '2026-08-30T11:00:00.000Z'],
    ]
  );
  const recs = parseContinueSource(dbPath, FALLBACK);
  equal(recs.length, 1, '全 0 行跳过');
  equal(recs[0].platform, 'continue');
  equal(recs[0].model, 'deepseek-v4');
  equal(recs[0].inputTokens, 1200);
  equal(recs[0].outputTokens, 300);
  equal(recs[0].ts, '2026-08-30T10:00:00.000Z');
});

test('continue：列缺失 → 防御式 0；旧命名 tokens_prompt/tokens_generated 兼容', () => {
  const dbPath = makeDb(
    'tokens_generated',
    ['id', 'model', 'tokens_prompt', 'tokens_generated', 'timestamp'],
    [[1, 'claude-4', 640, 210, '2026-08-30T12:00:00.000Z']]
  );
  const recs = parseContinueSource(dbPath, FALLBACK);
  equal(recs.length, 1);
  equal(recs[0].inputTokens, 640);
  equal(recs[0].outputTokens, 210);
});

test('continue：表缺失 → []', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hull-continue-empty-'));
  const dbPath = join(dir, 'devdata.sqlite');
  const db = new DatabaseSync(dbPath);
  db.close();
  try {
    equal(parseContinueSource(dbPath, FALLBACK).length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('continue：createContinueSource → listFiles 存在性 + parseFile', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hull-continue-home-'));
  try {
    const rel = join(dir, '.continue');
    mkdirSync(rel, { recursive: true });
    const dbPath = join(rel, 'devdata.sqlite');
    const db = new DatabaseSync(dbPath);
    try {
      db.exec('CREATE TABLE tokens_generated (id INTEGER, model TEXT, promptTokens INTEGER, generatedTokens INTEGER)');
      db.prepare('INSERT INTO tokens_generated (id, model, promptTokens, generatedTokens) VALUES (?,?,?,?)').run(1, 'gpt-5', 500, 40);
    } finally {
      db.close();
    }
    const src = createContinueSource(dir);
    equal(src.listFiles().length, 1);
    const recs = src.parseFile?.('', FALLBACK) ?? [];
    equal(recs.length, 1);
    equal(recs[0].model, 'gpt-5');
    equal(recs[0].inputTokens, 500);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
