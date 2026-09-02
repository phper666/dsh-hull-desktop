import { test } from 'node:test';
import { equal, ok } from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createGeminiSource, parseGeminiLine } from './gemini';

// TokensSummary 形态（Gemini API 命名）
const LINE = JSON.stringify({
  timestamp: '2026-08-30T10:00:00.000Z',
  model: 'gemini-2.5-pro',
  tokens: {
    input: { promptTokenCount: 1250 },
    output: { candidatesTokenCount: 340 },
    cached: { cachedContentTokenCount: 5000 },
    total: { totalTokenCount: 6590 },
  },
});

test('parseGeminiLine：TokensSummary 映射 → 记录（reasoning 无则 0）', () => {
  const r = parseGeminiLine(LINE, '1970-01-01T00:00:00Z');
  ok(r, '应解析出记录');
  equal(r?.platform, 'gemini');
  equal(r?.model, 'gemini-2.5-pro');
  equal(r?.inputTokens, 1250);
  equal(r?.outputTokens, 340);
  equal(r?.cacheReadTokens, 5000);
  equal(r?.cacheWriteTokens, 0);
  equal(r?.reasoningTokens, 0);
  equal(r?.ts, '2026-08-30T10:00:00.000Z');
});

test('parseGeminiLine：无 tokens 形态 / 全零 / 非 JSON → null', () => {
  equal(parseGeminiLine(JSON.stringify({ text: 'hi' }), 'x'), null);
  equal(parseGeminiLine(JSON.stringify({ tokens: { input: { promptTokenCount: 0 }, output: { candidatesTokenCount: 0 } } }), 'x'), null);
  equal(parseGeminiLine('not-json', 'x'), null);
});

test('createGeminiSource：递归找 tmp/**/chats/*.jsonl', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hull-gemini-'));
  try {
    const chatsDir = join(dir, '.gemini', 'tmp', 'abc123', 'chats');
    mkdirSync(chatsDir, { recursive: true });
    writeFileSync(join(chatsDir, 'session-1.jsonl'), LINE + '\n');
    // chats 目录外的 jsonl 不应被收集
    const other = join(dir, '.gemini', 'tmp', 'abc123', 'other');
    mkdirSync(other, { recursive: true });
    writeFileSync(join(other, 'x.jsonl'), LINE + '\n');
    const src = createGeminiSource(dir);
    const files = src.listFiles();
    equal(files.length, 1, '只收 chats/ 下 jsonl');
    equal(src.parseLine!(LINE, 'fallback')?.platform, 'gemini');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
