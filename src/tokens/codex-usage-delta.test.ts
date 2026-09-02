import { test } from 'node:test';
import { deepEqual, equal, ok } from 'node:assert/strict';

import {
  canonicalUsage,
  consumeUsageDelta,
  createUsageDeltaState,
  sameUsage,
  snapshotUsageBaselines,
  totalsReset,
} from './codex-usage-delta';

/** 构造六字段 canonical usage（缺省 0） */
function u(input: number, output: number, total: number, cached = 0, cacheCreate = 0, reasoning = 0) {
  return {
    input_tokens: input,
    cached_input_tokens: cached,
    cache_creation_input_tokens: cacheCreate,
    output_tokens: output,
    reasoning_output_tokens: reasoning,
    total_tokens: total,
  };
}

test('canonicalUsage：六字段归一化；cache_creation 兼容 cache_write 别名；无数值 → null', () => {
  deepEqual(canonicalUsage(u(10, 5, 15)), u(10, 5, 15));
  deepEqual(canonicalUsage({ input_tokens: 10, cache_write_input_tokens: 3, output_tokens: 5 }), u(10, 5, 0, 0, 3));
  equal(canonicalUsage(null), null);
  equal(canonicalUsage('x'), null);
  equal(canonicalUsage({ foo: 1 }), null); // 无 usage 字段
});

test('单流累计 → 正确增量（total - last = 前值；首事件 = 全量）', () => {
  const s = createUsageDeltaState();
  // 首事件：无 last → 全量
  deepEqual(consumeUsageDelta(s, null, u(10, 5, 15)), u(10, 5, 15));
  // 后续：last=本事件增量，total-last 命中既有流
  deepEqual(consumeUsageDelta(s, u(4, 3, 7), u(14, 8, 22)), u(4, 3, 7));
  deepEqual(consumeUsageDelta(s, u(6, 2, 8), u(20, 10, 30)), u(6, 2, 8));
  equal(s.sawDivergentCumulative, false);
  equal(s.sawInterleaved, false);
});

test('多流交错（parent+reviewer interleaved）→ 各流独立增量，标记 sawInterleaved', () => {
  const s = createUsageDeltaState();
  deepEqual(consumeUsageDelta(s, null, u(100, 0, 100)), u(100, 0, 100)); // A1
  deepEqual(consumeUsageDelta(s, u(40, 0, 40), u(40, 0, 40)), u(40, 0, 40)); // B1（新流，total-last=0 → divergent 标记）
  deepEqual(consumeUsageDelta(s, u(50, 0, 50), u(150, 0, 150)), u(50, 0, 50)); // A2
  deepEqual(consumeUsageDelta(s, u(50, 0, 50), u(90, 0, 90)), u(50, 0, 50)); // B2
  deepEqual(consumeUsageDelta(s, u(70, 0, 70), u(220, 0, 220)), u(70, 0, 70)); // A3
  ok(s.sawInterleaved, '交错流应标记');
});

test('重复快照幂等：total 未动 → null（限流重放不重复计数）', () => {
  const s = createUsageDeltaState();
  deepEqual(consumeUsageDelta(s, null, u(100, 0, 100)), u(100, 0, 100));
  equal(consumeUsageDelta(s, null, u(100, 0, 100)), null);
  deepEqual(consumeUsageDelta(s, u(50, 0, 50), u(150, 0, 150)), u(50, 0, 50));
  equal(consumeUsageDelta(s, u(50, 0, 50), u(150, 0, 150)), null);
});

test('累计回跳 reset：total 跌破前值 → 计 last 增量（而非累计差）', () => {
  const s = createUsageDeltaState();
  deepEqual(consumeUsageDelta(s, null, u(300, 0, 300)), u(300, 0, 300));
  // 回跳：total 300 → 100，last=100 增量
  deepEqual(consumeUsageDelta(s, u(100, 0, 100), u(100, 0, 100)), u(100, 0, 100));
});

test('totalsReset 判定：total.total_tokens < previous → true；反序/缺参 → false', () => {
  ok(totalsReset(u(100, 0, 100), u(300, 0, 300)));
  ok(!totalsReset(u(300, 0, 300), u(100, 0, 100)));
  ok(!totalsReset(u(100, 0, 100), null));
  ok(!totalsReset(null, u(100, 0, 100)));
});

test('sameUsage：签名相等判定；缺字段补 0；null 不等', () => {
  ok(sameUsage(u(10, 5, 15), { input_tokens: 10, output_tokens: 5, total_tokens: 15 }));
  ok(!sameUsage(u(10, 5, 15), u(10, 6, 16)));
  ok(!sameUsage(u(10, 5, 15), null));
});

test('snapshotUsageBaselines：深拷贝当前 LRU 流头（每流一个头）', () => {
  const s = createUsageDeltaState();
  consumeUsageDelta(s, null, u(10, 5, 15)); // 流 A
  consumeUsageDelta(s, u(4, 3, 7), u(4, 3, 7)); // 流 B（新流）
  const snap = snapshotUsageBaselines(s);
  equal(snap.length, 2);
  deepEqual(snap[0], u(10, 5, 15));
  deepEqual(snap[1], u(4, 3, 7));
  snap[0].input_tokens = 999;
  equal(s.baselines[0].input_tokens, 10); // 快照修改不影响状态
});
