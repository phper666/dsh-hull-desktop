import { test } from 'node:test';
import { equal, ok } from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { parseClaudeLine, createClaudeSource } from './claude';

const CLAUDE_LINE =
  JSON.stringify({
    type: 'assistant',
    timestamp: '2026-08-30T10:00:00.000Z',
    message: {
      model: 'claude-sonnet-4-5',
      usage: { input_tokens: 1200, output_tokens: 340, cache_read_input_tokens: 5000, cache_creation_input_tokens: 200 },
    },
  }) + '\n';

test('parseClaudeLine：assistant+usage → 记录（含缓存读/写、reasoning=0）；非 assistant/坏 JSON → null', () => {
  const r = parseClaudeLine(CLAUDE_LINE, '1970-01-01T00:00:00Z');
  ok(r);
  equal(r?.ts, '2026-08-30T10:00:00.000Z');
  equal(r?.platform, 'claude-code');
  equal(r?.model, 'claude-sonnet-4-5');
  equal(r?.inputTokens, 1200);
  equal(r?.outputTokens, 340);
  equal(r?.cacheReadTokens, 5000);
  equal(r?.cacheWriteTokens, 200);
  equal(r?.reasoningTokens, 0);
  equal(parseClaudeLine('{"type":"user"}', 'x'), null);
  equal(parseClaudeLine('not-json', 'x'), null);
  equal(parseClaudeLine('{"type":"assistant","message":{}}', 'x'), null);
});

test('parseClaudeLine：reasoning 字段提取（reasoning_tokens/reasoning_output_tokens 合并）', () => {
  const line = JSON.stringify({
    type: 'assistant',
    timestamp: 't',
    message: { model: 'm', usage: { input_tokens: 10, output_tokens: 5, reasoning_output_tokens: 7 } },
  });
  const r = parseClaudeLine(line, 'f');
  ok(r);
  equal(r?.reasoningTokens, 7);
});

test('createClaudeSource：CLAUDE_CONFIG_DIR env 注入 → listFiles 递归扫 .jsonl', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hull-claude-'));
  const prev = process.env.CLAUDE_CONFIG_DIR;
  try {
    process.env.CLAUDE_CONFIG_DIR = join(dir, '.claude');
    mkdirSync(join(dir, '.claude', 'projects', 'proj', 'sub'), { recursive: true });
    writeFileSync(join(dir, '.claude', 'projects', 'proj', 'a.jsonl'), CLAUDE_LINE);
    writeFileSync(join(dir, '.claude', 'projects', 'proj', 'sub', 'b.jsonl'), CLAUDE_LINE);
    writeFileSync(join(dir, '.claude', 'projects', 'ignore.txt'), 'x');

    const src = createClaudeSource();
    const files = src.listFiles();
    equal(files.length, 2);
    ok(files.every((f) => f.endsWith('.jsonl')), '只扫 .jsonl');
    // 逐行解析走 parseLine
    const rec = src.parseLine?.(CLAUDE_LINE, 'f');
    equal(rec?.platform, 'claude-code');
  } finally {
    if (prev === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = prev;
    rmSync(dir, { recursive: true, force: true });
  }
});
