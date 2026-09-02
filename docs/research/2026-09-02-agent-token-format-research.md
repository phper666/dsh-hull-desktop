# Token 视图平台扩展 · 主流 agent 本地 token 数据格式调研

> 日期：2026-09-02 · 来源：用户反馈「Token 消耗视图支持平台太少、无法知道平台/模型」
> 方法：本机实测（~/ 数据目录逐平台扫描 + 文件格式解析）× 外部调研（官方仓库/文档/DeepWiki/第三方逆向工具交叉验证）
> 覆盖：18 个主流 AI coding agent

## 结论先行

| 分级 | 平台 | 说明 |
|:-----|:-----|:-----|
| 🟢 可直接解析 | claude-code（已有）、codex（已有）、**opencode（本机实测完美）**、cline、roo code、gemini CLI、goose、continue | 本地有 token 数据 + 模型名，格式清晰 |
| 🟡 有坑 | zed、warp、copilot CLI | 有 token 但字段精简/格式未定型/新功能 |
| 🔴 不可用 | cursor、windsurf、trae、qoder、marscode、codeium、amazon q、aider(默认关) | 本地无 token 数据（云端计费）或需显式开启 |

## 本机实测（用户机器真实状态）

| 平台 | 本机数据 | 结论 |
|:-----|:---------|:-----|
| **opencode** | `~/.opencode/token-history/2026-0{6,7,8,9}.json`：**934 会话 / 35 模型 / 9 项目 / 4 个月** | **主力平台，数据完美**——按月 JSON 数组，每条 `{sessionID, projectID, timestamp, totals{input,output,total,reasoning,cache{read,write}}, byModel{模型名:{...}}}`，天然含平台+模型+时间 |
| cline | `~/.cline/data/tasks/<id>/api_conversation_history.json`（35KB，JSONL） | 有真实数据，usage 字段齐 |
| codex | 14 文件 `rollout-*.jsonl`（新格式），现有适配器仅扫出 1 条、model=unknown | **适配器对新格式失效**，需修 |
| dsh | 3 个 `session.jsonl.zstd` 解压后仅 session 头 1 行，无 usage | 本机确无 token 数据，扫 0 条属实 |
| claude-code | `~/.claude` 无 projects/ 数据 | 本机未使用 |
| qoder | projects 下 jsonl 为 0 | 本地无会话数据，token 需云端（与外部调研一致） |
| gemini/copilot | 仅 arkcli skills 目录，无会话数据 | 本机未使用 |

## 一、🟢 可直接解析

### 1. claude-code（已有，基线）
- 路径 `~/.claude/projects/<project>/<session>.jsonl`；JSONL
- assistant 行 `message.usage{input_tokens, output_tokens, cache_creation_input_tokens, cache_read_input_tokens}` + `message.model`
- 可靠度：高（官方公开，ccusage/claude-code-log 依赖）

### 2. codex（已有，需修新格式）
- 路径 `~/.codex/sessions/<...>.jsonl`（新版 `rollout-*.jsonl`）；JSONL
- token：`message.usage{prompt_tokens, completion_tokens}` + `input_tokens_details.cached_tokens`（无 cache 细分）；模型 `message.model`
- 可靠度：高（官方开源）。**本机新 rollout 格式：`turn_context`/`session_meta` 类型，顶层无 usage/model，现有解析失效**

### 3. opencode（⭐ 本机实测优先）
- 路径 `~/.opencode/token-history/YYYY-MM.json`（本机版本确凿存在）；JSON 数组
- 字段：`timestamp`(ms) + `totals{input, output, total, reasoning, cache{read, write}}` + `byModel{模型名: 同结构 totals}`
- 可靠度：本机实测高（934 会话/35 模型）。⚠️ 官方仓库当前主存储为 SQLite `opencode.db`（`TokenUsage{InputTokens,OutputTokens,CacheCreationTokens,CacheReadTokens}` session 级），`token-history/*.json` 官方未收录——适配器以 token-history 为主、SQLite 兜底

### 4. cline / 5. roo code（同构）
- 路径 `~/.cline/data/tasks/<id>/api_conversation_history.json`（roo：`globalStorage/rooveterinaryinc.roo-cline/tasks/<id>/...`）
- JSONL（扩展名 .json 实为 JSONL），assistant 消息 `usage{input_tokens, output_tokens, cache_creation_input_tokens, cache_read_input_tokens}` + `model`——与 claude-code 完全同构
- 可靠度：高（开源，官方明确供读取）

### 6. gemini CLI
- 路径 `~/.gemini/tmp/<project_hash>/chats/session-*.jsonl`
- `tokens`（TokensSummary）：`input.promptTokenCount / output.candidatesTokenCount / cached.cachedContentTokenCount / total.totalTokenCount` + 消息 `model`
- 可靠度：中高（官方录制服务自动写入，字段按 Gemini API 命名）

### 7. goose
- 路径 `~/.local/share/goose/sessions/sessions.db`（SQLite）+ 请求日志 `~/.local/state/goose/logs/llm_request.*.jsonl`
- SQLite `sessions` 表列 `total_tokens/input_tokens/output_tokens` + accumulated_*；JSONL 日志含完整 provider usage + model
- 可靠度：中高（SQLite 自 v1.10 主存储，表结构稳定）

### 8. continue
- 路径 `~/.continue/sessions/<id>.json` + `~/.continue/devdata.sqlite`（`tokens_generated` 表）
- session `usage{totalCost, promptTokens, completionTokens, promptTokensDetails}`；SQLite `tokens_generated{model, provider, promptTokens, generatedTokens}`
- 可靠度：中高（session 级 usage 非全写入，SQLite 事件日志更可靠）

## 二、🟡 可解析但有坑

### 9. zed
- `~/Library/Application Support/Zed/` SQLite；thread `cumulative_token_usage{input_tokens, output_tokens, max_tokens}`——无 cache 细分；模型仅 DbLanguageModel 引用
- 中：内部 Rust struct 序列化，agent/assistant 面板存储演进中

### 10. warp
- `~/.warp/remote-server/codebase-indexes/index.sqlite`；`ConversationUsageMetadata.token_usage` = 按模型数组（warp_tokens/byok_tokens/custom_endpoint_tokens）+ credits_spent
- 中：有 per-model 明细很契合，但 Rust 复杂结构需逆向

### 11. github copilot CLI
- `~/.copilot/session-state/` + `events.jsonl`（session 用量指标：requests/tokens/code changes）
- 中：token 持久化 2026-03 才加，未文档化，格式演进中——适合观察不宜投产

## 三、🔴 不可用

cursor / windsurf / trae / qoder / marscode / codeium / amazon q：本地仅会话消息无 token 计数（VS Code state.vscdb / KV 存储），token 用量在云端计费。aider：`analytics.jsonl` 字段齐全（main_model/prompt_tokens/completion_tokens/total_tokens）但**默认不写**（opt-in flag）。

## 适配器落地建议

**首发扩展**（高确定性，与 claude-code 模式同构）：
1. **opencode**（本机主力，token-history JSON 直接解析 + SQLite 兜底）
2. **cline / roo code**（JSONL，anthropic usage 同构，工作量≈claude 适配器）
3. **gemini CLI**（JSONL，tokens 完整）

**次批**（SQLite 需写查询器）：goose、continue、warp、zed

**同时修复**：codex 新 `rollout-*.jsonl` 格式解析失效（本机 14 文件仅出 1 条 + model=unknown）

**排除**：cursor/windsurf/trae/qoder/marscode/codeium/amazon q（本地无 token 数据，架构性不可行）；aider（默认无数据）；copilot CLI（格式未定型）

## 待验证/风险
- opencode `token-history/*.json` 官方仓库未收录——投产前对目标用户机器抽验；SQLite 兜底路径需写查询器
- copilot CLI events.jsonl / zed / warp SQLite 结构未公开文档化，投产前抽验实际文件
- gemini `~/.gemini/tmp` 结构随版本可能变化

## 交叉验证来源
- https://github.com/bawadou/ai-data-extractor（多平台磁盘路径+解析代码一手逆向）
- https://github.com/70548887/Qoder-Switch（Qoder state.vscdb 逆向）
- 各平台官方仓库/DeepWiki（openai/codex、cline/cline、google-gemini/gemini-cli、block/goose、continuedev/continue、zed-industries/zed、warpdotdev/Warp、github/copilot-cli、Aider-AI/aider）
