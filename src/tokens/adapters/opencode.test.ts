import { test } from 'node:test';
import { equal, ok } from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createOpenCodeSource, parseOpenCodeEntry, parseOpenCodeFile } from './opencode';

// 真实格式样本：按月 JSON 数组，每条含 totals + byModel（2 模型）
const ENTRY = {
  sessionID: 'ses_faa0e8ea8ffeTZylJzRTHnlOYu',
  projectID: '4f604cd87b5debc04b049a33bf94b14756d97915',
  timestamp: 1788319278155,
  totals: { input: 5344536, output: 116446, total: 5460982, reasoning: 71023, cache: { read: 102265280, write: 0 } },
  byModel: {
    'new-api/glm-5.3-flash': { input: 2704149, output: 55577, total: 2759726, reasoning: 61966, cache: { read: 58605248, write: 0 } },
    'new-api/deepseek-v4-flash-ga-260731': { input: 2640387, output: 60869, total: 2701256, reasoning: 9057, cache: { read: 43660032, write: 123 } },
  },
  cost: 0,
};

test('parseOpenCodeEntry：byModel 拆多条 UsageRecord（2 模型，ts 由 ms 转 ISO）', () => {
  const rs = parseOpenCodeEntry(ENTRY, '1970-01-01T00:00:00Z');
  equal(rs.length, 2, '2 模型 → 2 条');
  const byModel = Object.fromEntries(rs.map((r) => [r.model, r]));
  ok(byModel['new-api/glm-5.3-flash'], '有 glm 模型');
  ok(byModel['new-api/deepseek-v4-flash-ga-260731'], '有 deepseek 模型');
  for (const r of rs) {
    equal(r.platform, 'opencode');
    equal(r.ts, new Date(1788319278155).toISOString(), 'ms 转 ISO');
    ok(r.inputTokens > 0 && r.outputTokens > 0);
  }
  equal(byModel['new-api/glm-5.3-flash'].inputTokens, 2704149);
  equal(byModel['new-api/glm-5.3-flash'].cacheReadTokens, 58605248);
  equal(byModel['new-api/glm-5.3-flash'].reasoningTokens, 61966);
  equal(byModel['new-api/deepseek-v4-flash-ga-260731'].cacheWriteTokens, 123);
  equal(byModel['new-api/deepseek-v4-flash-ga-260731'].cacheReadTokens, 43660032);
});

test('parseOpenCodeEntry：无 byModel / 非对象 → 空；全零模型跳过', () => {
  equal(parseOpenCodeEntry({ timestamp: 1 }, 'x').length, 0);
  equal(parseOpenCodeEntry('str', 'x').length, 0);
  const zero = parseOpenCodeEntry({ timestamp: 1, byModel: { m: { input: 0, output: 0, cache: { read: 0, write: 0 } } } }, 'x');
  equal(zero.length, 0, '全零模型跳过');
});

test('parseOpenCodeFile：整 JSON 数组 → 全部记录', () => {
  const text = JSON.stringify([ENTRY, { sessionID: 's2', timestamp: 1788319278155, byModel: { 'model-b': { input: 5, output: 1, cache: { read: 0, write: 0 } } } }]);
  const rs = parseOpenCodeFile(text, 'fallback');
  equal(rs.length, 3);
  equal(parseOpenCodeFile('not-json', 'x').length, 0);
  equal(parseOpenCodeFile('{"a":1}', 'x').length, 0);
});

test('createOpenCodeSource：listFiles 读 token-history/*.json + 端到端 parseFile', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hull-opencode-'));
  try {
    const th = join(dir, '.opencode', 'token-history');
    mkdirSync(th, { recursive: true });
    writeFileSync(join(th, '2026-09.json'), JSON.stringify([ENTRY]));
    writeFileSync(join(th, 'note.txt'), 'x');
    const src = createOpenCodeSource(dir);
    const files = src.listFiles();
    equal(files.length, 1, '只收 .json');
    equal(src.platform, 'opencode');
    const rs = src.parseFile!(JSON.stringify([ENTRY]), 'fallback');
    equal(rs.length, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
