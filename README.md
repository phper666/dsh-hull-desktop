中文 | [English](README.en.md)

# Hull Desktop（`dsh-hull-desktop`）

**围绕 DeepSeek Harness 的桌面开发工具——永远不碰它本身。**

Hull 是一个开源的 Electron 桌面壳，包住官方的 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（dsh）。它作为子进程启动并守护 dsh，通过 npm overlay 原位升级，渲染官方 Web UI——官方每次升级都会自动生效，没有任何 fork、patch 或替换。

Hull 面向程序员，在官方之上叠加自己的层：任务看板、原生托盘与通知集成、以及通过 dsh 官方扩展点提供的插件扩展——全部是增量的、可摘除的，绝不挡 dsh 的路。

> **状态：** M1 已交付——桌面壳、dsh 升级、Hull 自更新、设置页/托盘、主窗口壳框架（左侧导航 + 官方 UI 内嵌）全部完成并通过测试验收。M2 规划中：任务看板、原生集成补充（通知/开机自启/快捷键）、插件扩展。

> **AI 工作流声明：** 本项目使用 [ai-workflow-skills](https://github.com/phper666/ai-workflow-skills)（团队 AI 研发工作流 skills 套件）驱动开发——共识文档 → 三角色扫描 → 待确认闭环 → 接口契约 → 技术方案（判级）→ 实现纪律（TDD/lint/Review/Semgrep）→ 交付核验 → 变更传播 → 经验沉淀。工作流产物见 `docs/`（spec/共识、api/契约、design/技术方案、prd/需求、prototype/原型、records/实现记录、lessons/经验）。

## 设计原则

- **纯壳。** Hull 永不 fork、patch 或替换 dsh 及其 Web UI。官方每个版本发布当天即可在 Hull 中使用。
- **两条独立的升级通道。** dsh 通过壳内 npm overlay 升级（手动触发、原子替换、失败回滚）；Hull 本身作为独立应用自更新。互不阻塞。
- **功能都是增量层。** 壳原生功能住在 Electron 主进程；任何需要跑在 dsh 内部的功能走 dsh 官方插件扩展点（`--patch` overlay / bundle）。坏掉的特性层可随时禁用，不影响 dsh。
- **用户数据保持官方。** 会话、设置、凭据都在 `DSH_HOME` 里，Hull 绝不重新实现或改写。

## 功能状态

### ✅ M1 已完成（2026-08-18 验收）

- [x] 桌面壳：启动 / 守护 / 重启 dsh 子进程（S1/S2）
- [x] 主窗口壳框架：左侧 Hull 导航 + 右侧官方 Web UI 内嵌（S8）
- [x] 壳内 dsh 升级：npm overlay、原子替换、一键回滚（S3/S4）
- [x] Hull 自更新：独立升级通道（S5）
- [x] 设置页 + 系统托盘（S6）
- [x] 测试验收：222 单元 + 8 集成 + 8 e2e 全绿（S7）

### ⏳ M2 规划中

- [ ] 任务看板：规划与跟踪开发工作，可交给 agent 执行（壳导航已留占位）
- [ ] 原生集成补充：通知、开机自启、快捷键（托盘已完成）
- [ ] 通过 dsh 官方扩展点的插件扩展（宿主侧 + UI 侧）

## 架构

```
┌─ Hull（Electron 主进程）─────────────────────────┐
│  托盘 · 窗口 · 自启 · 升级管理器                   │
│  spawn dsh 子进程 → loadURL → 重启编排             │
└──────────────────────┬────────────────────────────┘
                       │ 子进程（Node）
┌─ dsh（官方 npm 包，不修改）───────────────────────┐
│  宿主插件 · API 网关 · 官方 Web UI                 │
│  └─ Hull 的增量层（可选插件）──────────────────┐   │
└──────────────────────────────────────────────────┘
```

## 许可证

[MIT](LICENSE)
