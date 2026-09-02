import { test } from 'node:test';
import { equal, ok } from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createRooSource, parseRooFile, parseRooLine } from './roo';

// roo 与 cline 同构：anthropic usage + model + ts(ms)
const ASSISTANT = {
  role: 'assistant',
  model: 'claude-opus-4-1',
  usage: { input_tokens: 800, output_tokens: 210, cache_creation_input_tokens: 50, cache_read_input_tokens: 3000 },
  ts: 1782900000000,
};

test('parseRooLine：assistant + anthropic usage → 记录（platform=roo，含 cache + model）', () => {
  const r = parseRooLine(JSON.stringify(ASSISTANT), '1970-01-01T00:00:00Z');
  ok(r, '应解析出记录');
  equal(r?.platform, 'roo');
  equal(r?.model, 'claude-opus-4-1');
  equal(r?.inputTokens, 800);
  equal(r?.outputTokens, 210);
  equal(r?.cacheWriteTokens, 50);
  equal(r?.cacheReadTokens, 3000);
  equal(r?.ts, new Date(1782900000000).toISOString());
  equal(parseRooLine(JSON.stringify({ role: 'user', content: 'hi' }), 'x'), null);
});

test('parseRooFile：JSONL 与单行 JSON 数组兼容', () => {
  const jsonl = [JSON.stringify({ role: 'user', content: 'hi' }), JSON.stringify(ASSISTANT)].join('\n');
  equal(parseRooFile(jsonl, 'fallback').length, 1);
  equal(parseRooFile(JSON.stringify([ASSISTANT, ASSISTANT]), 'fallback').length, 2);
});

test('createRooSource：递归找 globalStorage/rooveterinaryinc.roo-cline/tasks/**/api_conversation_history.json', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hull-roo-'));
  try {
    // macOS 主路径
    const tasksDir = join(dir, 'Library', 'Application Support', 'Code', 'User', 'globalStorage', 'rooveterinaryinc.roo-cline', 'tasks', 'task-1');
    mkdirSync(tasksDir, { recursive: true });
    writeFileSync(join(tasksDir, 'api_conversation_history.json'), JSON.stringify([ASSISTANT]));
    // 无关文件不应被收集
    writeFileSync(join(dir, 'Library', 'Application Support', 'Code', 'User', 'globalStorage', 'rooveterinaryinc.roo-cline', 'tasks', 'task-1', 'other.json'), 'x');
    // ~/.vscode 变体
    const vscodeTasks = join(dir, '.vscode', 'User', 'globalStorage', 'rooveterinaryinc.roo-cline', 'tasks', 'task-2');
    mkdirSync(vscodeTasks, { recursive: true });
    writeFileSync(join(vscodeTasks, 'api_conversation_history.json'), JSON.stringify([ASSISTANT]));
    const src = createRooSource(dir);
    const files = src.listFiles();
    equal(files.length, 2, '主路径 + .vscode 变体各 1');
    const rs = src.parseFile!(JSON.stringify([ASSISTANT]), 'fallback');
    equal(rs.length, 1);
    equal(rs[0]!.model, 'claude-opus-4-1');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
