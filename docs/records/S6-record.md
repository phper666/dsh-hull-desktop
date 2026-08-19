# S6 实现记录与核验记录

> 判级：复杂+安全敏感（设置页独立窗口 UI + settings 广播持久化 + 跨模块消费 S1~S5 承载点 + registry 配置影响安装源）
> 事实源：契约 `docs/api/feishu-s6-api-contract.md` v0.2（冻结 2026-08-17）、设计 `docs/design/S6-设置页托盘-design.md` 0.2（冻结 2026-08-17）

## 实现记录

### 文件清单（切片 1 逻辑层 + 切片 2 designer UI）
- `src/settings/SettingsProvider.ts` + 测试 — registry 字段（默认官方）+ on(changed) 广播（契约 #3 main 侧接口）+ migrate()（B5：schemaVersion < 3 字段补齐；损坏 → 告警 + 备份 + 回退默认）+ 校验（registry-invalid/version-invalid/persist-failed 契约码）
- `src/updater/Updater.ts` + 测试 — dismiss()（🟡-1：confirm → idle）+ settingsProvider 可选注入 + isAutoCheckEnabled()（autoCheckDsh 门控，无注入默认 true）
- `src/overlay/npmRunner.ts` + 测试 — getRegistry 注入（settings.registry 优先 + env 兜底）
- `src/updater/registry.ts` + 测试 — getRegistry 选项 + resolveRegistry()（显式 → settings → env → 默认官方）+ checkLatestVersion 透传 getRegistry（Y-1）
- `src/channel/ChannelService.ts` — metadataUrl 读 settings.registry（settings 优先）
- `src/main/index.ts` — settings.migrate() 装配时调 + maybeAutoCheck 补 autoCheckDsh 门控 + S3 稍后再说接 updater.dismiss()（🟡-1）+ npmRunner/Updater registry 接线
- ✅ 切片 2（designer UI，已实现）：`src/renderer/settings.html`（四卡：通用设置/dsh 运行时/Hull 应用/诊断，视觉 token 表，752 行）、`src/preload/settings.ts`（18 方法 IPC 白名单，纯透传）、`src/window/SettingsWindow.ts`（partition 'settings' 单实例，67 行）、TrayController 设置菜单启用 + tooltip、WindowManager.getWindow()

### TDD：18 新用例（SettingsProvider 9〔7 + 🟡-2/🟢 修复〕/ Updater 门控 3〔含 🟡-1〕/ HullUpdater 1 / npmRunner 2 / registry 3〔含 Y-1〕），S1-S5 201 回归 → 219 全绿

> 注：骨架预估「SettingsProvider 7+4 修复 / 门控 3 / registry 读取 4 / 修复 4」合计 22，实测 18（SettingsProvider 9 = 7 + 🟡-2/🟢；Updater 3 = 2 + 🟡-1；registry 3 = 2 + Y-1），总数 219 一致。

核心路径全测：registry 默认/持久化/广播/非法校验、migrate 字段补齐与损坏备份、persist-failed 契约码、on(changed) 全量、S1~S5 字段回归、autoCheckDsh/autoCheckHull 门控谓词、npmRunner/registry.ts/ChannelService 三消费点 registry 优先级（settings 优先 env 兜底）、dismiss 后 check 可恢复

### 质量
- `npm run typecheck`（tsc --noEmit）：干净
- `npm test`：219 pass / 0 fail，~1.1s
- `npm run build`：dist/ 全量产出

## 核验记录

### Code Review
- 双席 AI review（oracle 有条件通过 🟡×2 / gamma 有条件通过 🟡×1）→ 修复 4 项（🟡-1 S3 稍后再说接 updater.dismiss() / 🟡-2 persist-failed 契约码 / 🟢 migrate registry 校验 / Y-1 checkLatestVersion 透传 getRegistry）→ ora-1 复评「通过」
- 修复全程 TDD：先补/改测试（🟡-1/🟡-2/🟢/Y-1）再修实现

### Semgrep
- 1.172.0 自动配置 261 规则、49 文件扫描：0 findings

### 契约符合性（T6 场景对照）

| 场景 | 契约要求 | 单元级证据 | 状态 |
|---|---|---|---|
| T6-01 设置持久化 | 改 registry + 重启保留 | SettingsProvider S6-①/②（registry 持久化 + 广播）+ migrate（④⑤） | 单元级 ✓，UI 端到端待 S7 |
| T6-02 双区块 | 各自检查更新独立弹窗/进度 | Updater/HullUpdater 状态（S3/S5 用例回归）+ 门控（⑧⑨⑩） | 单元级 ✓，UI 端到端待 S7 |
| T6-03 关闭即退出 | 开关 → 关窗口行为变化 | closeToQuit 读（S1 用例回归）+ WindowManager 动态读 | 单元级 ✓，UI 端到端待 S7 |
| T6-04 托盘禁用 | 升级中升级项禁用 | queue.inFlight 数据源（S5 用例回归） | 单元级 ✓，UI 端到端待 S7 |
| T6-05 registry 校验 | 非法地址输入框提示 | SettingsProvider S6-③（registry-invalid） | 单元级 ✓，UI 端到端待 S7 |
| T6-06 日志入口 | 打开 Finder 目录 | S1 hull:openLogs（既有）+ openDataDir（切片 2） | 单元级 ✓，UI 端到端待 S7 |

### 变更传播闭环
- S4 契约 L21 回改（registry 字段落地 settings.json，env 降兜底）+ S2 偏离 3 修订（settings 优先 env 兜底）+ S3 契约 registry 消费注记 → **代码落地**：npmRunner/registry.ts/ChannelService 三消费点统一优先级（显式 → settings → env → 默认官方）
- S1~S5 代码零改动声明（Updater settingsProvider 可选注入，无注入行为不变——201 回归含 S1-S5 全量）

### 环境阻塞
- electron 二进制未下载（github.com 主站不可达）；恢复命令：`ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ node node_modules/electron/install.js`
- 设置页实际窗口渲染 + 真实升级/回滚/Hull 下载流程待运行时环境（T6 集成段）

### 风险登记
- **S7 承载点**：Playwright UI 端到端 + a11y 测试 + 真实升级/回滚/Hull 下载联调（T6-01~06 集成段）
- **🟢 settings.html `window.__closeModal` 全局暴露**：sandbox+contextIsolation 无实际风险——切片 2 实现时改事件委托或注记（评审已确认）
- **🟢-3 upgradeDsh target 来源 UI 细节**：S4 解锁文案落位（设置页 dsh 区块升级按钮 target 来源），S7 验证覆盖
- **切片 2 已实现**：settings.html 四卡（通用/dsh/Hull/诊断，视觉 token 表）+ settings preload IPC 白名单（评审确认纯透传边界）+ SettingsWindow（partition 'settings' 单实例）+ 托盘设置菜单启用——UI 端到端验证归 S7（Playwright）
