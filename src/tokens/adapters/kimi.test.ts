import { test } from 'node:test';
import { equal, ok } from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createKimiSource, parseKimiLine } from './kimi';

// 内部格式未知——嵌套 usage 形态（usage 深埋在 payload 下）+ model + timestamp(ms)
const LINE = JSON.stringify({
  event: 'assistant_message',
  timestamp: 1782900000000,
  data: {
    content: 'ok',
    model: 'kimi-k2',
    stats: { usage: { input_tokens: 640, output_tokens: 210, cache_read_input_tokens: 1200 } },
  },
});

test('parseKimiLine：防御式深找 usage 形态 → 记录（含 cache + model + ms ts）', () => {
  const r = parseKimiLine(LINE, '1970-01-01T00:00:00Z');
  ok(r, '应解析出记录');
  equal(r?.platform, 'kimi');
  equal(r?.model, 'kimi-k2');
  equal(r?.inputTokens, 640);
  equal(r?.outputTokens, 210);
  equal(r?.cacheReadTokens, 1200);
  equal(r?.cacheWriteTokens, 0);
  equal(r?.ts, new Date(1782900000000).toISOString());
});

test('parseKimiLine：无 usage 形态 / 非 JSON → null', () => {
  equal(parseKimiLine(JSON.stringify({ event: 'ping' }), 'x'), null);
  equal(parseKimiLine('not-json', 'x'), null);
});

test('createKimiSource：递归找 sessions/**/wire.jsonl', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hull-kimi-'));
  try {
    const sessions = join(dir, '.kimi', 'sessions');
    const s1 = join(sessions, 'a', 'b');
    mkdirSync(s1, { recursive: true });
    writeFileSync(join(s1, 'wire.jsonl'), LINE + '\n');
    writeFileSync(join(sessions, 'a', 'other.jsonl'), LINE + '\n');
    const src = createKimiSource(dir);
    const files = src.listFiles();
    equal(files.length, 1, '只收 wire.jsonl');
    equal(src.parseLine!(LINE, 'fallback')?.model, 'kimi-k2');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
