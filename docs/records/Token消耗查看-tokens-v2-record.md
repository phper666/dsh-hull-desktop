# 实现记录：Token 视图平台扩展 v2（全量本地可解析）

> 需求：飞书 ticket d6a252dd `[Hull][tokens] Token 消耗查看视图`（2026-08-30 实现 v1；2026-09-02 用户反馈「平台太少 + 无法知道平台/模型」→ v2 扩展）
> 分支：feature/tokens · commit 4f80d60
> 判级：**复杂**（16 平台适配器 + codex 解析重写 + SQLite 查询器 + 注册表重构）→ docs/design/Token消耗查看-tokens-design.md（v2 冻结）

## 一、改动范围

| 文件 | 改动 |
|:-----|:-----|
| src/tokens/types.ts | TokenPlatform 3→16 平台；UsageRecord/UsageTotals 加 reasoningTokens；PlatformSource 接口 |
| src/tokens/TokenUsageScanner.ts | 重构为 16 平台注册表（删内嵌解析，改用 adapters/） |
| src/tokens/aggregator.ts | reasoning 聚合 |
| src/tokens/adapters/ | 16 个平台 adapter + shared.ts（解析工具）+ sqlite.ts（node:sqlite readonly） |
| src/tokens/codex-usage-delta.ts | codex rollout 累计值→增量状态机（TokenTracker consumeUsageDelta 移植，LRU baselines ≤32） |
| src/renderer/tokens.js | PLATFORM_NAMES 16 平台 + 推理列 + 空态更新 |
| docs/design/Token消耗查看-tokens-design.md | v2 冻结（平台清单/架构/算法/排期） |

## 二、平台覆盖（16，本地只读）

- **T0 已有**：claude-code / codex（新 rollout 格式修复）/ dsh
- **T1 JSONL/JSON**：opencode（token-history byModel 拆分）/ cline / roo / gemini CLI / kimi
- **T2 SQLite**：goose / continue / zed / warp / zcode / qoder / copilot / kiro

排除（本地无 token 数据，架构性不可做）：cursor/windsurf/trae/marscode/codeium/amazon q/aider/copilot OTEL。

## 三、实现管道留痕

| 步骤 | 结果 |
|:-----|:-----|
| 实现 | 3 lanes 并行（fixer：codex delta+T0 / T1 JSONL / T2 SQLite）+ 集成（注册表+UI） |
| typecheck | `npx tsc --noEmit` ✓ 0 错误 |
| 单测 | **81 pass / 0 fail**（node:test，含 codex delta 7 用例 + 各适配器 fixture） |
| 本机实测 | opencode **1025 records/19 模型**（37 亿 token 出数）、zcode 762、cline 2；**16 平台无 ERR**（单源隔离）；byModel 透视 22 行平台+模型清晰 |
| Code Review | ocr 不可用（LLM 余额 401）→ 降级 @oracle 审查（结果见下） |
| Semgrep | 项目未配置（非安全敏感需求，风险记录） |

## 四、缺陷修复过程（本机实测驱动）

1. **roo EPERM**：宽扫 `~/Library/Application Support` 触 TCC 保护目录 → 收窄到已知编辑器 globalStorage 具体路径
2. **home 约定 bug**：集成按 `createSource(home=homedir())` 调用但部分 adapter 把 home 当数据根 → 全部改父根约定 + join 子路径（否则递归扫整个 ~ 卡死）
3. **cline 0 记录**：本机旧版文件无 anthropic usage → 加 metrics.tokens 兜底
4. **walk 权限容错**：所有 adapter 递归 readdirSync try/catch（EPERM/ENOENT 跳过子目录）

## 五、交付核验（对照用户反馈）

| 用户反馈 | 验证结果 |
|:---------|:---------|
| 支持的平台太少 | 3→16 平台（全量本地可解析）✓ |
| 无法知道哪个平台/模型的消耗 | opencode 19 模型 / byModel 22 行 [平台]模型:token 清晰展示 ✓；codex model 提取修复（原 unknown）✓ |

## 六、风险记录

- T2 SQLite 平台（goose/continue/zed/warp/zcode/qoder/copilot/kiro）本机未装 → 空态兜底；schema 以 TokenTracker 源码为参照，真实环境可能漂移（防御式查询 + 单源隔离已兜底）
- opencode 主源 token-history/*.json 为本机版本特有（官方仓库主存储 SQLite）——SQLite 兜底未实现（T2 后补）
- codex 本机 14 文件仅 1 条有 token_count 事件（数据少是真实的，非解析缺陷）
