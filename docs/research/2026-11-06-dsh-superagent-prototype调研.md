# dsh-superagent-prototype 调研 — 与 Hull 桌面壳的整合可行性

> 调研日期：2026-11-06 · 对象：https://github.com/deepseek-ai/dsh-superagent-prototype
> 方法：仓库静态深读（gh api，未 clone/未执行）+ Hull 本地能力面盘点（file:line 实证）+ 实时 registry 核对
> 结论用途：判断是否整合、如何借鉴；不含实现承诺

---

## 一、结论摘要（TL;DR）

1. **它是 dsh 的 bundle 插件**，不是独立服务：给 dsh 加一个"主动型仓库 agent"——轮询 GitHub（可选飞书）事件 → 模型研判 → 自动开工单 → 每单一个独立 worktree + 独立 dsh session 干活 → 回帖/开 PR，并在 dsh Web UI 侧边栏加一个 6 tab 管理面板。
2. **现在装不进 Hull 插件市场**，三条阻塞都在上游：① 未发布 npm（`private:true`）且仓库无构建产物、无 `prepare` 脚本 → Hull 的 `npm pack <url>` / `dsh plugin add <url>` 链路装上即坏；② 不在 registry（实测实时 9111 条无此仓）；③ `engines.dsh ^0.2.1-alpha.2` 与 Hull 默认 `latest`（当前 0.2.2-rc.1）不匹配。
4. **不建议产品级整合；强烈建议作为设计蓝本**：它补齐的正是 Hull 的三块空白（入站事件、GitHub/飞书集成、自动派单），且概念骨架与 Hull 现有执行面高度同构。
5. **可借鉴的 5 个机制**见 §五——比抄代码价值高得多（上游是 prototype：1 个 commit、0 issue、无 CI）。

---

## 二、事实卡片

| 项 | 值 | 证据 |
|:---|:---|:---|
| 形态 | dsh bundle 插件（`dsh.bundle.patch`）+ React client 面板（`dsh.client.platform=web`） | `package.json` |
| 包名/版本 | `dsh-superagent@0.1.0`，`private: true`（**npm 未发布**） | `package.json` |
| 许可 | MIT | `LICENSE` |
| node | `^22.19.0 \|\| >=24.0.0`（用内置 `node:sqlite`） | `package.json#engines` |
| dsh 版本 | **`^0.2.1-alpha.2`**（实测 semver 只匹配 0.2.1.x 预发布；`0.2.2-rc.1` 不匹配）；文档 pin `0.2.1-rc.3` | `package.json` / `docs/006` |
| 依赖 | 运行时仅 `zod` + `proper-lockfile`（轻）；24 个 `@deepseek-ai/*` peer | `package.json` |
| 存储 | 自建单 SQLite `<stateDir>/orchestrator.sqlite`（schema 11，只增不减） | `src/app/store.ts:1-6` / `docs/007` Persistence |
| 状态目录 | **必填绝对路径** `stateDir`；含 `work/`（每单工作区）、`worker-bin/`（gh/lark-cli shim）、`worker-gitconfig` | `examples/profile.cordis.patch.yml` / `src/infra/environment.ts:118-120` |
| 对外接口 | loopback `http://127.0.0.1:<port>/orchestrator/api/`，~22 路由，需 `x-orchestrator-request: 1` + 同源（无 token） | `src/app/api.ts` / `src/app/http.ts:1` |
| 面板 | 6 tab：Overview / Source / Trigger / Eval / Execution / Settings，注册进 dsh client slot `main`、`sidebar.panellist`、`plugins.row.config` | `src/client/index.tsx:46-60` / `docs/005-panel.md:13-24` |
| 成熟度 | 自称 research prototype；main **1 个 commit**（2026-10-31）、无 release/tag、**无 CI**、**0 issue**；但 ~60 个 spec、文档 ~180KB | 仓库元数据 |
| 安装链 | `npm i -g @deepseek-ai/dsh@0.2.1-rc.3` → clone → `pnpm i && pnpm build` → `dsh superagent --from-default-profile web --dump-config` → `dsh plugin --profile superagent add "link:$PWD"` | `docs/006-deployment.md` |

---

## 三、能力模型

### 3.1 主链路（source → reply）

```
Source（GitHub 通知流 / 订阅 issue·PR·review·CI / 飞书 @·私信）
  → Trigger → Thread（去重、线程归属）
  → gate + assessment（模型研判：accept / stop / ignore / unavailable）
  → Decision → Ticket + Mandate（工单 + 授权范围）
  → Assignment（maxWorkers 默认 3，范围 1–16）
  → worker Session（每单独立 DSH Session + 独立目录，prepare 命令模板化如 git worktree）
  → Report（progress / waiting / ready / blocked / failed / dropped）
  → Channel 回写原会话（issue 评论 / review thread / PR 评论 / 飞书话题）
  → outbox / effects（持久化副作用队列，退避重试）
```

**Subscription** 是关键设计：首条评论触发一次研判，之后同线程的评论/CI 变化直接 fan-out 给已有 worker，跳过重复研判。

### 3.2 角色与工具

| 角色 | preset | 工具面 |
|:---|:---|:---|
| router（主 Session） | `dsh-superagent-router`（禁写、禁 sleep、5s shell） | 14 个 `orchestrator_*`：read / route / ticket_retry / ticket_note / trigger_requeue / eval* / reply / thread_unsubscribe / settings_save / policy_sync / prompts_save |
| worker（执行 Session） | `dsh-superagent-worker`（读写 + shell + jobs + subagent） | 6 个：read / ack / report / thread_unrelated / thread_follow / trigger_handback |

内置 skill：`dsh-superagent-github`（gh 读 issue/PR/review/CI、回帖、开 PR）、`dsh-superagent-feishu`（lark-cli 读消息线程/转发/附件/文档、回话题）。

### 3.3 默认策略

| 参数 | 默认 | 位置 |
|:---|:---|:---|
| 受理模式 | `observe`（只观察不自动执行） | `src/policy.ts:84-95` |
| 研判超时 | 120s | 同上 |
| 最大并发 worker | 3（1–16） | 同上 |
| 单轮后台上限 | 30min | `src/executor/dsh.ts:32` |
| 循环周期 | ~2s pass loop | `docs/007` Runtime/Passes |

---

## 四、与 Hull 的兼容性分析

### 4.1 硬阻塞（4 条，全部在上游或架构约束）

| # | 阻塞 | 证据（Hull 侧 / 上游侧） |
|:--|:-----|:---|
| B1 | **打不了包**：`private:true` + 无 `lib/` 产物 + **无 `prepare` 脚本** | Hull：`src/plugins/manifest.ts`（`npm pack <url>` 预览）、`src/plugins/cli.ts`（`dsh plugin add <url>`）；上游只支持 `link:` 本地路径 |
| B2 | **不在 registry** | Hull：`src/plugins/whitelist.ts:9-11`（只认 registry 条目逐字命中）；实测实时 registry 9111 条，无 `deepseek-ai/dsh-superagent-prototype`（仅 4 个第三方仿制品：dsh-superagent-power / dsh-session-superagent / dsh-superagent-local / dsh-plugin-superagent） |
| B3 | **dsh 版本窗口冲突** | 上游 `engines.dsh ^0.2.1-alpha.2`；Hull `src/settings/SettingsProvider.ts:56` channel=`latest`，本机实测托管 **0.2.2-rc.1** → 不满足；Hull 只做 `minDshVersion` 提示不拦截（`src/plugins/installer.ts`） |
| B4 | **profile / 进程环境语义冲突** | 上游要求专用 profile 且改**进程级 `process.env.PATH`**（插 `worker-bin`）+ worker git 凭证配置（`src/infra/environment.ts:118-120`，文档明说 "process-wide"）；Hull 固定装到 `hull` profile（共识 CON-R-plugin-012），托管的是 `web` profile |

### 4.2 其他风险（不阻塞但必须知道）

| 风险 | 说明 |
|:---|:---|
| 破坏性安装步骤 | `dsh superagent --from-default-profile web` 会**替换已有 profile 并删掉其 `cordis.patch.yml`**（`docs/006` 明确警告） |
| 安全边界弱 | worker 以操作者 OS 用户 + `danger-full-access` 跑；`blockedCommands` / wrapper 是默认值不是安全边界（`docs/006` Permissions） |
| 数据只增不减 | trigger/disposition/decision/outbox/kv（含全部 settings/prompt 版本）永不清理；schema 只升不降（`docs/007` Persistence） |
| setup 拒绝陌生文件 | `<stateDir>/worker-bin`、`worker-gitconfig` 出现非它写的文件即拒启动；未知配置键阻止启动 |
| GitHub 账号约束 | 必须是 **github.com 用户账号**（GitHub App 不行，需读通知）；需独立 `gh` config；不支持 GHE |
| 环境前置（本机实测） | node 24 ✅ / pnpm ✅ / git 2.50 ✅ / python3 ✅ / **tmux ❌** / **git-lfs ❌** / **全局 dsh ❌** → `scripts/dsh-superagent start` 开箱失败 |
| 面板在第三方壳内渲染 | 走 dsh client slot，理论可在 Hull 的 WebContentsView 内显示，**未实测** |

### 4.3 Hull 现状对照（本仓库实证）

| 能力 | Hull 现状 | 与 superagent 关系 |
|:---|:---|:---|
| 入站事件 | **零**：`src/workflows/types.ts:7` 明写事件触发"留 v3"；workflows 仅手动/cron | **空白 → 它补** |
| GitHub / 飞书集成 | **零**：`grep -rni "lark\|feishu" src` 仅命中注释里的文档名；GitHub 仅插件 url 字符串 + 自更新 feed | **空白 → 它补** |
| 任务调度 | `src/exec/scheduler/Scheduler.ts`：并发上限 3、依赖就绪、失败传播、死锁兜底、父卡派生 | **强重叠**（概念同构） |
| 多 agent | `ProviderRegistry` 只注册 `dsh`，注释明写"不实现子 agent 编排本身" | 部分重叠 |
| 执行生命周期 | 心跳 / 取消 / 暂停 / 恢复 / 壳重启收敛（`Convergence.ts`）+ ACP 会话复用 | 重叠 |
| 编排流水线 | 6 种**线性**步骤（dsh-card / http / connection-action / token-budget / notification / delay），无 DAG/分支 | 部分重叠 |
| 任务看板 | 自建 `boards.json`（AC / dependencies / agentSpec），人工建卡派单 | 概念重叠（载体不同） |
| 通知 / 审批 | `notifications`（workflow / board-exec）+ `ApprovalManager` | 重叠 |
| 分发 | 插件市场（whitelist + registry） | 互补（若上架） |

---

## 五、值得借鉴的 5 个机制（后续设计输入）

按对 Hull 的价值排序。每条给出「它怎么做 → Hull 现状 → 落点建议」。

### M1 事件源抽象 + 订阅 fan-out
- **它**：Source（github / feishu）→ Trigger → Thread → Subscription；首条事件走研判，后续同线程事件直接派给已建 worker。
- **Hull**：零入站通道；`WorkflowScheduler` 只有 cron。
- **落点**：`src/workflows/` 增 Source 抽象（github notifications / issue comment / PR review / CI / feishu message），Trigger 表 + 线程去重键；Subscription 作为"跳过重复研判"的短路。

### M2 模型研判作为门禁（gate + assessment → decision）
- **它**：四态 decision（accept / stop / ignore / unavailable）+ 默认 `observe` 模式（只观察不执行，先跑一段时间看判断质量再放开）。
- **Hull**：只有人工建卡；无自动分诊。
- **落点**：看板"自动派单"前置一层研判器，复用 `ProviderRegistry`（dsh ACP）跑判定；`observe` 默认值是关键的产品化经验——先影子运行再放权。

### M3 一单一个隔离工作区
- **它**：`prepare` 命令模板化（典型 `git worktree add`），每单 `stateDir/work/<id>`，worker 在该目录内工作。
- **Hull**：`kanban/types.ts` 已有 `agentSpec.cwd` 字段，但没有自动派生 worktree。
- **落点**：卡进入 exec 前按模板派生 worktree（复用现有 exec 入口），完单后保留/清理策略可配置。

### M4 outbox / effects 持久化副作用队列
- **它**：所有出站副作用（回帖、改状态、通知）落 `effect`/`outbox` 表，带退避重试与幂等键；崩溃后重放。
- **Hull**：workflows 步骤失败即失败，无重试队列；通知 fire-and-forget。
- **落点**：workflows v3 的可靠性基座——先落一张队列表 + 重放器，比直接做 DAG 更有价值。

### M5 单 SQLite + 只读视图
- **它**：一个 `orchestrator.sqlite`（9 张表）+ `store-read.ts` 只读视图层；DB 只升不降，回滚靠升级前备份。
- **Hull**：per-domain JSON（boards / workflows / connections / notifications 各自落盘），跨域查询弱、并发写靠文件锁。
- **落点**：不是马上换库；先明确"跨域查询/事件流"需求，再评估是否引入单库。**注意反面教训**：它"永不清理"导致库无限增长。

### 附带：面板信息架构
6 tab（Overview / Source / Trigger / Eval / Execution / Settings）是"事件驱动 agent 系统"的合理操作面切分，可直接作为 Hull 未来「自动化」页的信息架构草案。

---

## 六、整合路径评估

| 路径 | 可行性 | 成本 | 判断 |
|:---|:---|:---|:---|
| **A. 装进 Hull 插件市场** | ❌ 不可行（B1/B2/B3/B4 全在上游） | — | 不做。除非上游发布 npm 包 + 上架 registry + 放宽 engines + 改成不改进程环境 |
| **B. 当设计蓝本（读文档 + 借鉴机制）** | ✅ 立即可做 | 低（阅读 + 设计输入） | **推荐**。精读 `docs/003-execution.md`、`docs/007-architecture.md`（Modules/Persistence）、`prompts/team/*`、`src/app/assessment.ts` |
| **C. 个人并行使用（不进 Hull）** | ⚠️ 可行但重 | 中高（独立 profile + 单独装 dsh 0.2.1-rc.3 + clone/build + tmux/git-lfs） | 可选。与 Hull 并行跑（Hull 托管 `web` profile，互不干扰） |
| **D. 直接搬代码进 Hull** | ❌ 不推荐 | 高 | 代码强耦合 `@deepseek-ai/*` 24 个 peer + dsh 内部服务注入（`inject = [agents, sessionController, ...]`），脱离 dsh 进程无法运行 |

---

## 七、待验证项（若后续推进）

1. `engines.dsh` 越界时 `dsh plugin add` 是**硬失败还是告警**（未实测）。
2. `dsh superagent --from-default-profile` 子命令是否真存在于 0.2.1-rc.3 CLI（仅据文档）。
3. 其 client 面板在 Hull 的 `WebContentsView` 内能否正常渲染（第三方 client bundle 资源加载路径未验证）。
4. 飞书链路实际可用性（文档称测过 `lark-cli` 1.0.90，本机 1.0.96）。
5. 一个更大、更该先答的问题：**Hull 托管的 `web` profile 与插件安装的 `hull` profile 是否语义分裂**（装到 `hull` 的插件在主会话是否加载）——见 §八。

---

## 八、顺带发现（与本次调研相关，独立于上游）

1. **registry 快照已陈旧**：`assets/plugins-registry-snapshot.json` 4105 条（2026-09-21），实时 registry **9111 条**。发 0.1.9 前建议重跑 `npm run snapshot`。
2. **profile 语义待核实**：Hull 启动 `dsh web`（= profile `web`，`src/runtime/spawnArgs.ts:96-97`），而插件市场装到 profile `hull`（`src/plugins/profile.ts:12`，CON-R-plugin-012）。-design 口径是"不污染用户业务 profile"，但**装好的插件是否在壳托管的主会话中生效未验证**。若两者确为独立配置，则当前插件市场装的所有插件都不会加载——应并入 R1 实测项。

---

## 九、关键文件索引（供后续精读）

**上游**
- `docs/000-philosophy.md` — 设计哲学
- `docs/001-domain.md` — 领域模型（Trigger / Thread / Ticket / Mandate / Report）
- `docs/003-execution.md` — 执行模型（assignment / worker 生命周期 / 授权）
- `docs/005-panel.md` — 面板信息架构
- `docs/007-architecture.md` — 模块图 / 持久化 / 测试清单 / 未决问题（70KB，按需）
- `prompts/orchestrator.md` / `worker.md` / `dispatch.md` / `team/*` — 角色 prompt 方法论
- `src/app/assessment.ts` — 研判实现（20KB）
- `src/app/http.ts` + `src/app/api.ts` — 管理 API 面
- `src/infra/environment.ts` — PATH / gitconfig 注入（风险点）

**Hull 侧对照**
- `src/exec/scheduler/Scheduler.ts` — 现有调度
- `src/workflows/{types,WorkflowEngine,WorkflowScheduler}.ts` — 现有线性编排
- `src/kanban/{types,KanbanStore}.ts` — 卡片模型（agentSpec / dependencies）
- `src/plugins/{whitelist,manifest,cli,profile}.ts` — 插件安装链
- `src/runtime/spawnArgs.ts` + `src/settings/SettingsProvider.ts` — dsh 托管与版本策略
