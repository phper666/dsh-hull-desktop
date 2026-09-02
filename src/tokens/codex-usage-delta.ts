/**
 * codex 新 rollout 格式累计值→增量算法（TokenTracker consumeUsageDelta 移植）：
 * - 新版会话 ~/.codex/sessions/rollout-*.jsonl 的 token_count 事件 payload 含 total_token_usage（会话累计值，非增量）
 * - 一个 rollout 可含多条流（parent + reviewer），各自累计，事件无稳定 stream id
 * - 用 Codex 不变量恢复流：total - last = 该流前值；LRU baselines(≤32) 兼做交错流重复快照幂等；累计回跳判 reset
 * 纯函数，无 I/O。
 */

export const USAGE_FIELDS = [
  'input_tokens',
  'cached_input_tokens',
  'cache_creation_input_tokens',
  'output_tokens',
  'reasoning_output_tokens',
  'total_tokens',
] as const;

export const MAX_USAGE_BASELINES = 32;

export type CanonicalUsage = Record<(typeof USAGE_FIELDS)[number], number>;

export interface UsageDeltaState {
  lastTotal: CanonicalUsage | null;
  baselines: CanonicalUsage[];
  sawDivergentCumulative: boolean;
  sawInterleaved: boolean;
}

/** 归一化 usage → 六字段全量化（cache_creation 兼容 cache_write 别名）；无非数值字段 → null */
export function canonicalUsage(value: unknown): CanonicalUsage | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const o = value as Record<string, unknown>;
  const out: CanonicalUsage = {
    input_tokens: 0,
    cached_input_tokens: 0,
    cache_creation_input_tokens: 0,
    output_tokens: 0,
    reasoning_output_tokens: 0,
    total_tokens: 0,
  };
  let sawNumber = false;
  for (const field of USAGE_FIELDS) {
    const raw = field === 'cache_creation_input_tokens' ? (o.cache_creation_input_tokens ?? o.cache_write_input_tokens) : o[field];
    const number = Number(raw);
    if (Number.isFinite(number) && number >= 0) {
      out[field] = Math.floor(number);
      sawNumber = true;
    }
  }
  return sawNumber ? out : null;
}

function usageSignature(value: unknown): string | null {
  const usage = canonicalUsage(value);
  return usage ? USAGE_FIELDS.map((field) => usage[field]).join(':') : null;
}

/** 两个 usage 是否同一累计快照（全字段签名相等） */
export function sameUsage(left: unknown, right: unknown): boolean {
  const leftSignature = usageSignature(left);
  return leftSignature !== null && leftSignature === usageSignature(right);
}

/** total - last 逐字段相减；任一字段回退 → null */
function subtractUsage(totalUsage: unknown, lastUsage: unknown): CanonicalUsage | null {
  const total = canonicalUsage(totalUsage);
  const last = canonicalUsage(lastUsage);
  if (!total || !last) return null;
  const previous: CanonicalUsage = { ...total };
  for (const field of USAGE_FIELDS) {
    if (total[field] < last[field]) return null;
    previous[field] = total[field] - last[field];
  }
  return previous;
}

/** total - previous 逐字段（下限 0） */
function diffUsage(totalUsage: unknown, previousUsage: unknown): CanonicalUsage | null {
  const total = canonicalUsage(totalUsage);
  const previous = canonicalUsage(previousUsage);
  if (!total || !previous) return null;
  const delta: CanonicalUsage = { ...total };
  for (const field of USAGE_FIELDS) {
    delta[field] = Math.max(0, total[field] - previous[field]);
  }
  return delta;
}

/** 累计回跳判定：total.total_tokens < previous.total_tokens → reset */
export function totalsReset(totalUsage: unknown, previousUsage: unknown): boolean {
  const total = canonicalUsage(totalUsage);
  const previous = canonicalUsage(previousUsage);
  return Boolean(total && previous && total.total_tokens < previous.total_tokens);
}

/** 增量状态机（lastTotal + LRU baselines ≤32；lastTotal 兼作活跃流头） */
export function createUsageDeltaState(opts: { lastTotal?: unknown; baselines?: unknown[] } = {}): UsageDeltaState {
  const state: UsageDeltaState = { lastTotal: null, baselines: [], sawDivergentCumulative: false, sawInterleaved: false };
  for (const baseline of Array.isArray(opts.baselines) ? opts.baselines : []) {
    touchBaseline(state, baseline);
  }
  if (canonicalUsage(opts.lastTotal)) touchBaseline(state, opts.lastTotal);
  return state;
}

/** 快照当前 baselines（深拷贝，供持久化/测试） */
export function snapshotUsageBaselines(state: UsageDeltaState): CanonicalUsage[] {
  return Array.isArray(state?.baselines) ? state.baselines.map((usage) => ({ ...usage })) : [];
}

/**
 * 消费一个 token_count 事件：totalUsage = 累计值，lastUsage = 期望增量提示（事件自带）。
 * 返回该事件增量（无增量/重复快照 → null）。
 */
export function consumeUsageDelta(state: UsageDeltaState, lastUsage: unknown, totalUsage: unknown): CanonicalUsage | null {
  if (!state || typeof state !== 'object') throw new TypeError('usage delta state is required');
  if (!Array.isArray(state.baselines)) state.baselines = [];

  const last = canonicalUsage(lastUsage);
  const total = canonicalUsage(totalUsage);
  if (!total) return last;

  // 重复累计快照（限流重放等）→ 幂等，不计
  const activeSignature = usageSignature(state.lastTotal);
  const duplicateIndex = findBaselineIndex(state, total);
  if (duplicateIndex >= 0) {
    if (activeSignature !== null && usageSignature(state.baselines[duplicateIndex]) !== activeSignature) {
      state.sawInterleaved = true;
    }
    touchBaselineAt(state, duplicateIndex, total);
    return null;
  }

  if (last) {
    // total - last = 该流前值 → 命中既有流（last 即本事件增量）
    const expectedPrevious = subtractUsage(total, last);
    const lineageIndex = findBaselineIndex(state, expectedPrevious);
    if (lineageIndex >= 0) {
      if (activeSignature !== null && usageSignature(state.baselines[lineageIndex]) !== activeSignature) {
        state.sawInterleaved = true;
      }
      touchBaselineAt(state, lineageIndex, total);
      return last;
    }
    if (expectedPrevious) {
      if (canonicalUsage(state.lastTotal)) state.sawDivergentCumulative = true;
      touchBaseline(state, total);
      return last;
    }
  }

  // 活跃流累计差 = 增量（累计回跳判 reset 跳过）
  const active = canonicalUsage(state.lastTotal);
  if (active && !totalsReset(total, active)) {
    const delta = diffUsage(total, active);
    if (!last || Number(delta?.total_tokens || 0) <= Number(last.total_tokens || 0)) {
      const activeIndex = findBaselineIndex(state, active);
      touchBaselineAt(state, activeIndex, total);
      return delta;
    }
    // 累计跳变大于 last 提示 → 新流（非 append_last_usage 路径），不按无关累计缺口计费
    state.sawDivergentCumulative = true;
  }

  touchBaseline(state, total);
  return last || total;
}

function findBaselineIndex(state: UsageDeltaState, usage: unknown): number {
  const signature = usageSignature(usage);
  if (signature === null) return -1;
  return state.baselines.findIndex((baseline) => usageSignature(baseline) === signature);
}

function touchBaselineAt(state: UsageDeltaState, index: number, usage: unknown): void {
  const canonical = canonicalUsage(usage);
  if (!canonical) return;
  if (Number.isInteger(index) && index >= 0 && index < state.baselines.length) {
    state.baselines.splice(index, 1);
  } else {
    const duplicateIndex = findBaselineIndex(state, canonical);
    if (duplicateIndex >= 0) state.baselines.splice(duplicateIndex, 1);
  }
  state.baselines.push(canonical);
  while (state.baselines.length > MAX_USAGE_BASELINES) state.baselines.shift();
  state.lastTotal = canonical;
}

function touchBaseline(state: UsageDeltaState, usage: unknown): void {
  touchBaselineAt(state, findBaselineIndex(state, usage), usage);
}
