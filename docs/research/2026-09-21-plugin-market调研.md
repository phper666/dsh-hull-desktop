# 调研：插件市场（plugin-market）

> 日期：2026-09-21 · 需求：docs/prd/2026-09-07-plugin-market-prd.md（未启动）· 判级：**复杂**
> 版本：v2（外部调研推翻 v1 方向：从「壳插件自造格式」改为「**对接 dsh 官方插件生态**」——CON-R004 完全合规 + 零自造格式）

## 一、dsh 官方插件机制（外部调研查证，deepseek-ai/deepseek-harness 官方文档）

- **dsh 无官方插件市场/注册表**——插件靠 npm / github / tgz 自然分发，无发现机制。
- **插件形态**：npm 包 = **bundle**（`package.json#dsh.bundle` + `cordis.patch.yml`，即 `--patch` overlay 的结构化版本）；**profile** = `$DSH_HOME/profiles/<name>`，声明 `dsh.profile.bundles` 有序组合；底层 Cordis 框架。
- **安装**：`dsh plugin add` 转发 pnpm；`reconcilePlugins` 自动把带 `dsh.bundle` 的依赖写入 bundles 列表；**热挂载**能力已有（`ctx.pluginManager`）。
- **`dsh.client`**：browser 端插件声明，懒加载。
- 官方桌面壳（deepseek-harness-desktop）插件市场 UI = **"COMING SOON"**（官方未落地）；**社区 `dsh-market` 已完整实现**（见 §二）。

## 二、同类插件市场实现模式（外部调研）

| 工具 | 注册表/发现 | 分发 | 生命周期/安全 |
|:-----|:-----------|:-----|:-------------|
| **dsh-market（社区，最贴）** | 远端 `plugins.json`（JSON 指向 GitHub repo，非中心化）；内存缓存 1h + snapshot 兜底；条目 name/owner/url/category/install/deprecated | 校验 URL 白名单 → `dsh plugin add` | 验证可加载 → 热挂载；白名单 + 同源 CSRF + pnpm 禁 build script + `validate-registry.mjs` |
| Obsidian | `community-plugins.json`（releases repo 内 JSON 数组） | 各 repo GitHub Releases 拉 `manifest.json` + main.js | `versions.json`（插件版本→最低宿主版本）兼容降级；更新=对照 tag |
| Claude Code | GitHub repo 内 `marketplace.json`（name/owner/plugins） | 插件 repo 内 `.claude-plugin/plugin.json` | `plugin marketplace add` + 官方/社区双市场 + 审核管线 + `plugin validate` |
| VS Code | 中心化 marketplace | `.vsix` + SemVer 强制 | `vsce publish`；奇偶版本号 pre-release 约定 |
| Zed | Git repo | `extension.toml`（id/version/schema_version） | dev 本地安装先于发布 |

## 三、可复用模式（给 Hull）

1. **registry 协议**：JSON 列表文件指向 GitHub repo（Obsidian / dsh-market / Claude 同构）——提交=对 registry repo 提 PR，零自建后端。字段集参考 dsh-market：name/owner/url/category/install/deprecated + minDshVersion。
2. **manifest 复用**：dsh 已有 `package.json#dsh.bundle` —— **直接复用，不另造格式**。
3. **生命周期委托**：安装/更新/卸载全部委托 `dsh plugin`，Hull 只做 UI + 白名单校验 + 编排 + reconcile 回显；热挂载 dsh 原生。
4. **安全基线**：来源白名单（仅 registry 内 URL）+ 哈希校验（release asset SHA）+ pnpm 禁 build script + patch 配置变更明示 + 二次确认。
5. **兼容降级**：Obsidian `versions.json` 模式（条目 minDshVersion 提示；严格映射表 v2）。

## 四、结论与边界（给共识 v2.0 输入）

- **方向**：Hull 插件市场 = **dsh 插件生态的市场层**（发现/安装编排/状态回显），不造平行插件格式、不实现 dsh 侧能力（委托）。
- **CON-R004 合规**：插件跑在 dsh 内（官方扩展点 bundle/profile），Hull 仅负责市场 UI 与安装编排。
- **CON-R002 精神**：插件数据由 dsh 管理（$DSH_HOME/profiles、bundles），Hull 只读回显不写。
- 官方桌面壳市场 "COMING SOON" → 未来若官方 registry 上线，Hull 可接入（U 项）。

## 五、下一阶段

共识 v2.0（形态对接 dsh 生态）→ 扫描 → 拆子需求（Gate B）→ 契约 → 技术方案（复杂必产）→ 实现管道。
