import { test } from 'node:test';
import { equal, ok } from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { zstdCompressSync } from 'node:zlib';

import { parseDshLine, createDshSource } from './dsh';

const DSH_LINE =
  JSON.stringify({
    type: 'assistant',
    timestamp: '2026-08-30T12:00:00.000Z',
    message: { model: 'deepseek-v4', usage: { input_tokens: 640, output_tokens: 210 } },
  }) + '\n';

test('parseDshLine：message.usage 优先 → 记录；reasoning 提取', () => {
  const r = parseDshLine(DSH_LINE, '1970-01-01T00:00:00Z');
  ok(r);
  equal(r?.platform, 'dsh');
  equal(r?.model, 'deepseek-v4');
  equal(r?.inputTokens, 640);
  equal(r?.outputTokens, 210);
  equal(r?.reasoningTokens, 0);
  const r2 = parseDshLine(
    JSON.stringify({ type: 'assistant', timestamp: 't', message: { model: 'm', usage: { input_tokens: 10, output_tokens: 5, reasoning_tokens: 9 } } }),
    'f'
  );
  equal(r2?.reasoningTokens, 9);
});

test('parseDshLine：findUsageShape 兜底（嵌套深层 usage）；session 头跳过；坏 JSON → null', () => {
  const nested = JSON.stringify({
    type: 'something',
    timestamp: 't',
    data: { provider: { usage: { input_tokens: 30, output_tokens: 12 } } },
  });
  const r = parseDshLine(nested, 'f');
  ok(r, '应兜底深找');
  equal(r?.inputTokens, 30);
  equal(r?.outputTokens, 12);
  equal(r?.model, 'unknown');
  equal(parseDshLine('{"type":"session","createdAt":1}', 'x'), null);
  equal(parseDshLine('not-json', 'x'), null);
});

test('createDshSource：DSH_HOME env 注入 → listFiles 扫 .jsonl.zstd + readFile zstd 解压', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hull-dsh-'));
  const prev = process.env.DSH_HOME;
  try {
    process.env.DSH_HOME = join(dir, '.dsh');
    mkdirSync(join(dir, '.dsh', 'sessions', 'w', 'session-x'), { recursive: true });
    const file = join(dir, '.dsh', 'sessions', 'w', 'session-x', 'session.jsonl.zstd');
    writeFileSync(file, zstdCompressSync(Buffer.from(DSH_LINE + '\n')));
    writeFileSync(join(dir, '.dsh', 'sessions', 'ignore.txt'), 'x');

    const src = createDshSource();
    const files = src.listFiles();
    equal(files.length, 1);
    ok(files[0].endsWith('.jsonl.zstd'), '只扫 .jsonl.zstd');

    const text = src.readFile?.(file) ?? '';
    ok(text.includes('deepseek-v4'), 'zstd 解压出原文');
    const rec = src.parseLine?.(text.split('\n')[0], 'f');
    equal(rec?.platform, 'dsh');
    equal(rec?.inputTokens, 640);
  } finally {
    if (prev === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = prev;
    rmSync(dir, { recursive: true, force: true });
  }
});
