import { test } from 'node:test';
import { equal, ok } from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createClineSource, parseClineFile, parseClineLine } from './cline';

// anthropic 风格 assistant 消息（usage 含 cache 字段；ts 为 ms）
const ASSISTANT = {
  role: 'assistant',
  model: 'claude-sonnet-4-5',
  usage: { input_tokens: 1200, output_tokens: 340, cache_creation_input_tokens: 200, cache_read_input_tokens: 5000 },
  ts: 1782832269152,
};

test('parseClineLine：assistant + anthropic usage → 记录（含 cache + model）；其他行 → null', () => {
  const r = parseClineLine(JSON.stringify(ASSISTANT), '1970-01-01T00:00:00Z');
  ok(r, '应解析出记录');
  equal(r?.platform, 'cline');
  equal(r?.model, 'claude-sonnet-4-5');
  equal(r?.inputTokens, 1200);
  equal(r?.outputTokens, 340);
  equal(r?.cacheWriteTokens, 200);
  equal(r?.cacheReadTokens, 5000);
  equal(r?.ts, new Date(1782832269152).toISOString(), 'ms 转 ISO');
  equal(parseClineLine(JSON.stringify({ role: 'user', content: 'hi' }), 'x'), null);
  equal(parseClineLine('not-json', 'x'), null);
});

test('parseClineLine：旧版 metrics.tokens {prompt,completion,cached} + modelInfo.modelId 兜底', () => {
  const r = parseClineLine(
    JSON.stringify({ role: 'assistant', ts: 1782832269152, modelInfo: { modelId: 'deepseek/deepseek-v4-flash' }, metrics: { tokens: { prompt: 14114, completion: 196, cached: 256 } } }),
    '1970-01-01T00:00:00Z'
  );
  ok(r, 'metrics 形态应解析出记录');
  equal(r?.model, 'deepseek/deepseek-v4-flash');
  equal(r?.inputTokens, 14114);
  equal(r?.outputTokens, 196);
  equal(r?.cacheReadTokens, 256);
  equal(r?.cacheWriteTokens, 0);
  equal(parseClineLine(JSON.stringify({ role: 'assistant', metrics: { tokens: {} } }), 'x'), null);
});

test('parseClineFile：兼容 JSONL 与单行 JSON 数组两种版本', () => {
  // JSONL：每行一条消息
  const jsonl = [JSON.stringify({ role: 'user', content: 'hi' }), JSON.stringify(ASSISTANT), JSON.stringify({ role: 'assistant', content: 'x' })].join('\n');
  equal(parseClineFile(jsonl, 'fallback').length, 1);
  // 单行 JSON 数组（部分版本实际格式）
  const arr = JSON.stringify([{ role: 'user', content: 'hi' }, ASSISTANT, ASSISTANT]);
  equal(parseClineFile(arr, 'fallback').length, 2);
});

test('createClineSource：递归找 tasks/**/api_conversation_history.json + 端到端', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hull-cline-'));
  try {
    const tasksDir = join(dir, '.cline', 'data', 'tasks');
    mkdirSync(join(tasksDir, 'task-1'), { recursive: true });
    writeFileSync(join(tasksDir, 'task-1', 'api_conversation_history.json'), JSON.stringify([ASSISTANT]));
    mkdirSync(join(tasksDir, 'task-2'), { recursive: true });
    writeFileSync(join(tasksDir, 'task-2', 'api_conversation_history.json'), JSON.stringify([{ role: 'user', content: 'hi' }]));
    writeFileSync(join(tasksDir, 'task-2', 'other.json'), 'x');
    const src = createClineSource(dir);
    const files = src.listFiles();
    equal(files.length, 2, '递归找到 2 个 history 文件，忽略 other.json');
    const rs = src.parseFile!(JSON.stringify([ASSISTANT]), 'fallback');
    equal(rs.length, 1);
    equal(rs[0]!.model, 'claude-sonnet-4-5');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
