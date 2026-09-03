# 主工具失败 → 先查同类 MCP 工具再考虑绕过（U-003 丢了 PR 记录页）

| 项 | 内容 |
|:---|:-----|
| 背景 | U-003 依赖图合并时 `gh pr create` 报 401（CLI 未登录），我跳过了 PR 环节直接本地 `merge --no-ff` + push main。事后用户提醒「不是有 mcp 吗」——GitHub MCP（github_create_pull_request / github_merge_pull_request）一直可用，且**本仓库 PR #3~#7 全是走 MCP 建的**（既有惯例），我却在工具失败瞬间降级到了本地直推，丢了 U-003 的 PR 记录页（分支已删，无法补建）。 |
| 决策或坑 | 工具失败的排查顺序钉死：**① 重试/换参数 → ② 找同类能力的其他通道（MCP / 另一 CLI / API）→ ③ 才是有损绕过（跳过留痕环节）**。关键认知：CLI 报的错（auth）只说明**这一条通道**不可用，不代表能力不可达；同一能力常有多个入口（本例：gh CLI ↔ GitHub MCP）。绕过前先问一句「这个能力还有没有别的入口」。 |
| 影响 | 不这样做：留痕环节静默丢失（PR 记录/评审页/讨论线程），事后不可补（分支删除后 PR 无 head）。这样做：U-003 本应有 PR #8 + squash/merge 记录可查。成本 = 一次工具清单检索（30 秒）。 |
| 适用范围 | 任何有 MCP + CLI 双入口的场景：GitHub（gh CLI ↔ github MCP）、飞书（lark-cli ↔ feishu MCP）、Jira（jira CLI ↔ jira MCP）等；也适用于任何「主路径报错即绕过」的冲动时刻。 |
| 来源 | 出生：U-003 依赖图合并（ticket t100108，merge 5cd25a9 走了本地直推）；对照：本仓库 PR #3~#7（github MCP 惯例先例） |
| 引用 | 首次引用：本 lesson 出生（2026-09-03） |
