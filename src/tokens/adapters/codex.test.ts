import { test } from 'node:test';
import { equal, ok } from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { parseCodexFile, createCodexSource } from './codex';

function u(input: number, output: number, total: number, cached = 0, reasoning = 0) {
  return { input_tokens: input, cached_input_tokens: cached, output_tokens: output, reasoning_output_tokens: reasoning, total_tokens: total };
}

/** 新版 rollout token_count 事件行 */
function tokenCountLine(ts: string, last: unknown, total: unknown, model?: string) {
  return JSON.stringify({
    timestamp: ts,
    type: 'event_msg',
    payload: {
      type: 'token_count',
      info: { last_token_usage: last, total_token_usage: total, model_context_window: null },
      ...(model ? { model } : {}),
    },
  });
}

test('parseCodexFile 新格式：累计值 → 增量（非累计），模型从 turn_context 提取', () => {
  const text = [
    JSON.stringify({ timestamp: 'T0', type: 'turn_context', payload: { model: 'gpt-5.2', cwd: '/x' } }),
    tokenCountLine('T1', null, u(10, 5, 15)),
    tokenCountLine('T2', u(4, 3, 7), u(14, 8, 22)),
  ].join('\n') + '\n';

  const recs = parseCodexFile(text, 'fallback');
  equal(recs.length, 2, '两个事件 → 两条增量记录，非一条累计');
  // 首事件 = 全量（增量语义）；断言是增量而非累计
  equal(recs[0].inputTokens, 10);
  equal(recs[0].outputTokens, 5);
  equal(recs[0].model, 'gpt-5.2');
  equal(recs[0].ts, 'T1');
  // 第二事件：增量 4/3（累计 14/8 减前值 10/5）
  equal(recs[1].inputTokens, 4);
  equal(recs[1].outputTokens, 3);
  equal(recs[1].model, 'gpt-5.2');
});

test('parseCodexFile 新格式：单文件内重复快照幂等去重', () => {
  const text = [
    tokenCountLine('T1', null, u(100, 0, 100)),
    tokenCountLine('T2', null, u(100, 0, 100)), // 重复累计快照
    tokenCountLine('T3', u(50, 0, 50), u(150, 0, 150)),
  ].join('\n') + '\n';
  const recs = parseCodexFile(text, 'f');
  equal(recs.length, 2, '重复快照不计');
  equal(recs[0].inputTokens, 100);
  equal(recs[1].inputTokens, 50);
});

test('parseCodexFile 新格式：多流交错（parent+reviewer）→ 各流增量正确', () => {
  const text = [
    tokenCountLine('A1', null, u(100, 0, 100)),
    tokenCountLine('B1', u(40, 0, 40), u(40, 0, 40)),
    tokenCountLine('A2', u(50, 0, 50), u(150, 0, 150)),
    tokenCountLine('B2', u(50, 0, 50), u(90, 0, 90)),
    tokenCountLine('A3', u(70, 0, 70), u(220, 0, 220)),
  ].join('\n') + '\n';
  const recs = parseCodexFile(text, 'f');
  equal(recs.length, 5);
  equal(recs[0].inputTokens, 100); // A1
  equal(recs[1].inputTokens, 40); // B1
  equal(recs[2].inputTokens, 50); // A2（非 A 累计 150-40）
  equal(recs[3].inputTokens, 50); // B2
  equal(recs[4].inputTokens, 70); // A3
});

test('parseCodexFile：input 含 cached 子集 → 拆出纯 input（避免重复计费）；reasoning 提取', () => {
  const text = tokenCountLine('T1', null, u(100, 20, 160, 40, 7)) + '\n';
  const recs = parseCodexFile(text, 'f');
  equal(recs.length, 1);
  equal(recs[0].inputTokens, 60); // 100 - 40 cached
  equal(recs[0].cacheReadTokens, 40);
  equal(recs[0].outputTokens, 20);
  equal(recs[0].reasoningTokens, 7);
});

test('parseCodexFile 旧格式兼容：event_msg/token_count，模型从 payload.model', () => {
  const text =
    JSON.stringify({
      timestamp: 'T1',
      type: 'event_msg',
      payload: {
        type: 'token_count',
        info: { total_token_usage: u(800, 150, 1300, 300, 50) },
        model: 'gpt-5.2',
      },
    }) + '\n';
  const recs = parseCodexFile(text, 'f');
  equal(recs.length, 1);
  equal(recs[0].model, 'gpt-5.2');
  equal(recs[0].inputTokens, 500);
  equal(recs[0].cacheReadTokens, 300);
  equal(recs[0].outputTokens, 150);
  equal(recs[0].reasoningTokens, 50);
});

test('parseCodexFile：非 token_count / 坏 JSON 行跳过', () => {
  const text = [
    'not-json',
    JSON.stringify({ timestamp: 'T', type: 'user_message', payload: { type: 'input_text' } }),
  ].join('\n') + '\n';
  equal(parseCodexFile(text, 'f').length, 0);
});

test('createCodexSource：CODEX_HOME env 注入 → listFiles 递归扫 rollout jsonl', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hull-codex-'));
  const prev = process.env.CODEX_HOME;
  try {
    process.env.CODEX_HOME = join(dir, '.codex');
    mkdirSync(join(dir, '.codex', 'sessions', '2026', '06'), { recursive: true });
    const file = join(dir, '.codex', 'sessions', '2026', '06', 'rollout-x.jsonl');
    writeFileSync(file, tokenCountLine('T1', null, u(10, 5, 15)) + '\n');

    const src = createCodexSource();
    const files = src.listFiles();
    equal(files.length, 1);
    equal(files[0], file);
    // parseFile 走整文件解析
    const text = require('node:fs').readFileSync(file, 'utf8');
    const recs = src.parseFile?.(text, 'f') ?? [];
    equal(recs.length, 1);
    equal(recs[0].platform, 'codex');
    equal(recs[0].inputTokens, 10);
  } finally {
    if (prev === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = prev;
    rmSync(dir, { recursive: true, force: true });
  }
});
