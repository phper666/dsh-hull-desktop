/**
 * 成本换算：token → USD（Token 视图 v2，docs/design/Token视图v2-成本换算与SQLite兜底-design.md §一）。
 * 价格口径参照 TokenTracker litellm 档（$ / 1M tokens，input/output/cacheRead/cacheWrite 分项）。
 * PRICING_SEED = 内嵌静态价格表（2026-09 快照）——无网络依赖，价格漂移靠人工更新 seed。
 * matchPrice：①取 '/' 后最后段去 provider 前缀 ②小写 + 版本号归一（`glm-5-3-flash`→`glm-5.3-flash`、`gpt-5.0`→`gpt-5`）
 *             ③精确匹配 → 包含匹配（seed key 与 model 互相子串，取最长 key 防泛化误配）→ 仍未中 null。
 * computeCost：input×p.in + output×p.out + cacheRead×(p.cacheRead ?? p.in×0.1) + cacheWrite×(p.cacheWrite ?? p.in)，$/1e6。
 */

export interface SeedEntry {
  /** $/1M input tokens */
  input: number;
  /** $/1M output tokens */
  output: number;
  /** $/1M cache read（命中）；缺省按 input×0.1 */
  cacheRead?: number;
  /** $/1M cache write（创建）；缺省按 input */
  cacheWrite?: number;
}

export interface CostInput {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

/** 2026-09 快照（$ / 1M tokens；主流档，非官方账单口径——估算用） */
export const PRICING_SEED: Record<string, SeedEntry> = {
  // —— DeepSeek v4 / v3 ——
  'deepseek-v4-flash': { input: 0.28, output: 0.42 },
  'deepseek-v4': { input: 0.56, output: 1.68 },
  'deepseek-v4-pro': { input: 2.0, output: 8.0 },
  'deepseek-v4-chat': { input: 0.56, output: 1.68 },
  'deepseek-v3': { input: 0.27, output: 1.1 },
  'deepseek-v3-flash': { input: 0.28, output: 0.42 },
  // —— GLM-5 / GLM-4 ——
  'glm-5.3-flash': { input: 0.15, output: 0.45 },
  'glm-5.2': { input: 0.6, output: 2.4 },
  'glm-5': { input: 0.8, output: 3.0 },
  'glm-5-flash': { input: 0.15, output: 0.45 },
  'glm-4.6': { input: 0.6, output: 2.4 },
  'glm-4.5': { input: 0.5, output: 1.8 },
  'glm-4.5-flash': { input: 0.1, output: 0.3 },
  'glm-4-plus': { input: 0.6, output: 2.4 },
  'glm-4-flash': { input: 0.1, output: 0.3 },
  // —— MiniMax MIMO ——
  'mimo-v2.5': { input: 1.2, output: 4.0 },
  'mimo-v2.5-pro': { input: 2.5, output: 10.0 },
  'mimo-v2.5-flash': { input: 0.6, output: 1.8 },
  // —— Kimi K2 ——
  'kimi-k2.7': { input: 0.6, output: 2.5 },
  'kimi-k2.7-code': { input: 0.3, output: 0.9 },
  'kimi-k2': { input: 0.6, output: 2.5 },
  'kimi-k2-turbo': { input: 0.6, output: 2.5 },
  'kimi-k2-thinking': { input: 0.6, output: 2.5 },
  // —— OpenAI GPT-5 ——
  'gpt-5': { input: 1.25, output: 10.0 },
  'gpt-5.1': { input: 1.25, output: 10.0 },
  'gpt-5.2': { input: 1.25, output: 10.0 },
  'gpt-5-mini': { input: 0.25, output: 2.0 },
  'gpt-5-nano': { input: 0.05, output: 0.4 },
  // —— Anthropic Claude-4 ——
  'claude-opus-4': { input: 15.0, output: 75.0, cacheRead: 1.5, cacheWrite: 18.75 },
  'claude-sonnet-4': { input: 3.0, output: 15.0, cacheRead: 0.3, cacheWrite: 3.75 },
  'claude-haiku-4': { input: 0.8, output: 4.0, cacheRead: 0.08, cacheWrite: 1.0 },
  'claude-opus-4.5': { input: 5.0, output: 25.0, cacheRead: 0.5, cacheWrite: 6.25 },
  'claude-sonnet-4.5': { input: 3.0, output: 15.0, cacheRead: 0.3, cacheWrite: 3.75 },
  'claude-haiku-4.5': { input: 1.0, output: 5.0, cacheRead: 0.1, cacheWrite: 1.25 },
  // —— Google Gemini 2.5 / 3 ——
  'gemini-3-pro': { input: 2.5, output: 15.0 },
  'gemini-3-flash': { input: 0.3, output: 2.5 },
  'gemini-2.5-pro': { input: 1.25, output: 10.0 },
  'gemini-2.5-flash': { input: 0.3, output: 2.5 },
  'gemini-2.5-flash-lite': { input: 0.1, output: 0.4 },
  // —— Qwen3 ——
  'qwen3-max': { input: 1.6, output: 6.4 },
  'qwen3-coder-plus': { input: 0.5, output: 1.8 },
  'qwen3-coder': { input: 0.2, output: 0.7 },
  'qwen3-235b': { input: 1.0, output: 4.0 },
  'qwen3-32b': { input: 0.5, output: 1.5 },
  // —— MiniMax M3 ——
  'minimax-m3': { input: 1.0, output: 8.0 },
};

/** 版本号归一：`4-5`→`4.5`（连字符版本）、`5.0`→`5`（去尾零）——别名表用规则替代，覆盖 claude-sonnet-4-5 / glm-5-3-flash / gpt-5.0 等 */
function normalizeModel(s: string): string {
  return s
    .toLowerCase()
    .replace(/(\d)-(\d)/g, '$1.$2')
    .replace(/(\d)\.0(?![0-9])/g, '$1');
}

/** 匹配模型 → 价格；未命中 null（诚实不估算：聚合行任一未知 → 整行 costUsd null） */
export function matchPrice(model: string): SeedEntry | null {
  const raw = String(model ?? '').trim();
  if (!raw) return null;
  const norm = normalizeModel(raw.split('/').pop() || raw);
  if (!norm) return null;
  if (PRICING_SEED[norm]) return PRICING_SEED[norm];
  // 包含匹配：seed key 与 model 互相子串；多个命中取最长 key（最具体，防 `mimo-v2.5` 误配 `mimo-v2.5-prox` 类）
  let best: SeedEntry | null = null;
  let bestLen = -1;
  for (const [key, entry] of Object.entries(PRICING_SEED)) {
    if ((norm.includes(key) || key.includes(norm)) && key.length > bestLen) {
      best = entry;
      bestLen = key.length;
    }
  }
  return best;
}

/** 成本：input×p.in + output×p.out + cacheRead×(p.cacheRead ?? p.in×0.1) + cacheWrite×(p.cacheWrite ?? p.in)，$/1e6 */
export function computeCost(t: CostInput, price: SeedEntry): number {
  const cacheRead = price.cacheRead ?? price.input * 0.1;
  const cacheWrite = price.cacheWrite ?? price.input;
  return (
    (t.inputTokens || 0) * price.input +
    (t.outputTokens || 0) * price.output +
    (t.cacheReadTokens || 0) * cacheRead +
    (t.cacheWriteTokens || 0) * cacheWrite
  ) / 1e6;
}
