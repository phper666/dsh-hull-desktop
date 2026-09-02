# UI：Token 消耗查看 技术方案（v2：全量本地可解析平台扩展）

> 判级：**复杂**（平台适配器采集层扩展 + codex 解析重写 + SQLite 查询器 + 多平台重构）→ 本文档
> 来源：飞书需求 d6a252dd `[Hull][tokens] Token 消耗查看视图`（2026-08-30 已实现 v1：claude/codex/dsh）；2026-09-02 用户反馈「支持的平台太少 + 无法知道平台/模型」→ 扩展全量本地可解析平台
> 调研：docs/research/2026-09-02-agent-token-format-research.md（18 平台分级 + 本机实测）+ TokenTracker 源码对照（xiufengsun/TokenTracker v0.94.1，34 工具）
> 路线确认：**先只读本地**（不做 hook 注入 / 云端 API / 成本换算，v2 再议）

## 一、目标与边界

- 目标：Token 消耗视图覆盖**全量本地可解析平台**——每平台/每模型 token 用量（输入/输出/缓存/推理），小时/天/周/月粒度
- v1 边界（维持）：只读本地文件/SQLite，不做 API 计费（v2）、不做成本换算（v2）、不碰 DSH_HOME 写操作（CON-R002）
- 新增边界：SQLite 只读（`node:sqlite` 只读模式 open，绝不写）；平台适配器隔离，单源失败不影响他源；解析失败降级跳过该行/该源

## 二、平台清单（全量本地可解析，按确定性分档）

### T0 已实现（v1）
| 平台 | 源路径 | 格式 | 状态 |
|:-----|:-------|:-----|:-----|
| claude-code | `~/.claude/projects/**/*.jsonl` | JSONL assistant 行 `message.usage` | ✅ 已有 |
| codex | `~/.codex/sessions/**/*.jsonl` | JSONL（**新 rollout 格式解析失效，需重写**） | ⚠️ 修复 |
| dsh | `~/.dsh/sessions/**/session.jsonl[.zstd]` | JSONL zstd | ✅ 已有 |

### T1 高确定（格式本机实测/官方稳定，首发）
| 平台 | 源路径 | 格式 | token 字段 | 模型名 |
|:-----|:-------|:-----|:----------|:-------|
| opencode | `~/.opencode/token-history/YYYY-MM.json` | JSON 数组（按月），每条 `{sessionID,projectID,timestamp(ms),totals{input,output,total,reasoning,cache{read,write}},byModel{模型名:同结构}}` | totals/cache | ✓ byModel 键 |
| cline | `~/.cline/data/tasks/<id>/api_conversation_history.json` | JSONL（扩展名 .json）assistant 消息 `usage` | input/output/cache_creation/cache_read | ✓ |
| roo code | VS Code `globalStorage/rooveterinaryinc.roo-cline/tasks/<id>/api_conversation_history.json` | JSONL 同上（cline fork 同构） | 同上 | ✓ |
| gemini CLI | `~/.gemini/tmp/<hash>/chats/session-*.jsonl` | JSONL `tokens{input.promptTokenCount,output.candidatesTokenCount,cached.cachedContentTokenCount,total.totalTokenCount}` | ✓ | ✓ 消息 model |
| kimi code | `~/.kimi/sessions/**/wire.jsonl` | JSONL | 待实现时按实际结构防御式提取 | ✓ 防御式 |

### T2 中确定（TokenTracker 源码参照，SQLite 型；本机无数据 → 空态兜底）
| 平台 | 源路径 | 格式 | token 字段 |
|:-----|:-------|:-----|:----------|
| goose | `~/.local/share/goose/sessions/sessions.db` | SQLite `sessions` 表 `total_tokens/input_tokens/output_tokens` | ✓ |
| continue | `~/.continue/devdata.sqlite` `tokens_generated` 表 `{model,provider,promptTokens,generatedTokens}` | SQLite | ✓ |
| zed | `~/Library/Application Support/Zed/` SQLite `threads` | SQLite `cumulative_token_usage{input_tokens,output_tokens}` | ✓ |
| warp | `~/.warp/remote-server/codebase-indexes/index.sqlite` | SQLite `ConversationUsageMetadata.token_usage` 按模型数组 | ✓ |
| zcode | `~/.zcode/cli/db/db.sqlite` | SQLite（OpenCode-fork schema） | ✓ |
| qoder | `Qoder/SharedClientCache/cache/db/local.db` | SQLite assistant `token_info` | ✓ |
| copilot | `~/.copilot/session-store.db` | SQLite per-request usage | ✓ |
| kiro | `~/.kiro/**` | SQLite + JSONL 混合 | ✓ |

> T2 平台格式以 TokenTracker 源码实现为参照；本机未装 → 空态。实现时写「防御式解析 + 解析失败降级」，即使字段偏差也只损失该源，不影响他源。

## 三、架构（重构：平台适配器注册表 → 每平台独立 adapter 文件）

```
src/tokens/
  types.ts                    # UsageRecord/UsageSummary/TokenPlatform 联合类型扩展
  TokenUsageScanner.ts        # 注册表 + 扫描编排（listFiles/readFile/parseFile 派发）+ 单源失败隔离
  adapters/
    claude.ts  codex.ts  dsh.ts        # T0 迁移（独立文件）
    opencode.ts  cline.ts  roo.ts      # T1 JSONL/JSON 型
    gemini.ts  kimi.ts                 # T1
    sqlite.ts                          # SQLite 只读工具（node:sqlite readonly + 通用查询）
    goose.ts  continue.ts  zed.ts      # T2 SQLite 型
    warp.ts  zcode.ts  qoder.ts  copilot.ts  kiro.ts
  codex-usage-delta.ts        # codex 累计值→增量算法（TokenTracker consumeUsageDelta 移植）
  aggregator.ts               # 不变（platform::model 透视已支持）
  TokenUsageIpc.ts            # 不变
```

### 适配器接口契约（冻结）

```ts
// 每平台一个文件，导出 PlatformSource；注册表集中导入
export interface PlatformSource {
  platform: TokenPlatform;
  home: string;
  listFiles: () => string[];                          // 目标文件绝对路径（不存在 → []）
  parseLine?: (line: string, fallbackTs: string) => UsageRecord | null;  // 逐行型
  parseFile?: (text: string, fallbackTs: string) => UsageRecord[];       // 整文件型（覆盖 parseLine）
  readFile?: (path: string) => string;                // 特殊读取（zstd 解压等）
}
```

- `UsageRecord` 扩展增加 `reasoningTokens`（codex/gemini 有 reasoning 字段；默认 0）
- TokenPlatform 联合类型：`'claude-code' | 'codex' | 'dsh' | 'opencode' | 'cline' | 'roo' | 'gemini' | 'kimi' | 'goose' | 'continue' | 'zed' | 'warp' | 'zcode' | 'qoder' | 'copilot' | 'kiro'`
- 共享工具保留：`findUsageShape`（防御式深找）、`toRecord`、`num`、`safeJson`
- SQLite 工具 `sqlite.ts`：`querySqlite(dbPath, sql) → rows[]`，`node:sqlite` DatabaseSync readonly 打开，打开失败返回 null（单源隔离）

### codex 新 rollout 格式（关键修复）

`~/.codex/sessions/rollout-*.jsonl`（新版）：
- 事件类型 `turn_context`/`session_meta`/`token_count` 等，顶层**无** usage/model（旧解析失效根因）
- TokenCount 事件 `payload` 含 `total_token_usage`（**会话累计值**，非增量）+ 多流交错（parent + reviewer 无稳定 stream id）
- 算法（移植 TokenTracker `consumeUsageDelta`）：维护 LRU baselines(≤32)，`total - last = 增量`；重复快照幂等；累计回跳判 reset；交错流标记。模型从 `turn_context`/`session_meta` payload 或请求模型配置提取
- 单测：fixture 覆盖「单流累计 + 多流交错 + 重复快照 + reset 回跳 + 模型提取」

### opencode adapter（本机主力，优先）
- 主源 `~/.opencode/token-history/YYYY-MM.json`（JSON 数组，直接可用）：每 session 一条，`timestamp`(ms) + `totals` + `byModel`。**按 byModel 拆多条 UsageRecord**（model = 键，平台 = opencode，ts = timestamp）
- 兜底 `opencode.db`（SQLite，官方主存储）：Session 表 `PromptTokens/CompletionTokens/Cache*`——T2 阶段实现，T1 先 token-history
- reasoning：totals.reasoning → reasoningTokens

### cline/roo adapter
- `api_conversation_history.json` 逐行 JSONL；assistant 消息 `usage`（anthropic 同构）→ `toRecord`
- model 从消息 `model`；缓存字段同 claude

### gemini adapter
- `session-*.jsonl` 逐行；找到 `tokens`（TokensSummary）形态的对象 → 映射 `input.promptTokenCount→inputTokens`、`output.candidatesTokenCount→outputTokens`、`cached.cachedContentTokenCount→cacheRead`、`total.totalTokenCount` 兜底；model 消息内
- 防御式：找不到 tokens 形态行跳过

## 四、UI 扩展

- `tokens.js` PLATFORM_NAMES 补全 16 平台显示名
- 汇总卡不变（输入/输出/缓存/合计）；明细表已有 platform×model 两维
- 空态：支持平台列表更新（16 平台 + 数据路径指引）
- reasoning 列：明细表加「推理」列（有 reasoning 数据的平台显示，无则 0）

## 五、风险与回退

| 风险 | 缓解 |
|:-----|:-----|
| T2 SQLite schema 漂移（未文档化） | 防御式查询（列名存在性检查）+ 单源失败隔离 + 空态兜底；本机无数据不阻塞 |
| codex rollout 多流/累计语义错 | consumeUsageDelta 移植 + fixture 单测（单流/多流/幂等/reset） |
| opencode 版本差异（token-history vs SQLite） | 主 token-history，SQLite 兜底 T2 |
| 扫描性能（transcripts 大） | 流式逐行 + 非 usage 行提前 continue；SQLite 只查所需列 |

## 六、实现顺序（并行 lanes）

1. **Lane A 骨架**：types.ts 扩展 + TokenUsageScanner 重构为注册表 + 共享工具迁移 + codex 修复（delta 算法）+ sqlite.ts + 测试 → 现有 3 平台回归绿
2. **Lane B JSONL 组**：adapters/opencode.ts + cline.ts + roo.ts + gemini.ts + kimi.ts + 各自测试（fixture）——依赖 Lane A 接口契约，不碰共享文件
3. **Lane C SQLite 组**：adapters/goose/continue/zed/warp/zcode/qoder/copilot/kiro + sqlite 查询 + 测试——依赖 Lane A 接口契约
4. **集成**：注册表纳入全部 adapter + tokens.js UI 扩展 + 空态更新 → lint/typecheck/单测全绿 → 本机实测（opencode/cline 真实数据出数）

> 注：adapter 文件彼此独立、与共享文件 write 边界不重叠，Lane B/C 可在 Lane A 接口冻结后并行。
