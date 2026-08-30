# UI：Token 消耗查看 技术方案

> 判级：**复杂**（新导航视图 + 平台适配器采集层 + 时间聚合 + 菜单变更）→ 本文档
> 来源：飞书新需求（2026-08-30）：壳新增菜单查看多平台模型 token 消耗（输入/输出/缓存，小时/天/周/月统计），菜单放 Skills 后，基础查看功能即可
> 参考：TokenTracker（调研报告 docs/research/2026-08-27-skills管理调研.md——本地文件解析 + 官方 API 两条路线）

## 一、目标与边界

- 目标：壳内新增「Token 消耗」视图——多平台模型 token 用量的基础查看：输入/输出/缓存分列 + 小时/天/周/月粒度聚合
- v1 边界：**只读本地文件**，不做 API 计费查询（arkcli/zcode billing 属 v2，需鉴权）、不做成本换算（价格表易变，v2）、不碰 DSH_HOME 写操作（CON-R002 红线：只读扫描不越线）

## 二、数据源策略（平台适配器注册表，TokenTracker 同构）

| 平台 | 源 | 格式 | v1 | 说明 |
|:-----|:---|:-----|:---|:-----|
| claude-code | `~/.claude/projects/**/*.jsonl` | JSONL：`type:"assistant"` 行 `message.usage{input_tokens,output_tokens,cache_creation_input_tokens,cache_read_input_tokens}` + `timestamp` + `message.model` | ✅ | 格式公开稳定（TokenTracker 核心源）；本机未装→空态 |
| codex | `~/.codex/sessions/**/*.jsonl` | JSONL（event_msg/token_count 事件 usage） | ✅ | 同上 |
| dsh | DSH_HOME（位置对 Hull 未知，CON-R002 零引用红线） | 内部格式未公开 | ⏳ v2 | 本机实测无公开可解析数据；待官方导出能力或格式调研（只读扫描不违反「不重写」，但耦合内部结构需谨慎） |
| zcode / API 型 | 官方 billing API | 需鉴权 | ⏳ v2 | arkcli/billing 路线 |

**诚实说明**：本机当前无任何已支持源的本地数据 → v1 上线后本机视图为空态 + 支持平台指引；装了 Claude Code/Codex 即出数据。dsh（用户主力）排 v2。

## 三、架构

```
src/tokens/
  TokenUsageScanner.ts   # 平台适配器：scan(platform) → UsageRecord[]
  types.ts               # UsageRecord / UsageSummary / 粒度枚举
  aggregator.ts          # summarize(records, granularity) → 桶序列 + 平台/模型透视
  TokenUsageIpc.ts       # IPC 注册（tokens:getUsage）
```

- `UsageRecord = { ts: ISO; platform; model; inputTokens; outputTokens; cacheReadTokens; cacheWriteTokens }`
- 聚合：粒度桶（hour/day/week/month，本地时区）× 两维透视（platform 合计、model 合计）+ 总计
- 性能：transcripts 可能大——逐行流式读、只取 usage 行、单次扫描全量返回（v1 无持久化缓存；量大后加缓存文件为后续增量）
- IPC：`tokens:getUsage(granularity)` → 渲染层单次拉取全量摘要（preload 桥 `window.tokens`）

## 四、UI

- 导航新增「Token 消耗」（Skills 之后，CON-R-theme-001 范围内壳自有 UI）
- 视图：粒度 segmented（小时/天/周/月）+ 汇总卡（输入/输出/缓存/合计，tabular-nums）+ 平台×模型明细表 + CSS 横条图（不引图表库）
- 空态：说明支持平台与数据来源路径（引导用户）

## 五、风险与回退

| 风险 | 缓解 |
|:-----|:-----|
| transcripts 大（单文件可达百 MB） | 流式逐行 + 提前 continue 非 usage 行；扫描失败单源隔离不影响他源 |
| 平台格式随版本漂移 | 适配器隔离 + 解析失败降级为跳过该行；空态兜底 |
| DSH_HOME 红线 | v1 零接触；v2 若做只读适配器需单独共识评审 |

## 六、排期

1. 本 PR：扫描器（claude-code/codex）+ 聚合器 + IPC + 视图 + 导航 + 单测（fixture）
2. v2：dsh 适配器（格式调研后）、成本换算、持久化缓存、API 型平台
