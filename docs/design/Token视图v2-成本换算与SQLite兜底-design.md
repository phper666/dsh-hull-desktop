# Token 视图 v2 增量方案：成本换算 + opencode SQLite 兜底

> 判级：**复杂**（价格 seed 设计 + matcher + 多源 fallback）→ 本文档（承接 docs/design/Token消耗查看-tokens-design.md v2）
> 来源：飞书 ticket t100110（2026-09-02 用户拍板 #1+#2，排除 hook/API 平台/持久化缓存/API 计费）
> 参照：TokenTracker pricing/（litellm 价格表 + matcher 模式）· lib-1 调研（opencode.db schema）

## 一、#1 成本换算（token → USD）

### 设计决策
- **价格数据源**：内嵌静态 seed（`src/tokens/pricing.ts` PRICING_SEED 常量）——Hull 本地壳哲学，无网络依赖；价格 = 2026-09 快照（$ / 1M tokens，input/output/cacheRead/cacheWrite 分项），漂移靠人工更新 seed（v3 再议在线更新）
- **matcher**：`matchPrice(model)`——①去 provider 前缀（`opencode-go/deepseek-v4-flash` → `deepseek-v4-flash`）②小写归一 + 常见别名表（如 `claude-sonnet-4-5`→`claude-sonnet-4.5`）③先精确后包含匹配（seed key ∈ model 名）④命中返回价格，否则 `null`
- **成本口径**：`cost = input×p.in + output×p.out + cacheRead×(p.cacheRead ?? p.in×0.1) + cacheWrite×(p.cacheWrite ?? p.in)`（cache 默认价按 input 折扣惯例兜底）
- **诚实原则**：聚合行内**全部模型可定价才给 costUsd 数值，任一未知 → null**（不显示看似精确的漏算数字）；UI null 显示「—」
- seed 覆盖：deepseek-v4/v3 系列、glm 系列、mimo、kimi、gpt-5 系列、claude-4 系列、gemini 系列、qwen 系列（主流档；用户模型实测覆盖 35 个中的大头）

### 改动
| 文件 | 内容 |
|:-----|:-----|
| `src/tokens/pricing.ts`（新） | PRICING_SEED + matchPrice + computeCost(record→usd/null) + 单测 |
| `src/tokens/aggregator.ts` | summarize 聚合时按 model matchPrice 累加；UsageTotals 级 costUsd（null 语义） |
| `src/tokens/types.ts` | UsageTotals/UsageDimensionRow/UsageBucket 加 `costUsd: number \| null` |
| `src/renderer/tokens.js` | 汇总卡加「成本」卡 + 明细表成本列（null→「—」，fmtUsd：≥$1 两位小数、< $1 四位、≥$1K 用 K） |

## 二、#2 opencode SQLite 兜底（fallback 语义）

### 设计决策
- 主源 `token-history/*.json`（per-session byModel 明细，更细）**有效（≥1 条记录）→ 只用它**；无效（目录缺失/解析空）→ 兜底官方 SQLite `opencode.db`
- **两源永不叠加**（同一批会话的同源数据，叠加=双计）
- db 路径：macOS `~/Library/Application Support/opencode/opencode.db`、Linux `~/.local/share/opencode/opencode.db`
- Session 表列（lib-1 调研）：`PromptTokens/CompletionTokens/CacheCreationTokens/CacheReadTokens` + 模型/时间戳——**防御式查询**（列名可能随版本漂移：querySqlite null/缺列 → 跳过），session 级聚合无 byModel 细分 → model 用该行模型列或 'unknown'

### 改动
| 文件 | 内容 |
|:-----|:-----|
| `src/tokens/adapters/opencode.ts` | listFiles/parseFile 改双源派发：token-history 优先 → SQLite 兜底（querySqlite readonly，只 SELECT 所需列）+ 单测（token-history 存在时不用 db / 缺失时读 db / 列缺失防御） |

## 三、并行 lane 划分（write 边界不重叠）

| Lane | 文件 | 依赖 |
|:-----|:-----|:-----|
| A：opencode SQLite 兜底 | adapters/opencode.ts + opencode.test.ts | 独立 |
| B：成本换算 | pricing.ts + types.ts + aggregator.ts(+test) + tokens.js | 独立 |

集成：无共享文件冲突；Lane A/B 各自测试绿后主线程收口（typecheck + 全量 tokens 测试 + 本机实测成本数字）。

## 四、风险
| 风险 | 缓解 |
|:-----|:-----|
| 价格 seed 漂移（模型调价） | seed 带快照日期注释；匹配不到 → null「—」诚实展示 |
| opencode.db schema 漂移 | 防御式查询 + fallback 链（token-history → db → 空态） |
| 成本被误读为精确账单 | UI「—」语义 + 设计文档声明估算口径（本地价格表 × token 用量） |
