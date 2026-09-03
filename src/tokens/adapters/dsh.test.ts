import { test } from 'node:test';
import { equal, ok } from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { zstdCompressSync } from 'node:zlib';

import { parseDshLine, parseDshFile, createDshSource } from './dsh';

const FALLBACK = '1970-01-01T00:00:00.000Z';

/** 多帧 zstd fixture：每参数一帧，拼接 */
const zstdFrames = (...frames: string[]): Buffer => Buffer.concat(frames.map((f) => zstdCompressSync(Buffer.from(f))));

const DSH_LINE =
  JSON.stringify({
    type: 'assistant',
    timestamp: '2026-08-30T12:00:00.000Z',
    message: { model: 'deepseek-v4', usage: { input_tokens: 640, output_tokens: 210 } },
  }) + '\n';

/** 事件行构造（真实形态：{type, seq, time(epoch ms), data}） */
const chunkUsage = (turn: number, step: number, usage: object, seq: number, time: number): string =>
  JSON.stringify({ type: 'assistant/chunk', seq, time, data: { turn, step, chunk: { type: 'usage', usage } } });
const msgUsage = (turn: number, step: number, usage: object, seq: number, time: number, model?: string): string =>
  JSON.stringify({
    type: 'assistant/message',
    seq,
    time,
    data: { turn, step, ...(model ? { message: { role: 'assistant', source: { model } } } : {}), usage },
  });
const header = (model: string, seq: number, time: number): string =>
  JSON.stringify({ type: 'request/header', seq, time, data: { header: { config: { provider: 'p', model } } } });

const T = (h: number): number => Date.UTC(2026, 7, 30, h); // 2026-08-30T0h:00:00Z
const iso = (h: number): string => new Date(T(h)).toISOString();

test('parseDshLine：assistant/chunk camelCase usage → 记录（DISJOINT 直接映射，cacheRead 不拆分）', () => {
  const r = parseDshLine(chunkUsage(1, 1, { inputTokens: 16041, outputTokens: 260, cacheReadTokens: 16320 }, 271, T(9)), FALLBACK);
  ok(r, '应解析出记录');
  equal(r?.platform, 'dsh');
  equal(r?.model, 'unknown', 'chunk 行无模型（跨行 fallback 属 parseFile 职责）');
  equal(r?.ts, iso(9), 'time epoch ms → ISO');
  equal(r?.inputTokens, 16041);
  equal(r?.outputTokens, 260);
  equal(r?.cacheReadTokens, 16320, 'cacheReadTokens 直接映射（DISJOINT）');
  equal(r?.cacheWriteTokens, 0);
  // 全零 chunk → null
  equal(parseDshLine(chunkUsage(1, 1, { inputTokens: 0, outputTokens: 0 }, 272, T(9)), FALLBACK), null);
});

test('parseDshLine：message.usage snake_case 既有路径；findUsageShape 兜底；session 头/坏 JSON → null', () => {
  const r = parseDshLine(DSH_LINE, FALLBACK);
  ok(r);
  equal(r?.model, 'deepseek-v4');
  equal(r?.inputTokens, 640);
  equal(r?.outputTokens, 210);
  const r2 = parseDshLine(
    JSON.stringify({ type: 'assistant', timestamp: 't', message: { model: 'm', usage: { input_tokens: 10, output_tokens: 5, reasoning_tokens: 9 } } }),
    'f'
  );
  equal(r2?.reasoningTokens, 9);
  const nested = JSON.stringify({ type: 'something', timestamp: 't', data: { provider: { usage: { input_tokens: 30, output_tokens: 12 } } } });
  const r3 = parseDshLine(nested, 'f');
  ok(r3, '应兜底深找');
  equal(r3?.inputTokens, 30);
  equal(parseDshLine('{"type":"session","createdAt":1}', 'x'), null);
  equal(parseDshLine('not-json', 'x'), null);
});

test('parseDshFile：流式快照去重（同 turn:step 最后非零 wins）+ request/header 模型 fallback', () => {
  const text = [
    JSON.stringify({ type: 'session', version: 0, id: 's1', createdAt: T(8) }),
    header('glm-5.3-flash', 13, T(8) + 1),
    chunkUsage(1, 1, { inputTokens: 16041, outputTokens: 260 }, 271, T(9)), // 中间快照
    chunkUsage(1, 1, { inputTokens: 16025, outputTokens: 191 }, 272, T(9) + 100), // 终值快照
    chunkUsage(1, 1, { inputTokens: 0, outputTokens: 0 }, 273, T(9) + 200), // 尾部零值
    msgUsage(1, 1, { inputTokens: 16025, outputTokens: 191 }, 274, T(9) + 300, 'glm-5.3-flash'), // message 终值（与 chunk 重复）
    chunkUsage(1, 2, { inputTokens: 782, outputTokens: 323, cacheReadTokens: 16320 }, 280, T(10)), // 另一请求：仅 chunk
    msgUsage(1, 2, { inputTokens: 16228, outputTokens: 423 }, 281, T(10) + 100), // message 终值
    DSH_LINE.trim(), // 既有 CC 同源形态（无 turn/step → 独立记录）
  ].join('\n');
  const recs = parseDshFile(text);
  equal(recs.length, 3, 't1s1 去重 1 条 + t1s2 去重 1 条 + legacy 1 条');
  const byKey = new Map(recs.map((r) => [r.inputTokens, r]));
  const t1s1 = byKey.get(16025);
  ok(t1s1, 't1s1 取最后非零（16025 非 16041）');
  equal(t1s1?.outputTokens, 191);
  equal(t1s1?.model, 'glm-5.3-flash', 'message.source.model');
  equal(t1s1?.ts, new Date(T(9) + 300).toISOString(), 'ts = 最后非零 usage 行（message 终值）的时间');
  const t1s2 = recs.find((r) => r.inputTokens === 16228);
  ok(t1s2, 't1s2 取 message 终值（非中间 chunk 782）');
  equal(t1s2?.outputTokens, 423);
  equal(t1s2?.model, 'glm-5.3-flash', 'chunk 行模型 fallback lastModel');
  equal(t1s2?.ts, new Date(T(10) + 100).toISOString(), 'ts = 最后非零 usage 行的时间');
  const legacy = recs.find((r) => r.inputTokens === 640);
  ok(legacy, 'legacy message.usage 行独立成记录');
  equal(legacy?.model, 'deepseek-v4');
});

test('parseDshFile：无行级时间戳的 usage 行跳过（禁止 mtime 兜底）+ 坏 JSON 跳过', () => {
  const text = [
    header('m', 1, T(8)),
    JSON.stringify({ type: 'assistant/chunk', seq: 2, data: { turn: 1, step: 1, chunk: { type: 'usage', usage: { inputTokens: 100, outputTokens: 10 } } } }), // 无 time
    JSON.stringify({ type: 'assistant/message', seq: 3, time: T(9), data: { turn: 1, step: 2, usage: { inputTokens: 50, outputTokens: 5 } } }),
    'not-json',
  ].join('\n');
  const recs = parseDshFile(text);
  equal(recs.length, 1, '只留有 time 的 usage 行');
  equal(recs[0].inputTokens, 50);
});

test('createDshSource：多帧 zstd 容器全解压 + parseFile 端到端（DSH_HOME env 注入）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hull-dsh-'));
  const prev = process.env.DSH_HOME;
  try {
    process.env.DSH_HOME = join(dir, '.dsh');
    mkdirSync(join(dir, '.dsh', 'sessions', 'w', 'session-x'), { recursive: true });
    const file = join(dir, '.dsh', 'sessions', 'w', 'session-x', 'session.jsonl.zstd');
    // 3 帧：session 头（帧1）+ chunk usage（帧2）+ message usage（帧3）——旧单帧解压会丢帧 2/3
    writeFileSync(
      file,
      zstdFrames(
        JSON.stringify({ type: 'session', version: 0, id: 's1', createdAt: T(8) }) + '\n',
        header('glm-5.3-flash', 1, T(8) + 1) + '\n' + chunkUsage(1, 1, { inputTokens: 16041, outputTokens: 260, cacheReadTokens: 16320 }, 2, T(9)) + '\n',
        msgUsage(1, 1, { inputTokens: 16025, outputTokens: 191 }, 3, T(9) + 100, 'glm-5.3-flash') + '\n'
      )
    );
    writeFileSync(join(dir, '.dsh', 'sessions', 'ignore.txt'), 'x');

    const src = createDshSource();
    const files = src.listFiles();
    equal(files.length, 1);
    ok(files[0].endsWith('.jsonl.zstd'), '只扫 .jsonl.zstd');

    const text = src.readFile?.(file) ?? '';
    ok(text.includes('"session"') && text.includes('16041') && text.includes('16025'), '多帧全解压（帧 1/2/3 行都在）');
    const recs = src.parseFile?.(text, FALLBACK) ?? [];
    equal(recs.length, 1, '同请求流式快照去重 → 1 条');
    equal(recs[0].platform, 'dsh');
    equal(recs[0].model, 'glm-5.3-flash');
    equal(recs[0].inputTokens, 16025);
    equal(recs[0].outputTokens, 191);
    equal(recs[0].ts, new Date(T(9) + 100).toISOString());
  } finally {
    if (prev === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = prev;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('createDshSource：单帧文件（旧格式）正常解析', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hull-dsh-single-'));
  const prev = process.env.DSH_HOME;
  try {
    process.env.DSH_HOME = join(dir, '.dsh');
    mkdirSync(join(dir, '.dsh', 'sessions', 'w', 'session-y'), { recursive: true });
    const file = join(dir, '.dsh', 'sessions', 'w', 'session-y', 'session.jsonl.zstd');
    writeFileSync(file, zstdCompressSync(Buffer.from(DSH_LINE)));
    const src = createDshSource();
    const recs = src.parseFile?.(src.readFile?.(file) ?? '', FALLBACK) ?? [];
    equal(recs.length, 1);
    equal(recs[0].inputTokens, 640);
    equal(recs[0].model, 'deepseek-v4');
  } finally {
    if (prev === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = prev;
    rmSync(dir, { recursive: true, force: true });
  }
});
