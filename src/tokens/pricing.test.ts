import { test } from 'node:test';
import { equal, ok } from 'node:assert/strict';

import { PRICING_SEED, computeCost, matchPrice } from './pricing';

test('seed：全部条目 input/output 为正（价格表结构完整）', () => {
  const keys = Object.keys(PRICING_SEED);
  ok(keys.length >= 40, `seed 覆盖量 ${keys.length} 应 ≥ 40`);
  for (const [k, p] of Object.entries(PRICING_SEED)) {
    ok(p.input > 0 && p.output > 0, `${k} input/output 必须为正`);
    if (p.cacheRead !== undefined) ok(p.cacheRead > 0, `${k} cacheRead 为正`);
    if (p.cacheWrite !== undefined) ok(p.cacheWrite > 0, `${k} cacheWrite 为正`);
  }
});

test('matchPrice：去 provider 前缀（/ 后最后段）', () => {
  equal(matchPrice('opencode-go/deepseek-v4-flash')?.input, PRICING_SEED['deepseek-v4-flash'].input);
  equal(matchPrice('deepseek/deepseek-v4-flash')?.input, PRICING_SEED['deepseek-v4-flash'].input);
  equal(matchPrice('sub2api-opencode-go/mimo-v2.5-pro')?.input, PRICING_SEED['mimo-v2.5-pro'].input);
});

test('matchPrice：小写归一 + 版本号别名（连字符/尾零）', () => {
  equal(matchPrice('GLM-5.3-Flash')?.input, PRICING_SEED['glm-5.3-flash'].input, '大小写');
  equal(matchPrice('new-api/glm-5-3-flash')?.input, PRICING_SEED['glm-5.3-flash'].input, 'glm-5-3-flash → glm-5.3-flash');
  equal(matchPrice('claude-sonnet-4-5')?.input, PRICING_SEED['claude-sonnet-4.5'].input, 'claude-sonnet-4-5 → 4.5');
  equal(matchPrice('gpt-5.0')?.input, PRICING_SEED['gpt-5'].input, 'gpt-5.0 → gpt-5');
});

test('matchPrice：包含匹配（seed key ∈ model，取最长 key）', () => {
  equal(matchPrice('new-api/deepseek-v4-flash-ga-260731')?.input, PRICING_SEED['deepseek-v4-flash'].input, '带版本后缀');
  equal(matchPrice('opencode/deepseek-v4-flash-free')?.input, PRICING_SEED['deepseek-v4-flash'].input, 'free 后缀');
  equal(matchPrice('opencode/mimo-v2.5-free')?.input, PRICING_SEED['mimo-v2.5'].input, 'free 后缀（非 pro）');
  // 多个 seed 命中时取最长 key（mimo-v2.5-prox → mimo-v2.5-pro 而非 mimo-v2.5）
  equal(matchPrice('mimo-v2.5-prox')?.input, PRICING_SEED['mimo-v2.5-pro'].input);
});

test('matchPrice：未命中 → null（诚实不估算）', () => {
  equal(matchPrice('unknown'), null);
  equal(matchPrice('opencode/hy3'), null);
  equal(matchPrice(''), null);
  equal(matchPrice('   '), null);
  equal(matchPrice(null as unknown as string), null);
});

test('computeCost：含缓存 + 显式 cache 价（claude-sonnet-4.5）', () => {
  const p = PRICING_SEED['claude-sonnet-4.5'];
  const cost = computeCost({ inputTokens: 1_000_000, outputTokens: 200_000, cacheReadTokens: 500_000, cacheWriteTokens: 100_000 }, p);
  const exp = (1_000_000 * p.input + 200_000 * p.output + 500_000 * (p.cacheRead as number) + 100_000 * (p.cacheWrite as number)) / 1e6;
  ok(Math.abs(cost - exp) < 1e-9, `实际 ${cost} 应 ≈ ${exp}`);
});

test('computeCost：缓存价缺省兜底（cacheRead=input×0.1、cacheWrite=input）', () => {
  const p = PRICING_SEED['deepseek-v4-flash']; // 无显式 cache 价
  const cost = computeCost({ inputTokens: 1_000_000, outputTokens: 500_000, cacheReadTokens: 100_000, cacheWriteTokens: 50_000 }, p);
  // 手算：1e6×0.28 + 5e5×0.42 + 1e5×(0.28×0.1) + 5e4×0.28 = 280000 + 210000 + 2800 + 14000 = 506800 → /1e6 = 0.5068
  ok(Math.abs(cost - 0.5068) < 1e-9, `实际 ${cost} 应 ≈ 0.5068`);
  // 零 token → 0
  equal(computeCost({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }, p), 0);
});
