import { test } from 'node:test';
import { equal, ok } from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { parseClaudeLine, parseCodexLine, parseDshLine, platformSources, scanAllSources } from './TokenUsageScanner';

const CLAUDE_LINE =
  JSON.stringify({
    type: 'assistant',
    timestamp: '2026-08-30T10:00:00.000Z',
    message: {
      model: 'claude-sonnet-4-5',
      usage: { input_tokens: 1200, output_tokens: 340, cache_read_input_tokens: 5000, cache_creation_input_tokens: 200 },
    },
  }) + '\n';

const CODEX_LINE =
  JSON.stringify({
    timestamp: '2026-08-30T11:00:00.000Z',
    type: 'event_msg',
    payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 800, cached_input_tokens: 300, output_tokens: 150, reasoning_output_tokens: 50 } }, model: 'gpt-5.2' },
  }) + '\n';

const DSH_LINE =
  JSON.stringify({
    type: 'assistant',
    timestamp: '2026-08-30T12:00:00.000Z',
    message: { model: 'deepseek-v4', usage: { input_tokens: 640, output_tokens: 210 } },
  }) + '\n';

test('parseClaudeLine：assistant+usage → 记录（含缓存读/写）；非 assistant → null', () => {
  const r = parseClaudeLine(CLAUDE_LINE, '1970-01-01T00:00:00Z');
  ok(r, '应解析出记录');
  equal(r?.ts, '2026-08-30T10:00:00.000Z');
  equal(r?.platform, 'claude-code');
  equal(r?.model, 'claude-sonnet-4-5');
  equal(r?.inputTokens, 1200);
  equal(r?.outputTokens, 340);
  equal(r?.cacheReadTokens, 5000);
  equal(r?.cacheWriteTokens, 200);
  equal(parseClaudeLine('{"type":"user"}', 'x'), null);
  equal(parseClaudeLine('not-json', 'x'), null);
});

test('parseCodexLine：防御式深找 usage 形态（payload.info 层）', () => {
  const r = parseCodexLine(CODEX_LINE, '1970-01-01T00:00:00Z');
  ok(r, '应解析出记录');
  equal(r?.platform, 'codex');
  equal(r?.inputTokens, 800);
  equal(r?.outputTokens, 150);
  equal(r?.model, 'gpt-5.2');
});

test('parseDshLine：message.usage 优先；会话头行跳过', () => {
  const r = parseDshLine(DSH_LINE, '1970-01-01T00:00:00Z');
  ok(r);
  equal(r?.platform, 'dsh');
  equal(r?.model, 'deepseek-v4');
  equal(r?.inputTokens, 640);
  equal(parseDshLine('{"type":"session","createdAt":1}', 'x'), null);
});

test('scanAllSources：env 注入平台 home → 端到端扫描（含 dsh zstd 解压）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hull-tokens-'));
  const prevClaude = process.env.CLAUDE_CONFIG_DIR;
  const prevCodex = process.env.CODEX_HOME;
  const prevDsh = process.env.DSH_HOME;
  try {
    process.env.CLAUDE_CONFIG_DIR = join(dir, '.claude');
    process.env.CODEX_HOME = join(dir, '.codex');
    process.env.DSH_HOME = join(dir, '.dsh');
    mkdirSync(join(dir, '.claude', 'projects', 'proj'), { recursive: true });
    mkdirSync(join(dir, '.codex', 'sessions', 's'), { recursive: true });
    mkdirSync(join(dir, '.dsh', 'sessions', 'w', 'session-x'), { recursive: true });
    writeFileSync(join(dir, '.claude', 'projects', 'proj', 'a.jsonl'), CLAUDE_LINE + '\n');
    writeFileSync(join(dir, '.codex', 'sessions', 's', 'b.jsonl'), CODEX_LINE + '\n');
    const zlib = require('node:zlib');
    writeFileSync(join(dir, '.dsh', 'sessions', 'w', 'session-x', 'session.jsonl.zstd'), zlib.zstdCompressSync(Buffer.from(DSH_LINE + '\n')));

    const { records, sources } = scanAllSources(platformSources(join(dir, 'home-fake')));
    equal(records.filter((r) => r.platform === 'claude-code').length, 1);
    equal(records.filter((r) => r.platform === 'codex').length, 1);
    equal(records.filter((r) => r.platform === 'dsh').length, 1);
    for (const src of sources) {
      equal(src.files, 1, `${src.platform} 应扫到 1 文件`);
      equal(src.records, 1, `${src.platform} 应出 1 记录`);
      ok(!src.error, `${src.platform} 无错误：${src.error || ''}`);
    }
    // 复用路径再扫一次（幂等，不抛）
    const again = scanAllSources(platformSources(join(dir, 'home-fake')));
    equal(again.records.length, records.length);
  } finally {
    for (const [k, v] of [['CLAUDE_CONFIG_DIR', prevClaude], ['CODEX_HOME', prevCodex], ['DSH_HOME', prevDsh]] as const) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    rmSync(dir, { recursive: true, force: true });
  }
});
