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

## 五、v2.1 增量：对齐 TokenTracker 范围逻辑 + 小时桶持久化管道（2026-09-03 追加）

> 来源：用户走查反馈「范围数字不准/跨档不变」+ TokenTracker 截图对照（日/周/月/总计/自定义五档，准确率高）。差距分析：①我们只有起点 cutoff 无 to 边界（未来时间戳脏数据污染全档位）②TokenTracker total=最近24个月有界+custom 自定义区间，我们无③准确率根源=TokenTracker 写入时预聚合小时桶（queue.jsonl），我们每次实时全量解析（adapter bug 直接变数字 bug）。

### A. 范围窗口对齐（{from,to} 封顶 + 五档）
- 五档改：**日 / 周 / 月 / 总计 / 自定义**（TokenTracker 同构；替换 本小时/今天/本月/今年/全部）
  - day=今天、week=本周（周一起）、month=本月、total=最近 24 个月（有界）、custom=用户选日期区间
- **{from,to} 双边界**：to = 今天 23:59:59.999（本地时区）封顶——未来时间戳脏数据被右边界挡住
- 序列桶推导：day→hour 桶、week/month→day 桶、total→month 桶、custom→按跨度自适应（≤3天 hour、≤90天 day、否则 month）
- types.ts：UsageGranularity → 'day'|'week'|'month'|'total'|'custom'；UsageSummary 加 range{from,to}
- TokenUsageIpc：getUsage(period, customFrom?, customTo?)
- tokens.js：五档 segmented + custom 档两个日期 input（原生 `<input type="date">`，默认本月）

### B. 小时桶持久化管道（准确率/性能根治）
- 新模块 `src/tokens/usage-cache.ts`：
  - 桶结构：`{ version, generatedAt, buckets: {"platform::model::hourKey": {input,output,cacheRead,cacheWrite,reasoning}}, fingerprints: {platform: 组合指纹} }`（hourKey=YYYY-MM-DD HH:00）
  - 平台指纹：per-file fileFingerprint（已有，path:size:mtime sha1）排序后 sha256——源文件任何变化（增/删/改）→ 指纹变
  - CACHE_VERSION 常量：聚合逻辑改版时 bump → 缓存自动失效重扫
  - API：`loadOrScan(cachePath, sources) → {records, fromCache}`——指纹命中直接读桶（快），未命中 scanAllSources → 重建桶 → 落盘
- 聚合：`summarizeFromBuckets(buckets, range)`——桶 → series/byPlatform/byModel/totals（成本 matchPrice 同语义作用于桶透视）；写时算对的桶，查询层只做窗口内求和
- 存储：userData 目录（Electron app.getPath('userData')/token-buckets.json），TokenUsageIpc 注入路径；纯函数核心可测
- 集成：TokenUsageIpc.handle = loadOrScan → 桶在窗口内求和 → UsageSummary；指纹未命中才全量扫描（性能：平时读桶毫秒级）

### Lane 划分
| Lane | 文件 | 依赖 |
|:-----|:-----|:-----|
| A 范围窗口+UI | types.ts / aggregator.ts(+test) / TokenUsageIpc.ts / tokens.js | 独立（先直连 scanAllSources） |
| B 桶缓存模块 | usage-cache.ts(+test) | 独立纯模块 |
| 集成 | TokenUsageIpc 接 loadOrScan + summarizeFromBuckets | A+B 完成 |
