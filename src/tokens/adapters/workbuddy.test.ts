import { test } from 'node:test';
import { deepEqual, equal, ok } from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createWorkbuddySource, parseWorkbuddyLine, workbuddyProjectsDir } from './workbuddy';

const TS = 1783363097608;

/** 组装一行 JSONL message（providerData.usage 逐请求） */
function usageLine(usage: Record<string, unknown>, model: unknown = 'glm-5.3-flash'): string {
  return JSON.stringify({
    timestamp: TS,
    type: 'message',
    role: 'assistant',
    providerData: { model, requestModelId: 'auto', usage },
  });
}

test('workbuddy：usage 行口径 = input 扣缓存、cacheRead 单列、output 不叠加 reasoning', () => {
  const r = parseWorkbuddyLine(
    usageLine({
      requests: 1,
      inputTokens: 3505216,
      outputTokens: 6602,
      totalTokens: 3511818,
      inputTokensDetails: [{ cached_tokens: 2535616 }],
      outputTokensDetails: [{ reasoning_tokens: 214 }],
    }),
    ''
  );
  ok(r);
  equal(r.platform, 'workbuddy');
  equal(new Date(r.ts).getTime(), TS, 'timestamp(ms) → ISO');
  equal(r.model, 'glm-5.3-flash');
  equal(r.inputTokens, 3505216 - 2535616, 'inputTokens 含缓存命中 → 扣掉');
  equal(r.cacheReadTokens, 2535616);
  equal(r.outputTokens, 6602, 'reasoning 是 output 子集，不叠加');
  equal(r.reasoningTokens, 214, 'reasoning 仅展示');
  equal(r.cacheWriteTokens, 0);
  equal(
    r.inputTokens + r.outputTokens + r.cacheReadTokens + r.cacheWriteTokens,
    3511818,
    '与 aggregator 同式 == usage.totalTokens（对齐 TokenTracker）'
  );
});

test('workbuddy：model=auto → unknown；多段 cached 求和；input<cached 夹到 0', () => {
  const auto = parseWorkbuddyLine(
    usageLine({ inputTokens: 100, outputTokens: 10, inputTokensDetails: [{ cached_tokens: 40 }, { cached_tokens: 30 }] }, 'auto'),
    ''
  );
  ok(auto);
  equal(auto.model, 'unknown', 'auto 无法解析 → unknown（成本列「—」）');
  equal(auto.cacheReadTokens, 70, '多段 cached_tokens 求和');
  equal(auto.inputTokens, 30);

  const clamped = parseWorkbuddyLine(usageLine({ inputTokens: 100, outputTokens: 0, inputTokensDetails: [{ cached_tokens: 300 }] }), '');
  ok(clamped);
  equal(clamped.inputTokens, 0, '脏数据（cached > input）→ 夹到 0，不出负数');
  equal(clamped.cacheReadTokens, 300);

  equal(parseWorkbuddyLine(usageLine({ inputTokens: 5, outputTokens: 5 }, 'gpt-x'), '')?.model, 'gpt-x');
  equal(
    parseWorkbuddyLine(JSON.stringify({ timestamp: TS, providerData: { usage: { inputTokens: 5, outputTokens: 5 } } }), '')?.model,
    'unknown',
    'model 缺失 → unknown'
  );
});

test('workbuddy：非 usage 行 / 坏 JSON / 无 timestamp / 全零 → 跳过；function_call 带 usage 计入', () => {
  equal(parseWorkbuddyLine(JSON.stringify({ timestamp: TS, type: 'reasoning', providerData: { reasoning: 'x' } }), ''), null, '无 usage 对象');
  equal(parseWorkbuddyLine(JSON.stringify({ timestamp: TS, type: 'file-history-snapshot' }), ''), null);
  equal(parseWorkbuddyLine('{not json', ''), null, '坏 JSON');
  equal(parseWorkbuddyLine(JSON.stringify({ type: 'message', providerData: { usage: { inputTokens: 1 } } }), ''), null, '无 timestamp → 跳过（不 mtime 兜底）');
  equal(parseWorkbuddyLine(JSON.stringify({ timestamp: 'oops', providerData: { usage: { inputTokens: 1 } } }), ''), null, '非法 timestamp');
  equal(parseWorkbuddyLine(usageLine({ inputTokens: 0, outputTokens: 0, totalTokens: 0 }), ''), null, '全零行');

  // 实测：今日 14 条 usage 行中 12 条是 function_call 且带 providerData.usage —— 不能按 type 过滤
  const fc = parseWorkbuddyLine(
    JSON.stringify({ timestamp: TS, type: 'function_call', providerData: { model: 'glm-5.3-flash', usage: { inputTokens: 243885, outputTokens: 527, inputTokensDetails: [{ cached_tokens: 8576 }] } } }),
    ''
  );
  ok(fc, 'function_call + usage 也是用量行');
  equal(fc.inputTokens, 243885 - 8576);
});

test('workbuddy：listFiles 递归收集 **/*.jsonl（嵌套 subagents、非 jsonl 忽略、目录缺失 → []）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hull-workbuddy-jsonl-'));
  try {
    const projects = join(dir, '.workbuddy', 'projects');
    mkdirSync(join(projects, 'p1', 'subagents'), { recursive: true });
    writeFileSync(join(projects, 'a.jsonl'), '');
    writeFileSync(join(projects, 'p1', 'b.jsonl'), '');
    writeFileSync(join(projects, 'p1', 'subagents', 'agent-c.jsonl'), '');
    writeFileSync(join(projects, 'p1', 'note.txt'), '');
    writeFileSync(join(projects, 'top.db'), '');

    const src = createWorkbuddySource(dir);
    equal(src.platform, 'workbuddy');
    equal(src.home, projects);
    equal(workbuddyProjectsDir(dir), projects);
    deepEqual(
      src.listFiles().map((f) => f.slice(projects.length + 1)).sort(),
      ['a.jsonl', 'p1/b.jsonl', 'p1/subagents/agent-c.jsonl']
    );

    rmSync(projects, { recursive: true, force: true });
    equal(src.listFiles().length, 0, 'projects 目录缺失 → []（scanAllSources 跳过）');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
