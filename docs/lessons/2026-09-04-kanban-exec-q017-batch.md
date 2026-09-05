# 2026-09-04 看板执行链 Q-017 批次：排队卡死 / ACP 协议对齐 / 模型与工作目录

## 判级

**复杂**——跨 main/renderer/存储/dsh 外部契约的多层修复 + 两个功能（模型选择、工作目录），含外部系统（dsh CLI）契约适配。

## 问题链与修复（6 层 + 2 功能）

| # | 层 | 问题 | 修复 |
|---|---|------|------|
| 1 | 重排 | 壳重启后 queued 任务不回调度器（内存队列丢失）→ 永久「排队中」 | `engine.start()` sweep 重排 + `kickNow()`；auto 缺 AC 转 failed |
| 2 | 结算 | provider 同步失败回调落在 drain 挂起前，`notifyChanged` 空操作 → 结算永久丢失（任务僵尸） | `wakeSoon()` queueMicrotask 延迟唤醒 |
| 3 | 定位 | dsh ACP 子进程定位硬依赖 `DSH_HOME` env（壳红线零引用）→ 每任务必败 | `overlayDir` 显式注入（`<userData>/dsh`），env 回退 |
| 4 | 契约 | dsh 0.1.2：ACP 是 profile 不是子命令（`dsh acp` exit 1）；ready 行带 `?token=`；入口解析被 Node CJS 缓存污染（swap 后 MODULE_NOT_FOUND） | spawn 改 `--profile acp`；`READY_LINE_RE` 捕获完整 URL；`dshEntryPath` 改 `realpathSync`（绕 `Module._pathCache`） |
| 5 | 协议 | dsh acp 实现标准 ACP（initialize/session/new/session/prompt），壳用自造方法名 → -32601 | ACPProvider 全面切换标准 ACP；`session/update` 通知解析；permission 改 request/response 帧 |
| 6 | 观测 | provider 真实失败原因三层被吞 → 全是通用 Q-015 文案 | `result.summary` 贯通 timeline + 失败通知（含同步回调合并路径） |

## 功能

- **模型选择**：ticket 级（agentSpec.model）> 看板级（board.defaultModel）> dsh 默认；清单 = acp configOptions ⊕ settings.yaml `llm-pi-ai.providers` 自定义渠道（只读合并）；执行时 `session/set_config_option` 真机验证 ACCEPT
- **工作目录**：ticket 级（agentSpec.cwd）> 看板级（board.defaultCwd）> `~`；`session/new` cwd 落地；原生目录选择器（`dialog:pickDirectory`）

## 验证记录

- 单测 967/967（935 → 967，全程 TDD 红绿）；typecheck 干净；build 通过
- 真机 smoke：协议三方法（initialize/session/new/session/prompt）全被 dsh 0.1.2-rc.1 接受；set_config_option 自定义 value ACCEPT；listModels 5 分组全出
- 用户实测：升级成功 ✓、执行链走通到 LLM 调用 ✓（失败原因已可见）

## 已知事项（下一批）

1. **用户动作**：ticket 执行需在卡片上选择模型（当前 test 票 agentSpec.model=null，回落官方路由无 key）——或 web Models 页补 DEEPSEEK_API_KEY
2. **会话归组复验**：工作目录已填但会话归组待复验（session/new cwd 已改，疑似 dsh 按子进程 cwd 归组，待证据）
3. **下一批**：模型/工作目录选择器加提示文案；dsh settings.yaml 自定义渠道在 acp 会话清单中的瞬态消失现象（一次出现过未复现，已用 settings 直读根治清单来源）
4. **中断恢复缺口**：dsh 升级中途退壳 → staging 孤儿 + 升级静默作废（CON-R005 原子性「中断恢复」缺口，独立改进项）

## 待办（后续批次）

- **会话深链**：dsh web 无 URL/事件会话深链机制（前端无 URLSearchParams/路由/openSession；实测 /sessions/<id> 404、?session= 仅 SPA 兜底）——壳当前用「在 web 打开」落到会话列表；若 dsh 上游支持会话深链（?session= 或 API），壳零成本接入。持续跟进。
- **时间线视图信息密度**：用户反馈一眼看不出「是什么执行的数据」——执行事件虽已从 `execute t_x` 改为「状态·退出码」摘要，但仍需优化：执行行应直接带任务标题/模型/耗时/结果摘要等关键信息，时间戳+类型徽标+标题+摘要分层清晰。后续批次做。



- **会话归组 ✓**：ticket 会话正确落在 `--Users-liyuzhao-AI--`（session/new cwd 生效，「未分组」根因 = 调试探测会话污染，见下）
- **推理力度 ✓**：真机实验 reasoning_effort=low → glm-5.3-flash 经火山网关流式回复 end_turn（off → thinking disabled → 400 根因链闭合）；终端兜底改 low（Q-021 修订）
- **会话复用 ✓**：`session/resume` 真实会话 ACCEPT（注意方法名是 resume 不是标准 ACP 的 load）；同 ticket 续会话已实现（Q-022）

## 事故与规范：真机 smoke 污染 ~/.dsh/sessions

排查期间协议探测与真机 smoke 直接使用真实 `~/.dsh`（未隔离 DSH_HOME），在 sessions/ 下留下 7 个垃圾工作区目录（opt-mismatch-dir/tmp/acp-probe 等），用户在 dsh web 看到大量「未分组」会话。已清理（保留用户真实数据）。

**规范（强制）**：真机 smoke / 协议探测**必须**用隔离环境——`DSH_HOME=$(mktemp -d)` 传入子进程，绝不落真实 `~/.dsh`；涉及真实环境的验证前先声明副作用。

## Code Review / Semgrep

- 本批次为多 lane 并行（fix-5 ×4 轮 + fix-6 ×2 轮），每 lane 独立 TDD + 交叉对账（字段契约两端核对）
- Semgrep：改动文件 0 命中（存量 PlatformRegistry TLS / depgraph sanitize 风险项此前已留档）
