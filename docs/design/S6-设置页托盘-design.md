# S6 壳设置页与托盘完善 技术方案

> 工作项：S6 壳设置页 + 托盘完善（飞书 dsh-hull-desktop 清单）
> 状态：已冻结（多方复评通过，2026-08-17）
> 版本：0.2 · 2026-08-17
> 事实源：契约 `docs/api/feishu-s6-api-contract.md` v0.2（已冻结）；共识 `docs/spec/共识-Hull桌面壳-M1.md` v1.4（CON-R008/009/013）；S1~S5 设计（承载点：S1 closeToQuit/日志入口、S3 Updater 检查/回滚、S4 ChannelService 通道、S5 HullUpdater 状态）
> 判级：复杂+安全敏感。理由：设置页独立窗口 UI（greenfield）+ settings 广播持久化（on(changed) 变更传播）+ 跨模块消费 S1~S5 全部承载点 + registry 配置影响安装源（安全面）
> 偏离契约/共识处统一标注：⛔️ 见 §8 对照表

---

## 1. 背景与范围

**定位**：壳设置页（独立窗口）+ 托盘完善——dsh/Hull 双区块 + 通用设置 + 诊断；settings.json 持久化广播；集中消费 S1~S5 预留承载点。

**规则绑定**：CON-R008（版本通道入口：latest/指定版本）、CON-R009（升级触发可配置 + 应用前确认 + 失败提示）、CON-R013（registry 任意源）。

**范围**（契约 §范围，冻结）：设置页 UI（独立壳窗口）——dsh 区块（版本/运行状态/检查更新/回滚/版本通道入口/升级失败提示）、Hull 区块（版本/检查更新/自动检查开关/失败提示）、通用设置（registry/关闭即退出/dsh 自动检查开关）、诊断（打开日志/数据目录）；settings.json 持久化；托盘完整（状态/入口/升级中禁用）；关闭主窗口默认隐藏（closeToQuit 可改）。

**非目标**（契约 §非目标）：官方 UI 内集成（M2+）、升级执行逻辑（S3/S5 提供）。

**交付验收**：T6-01（改 registry + 重启 → 设置保留）、T6-02（双区块各自检查更新 → 独立弹窗与进度）、T6-03（关闭即退出开关 → 关窗口行为变化）、T6-04（升级进行中 → 升级项禁用）、T6-05（非法 registry → 输入框提示）、T6-06（打开日志目录 → Finder 对应目录）。

**变更传播面**（本设计必列，§8 登记）：
- ① **S4 registry 字段裁决点**：S4 曾裁 env 承载（HULL_REGISTRY，settings schema 冻结面不动）vs S6 契约 schema 明确 registry 字段 + T6-05 校验——**需评审裁**（设计倾向落地 settings.json 字段，见 D2）
- ② **S2 偏离 3 修订**：HULL_REGISTRY env → settings.registry 优先 + env 兜底（npmRunner/registry.ts 读取顺序）
- ③ S1 closeToQuit 消费（已有）+ 设置页窗口
- ④ S3 autoCheckDsh 开关消费（maybeAutoCheck 门控）
- ⑤ S5 autoCheckHull 开关 UI + HullUpdater 状态展示

**范围剪裁说明（YAGNI）**：UI 不引框架（原生 HTML/CSS/JS，D8）；UI 端到端验证归 S7（Playwright，⛔️ 偏离 2）；设置页窗口不挂官方 UI preload（独立窗口，S1 安全基线）。

---

## 2. 架构决策（含备选）

### D1 设置页窗口（B1/B2 修订）

独立 BrowserWindow（契约决策 #4，与官方 UI 隔离）——file: 加载 `src/renderer/settings.html` + 自身 preload 桥（`hull:getSettings` / `hull:setSettings` + 各功能 IPC）；`contextIsolation + sandbox`（S1 安全基线）。

**B1 独立 partition**：设置窗口 `partition: 'settings'` + **自身 preload 独立挂载**（webPreferences.preload 直挂，不继承主窗口 session.setPreloads 动态切换——防占位页双叠加/官方 UI preload 消失）。

**B2 页面轮询**：页面 250ms 轮询 `hull:getSettings`（S1/S2 同款 invoke 轮询，不透传回调不变式）；**D1 桥清单删 `hull:onSettingsChanged` 页面事件订阅项**（不建——轮询替代）；契约 #3 `SettingsStore.on(changed)` 为 **main 侧接口实现（广播预留，当前无订阅者）**。

托盘「Hull 设置…」菜单启用（S1 禁用占位 → S6 启用）。

### D2 SettingsStore（S4 SettingsProvider 扩展 + registry 裁决点）

S4 `SettingsProvider` 扩展 `on(changed)` 广播（EventEmitter——set 成功后 emit 全量 settings）+ **registry 字段落地**（⛔️ 偏离 1 裁决点）：
- **落地 settings.json 字段**（S6 契约 schema 明确 registry + T6-05 校验）——npmRunner/registry.ts 读取顺序改 **settings.registry 优先 + HULL_REGISTRY env 兜底**（S2 偏离 3 修订，变更传播登记；**B7：三消费点**——S2 安装〔npmRunner〕/ S3 check〔registry.ts〕/ S4 listVersions〔registry.ts〕，优先级统一「settings 优先 env 兜底」）
- 校验（SETTINGS_ERRORS 三码）：registry-invalid（URL 格式）/ version-invalid（pinnedVersion 格式，S4 校验链复用）/ channel 组合（pinned 必填 pinnedVersion）/ persist-failed（写失败，S4 B5 语义；**≡ settings-write-failed 别名，A2**）
- **标注评审裁**：S4 曾裁 env 承载（settings schema 冻结面）——S6 契约 schema 明确字段 + T6-05 验收要求字段持久化，倾向修订（变更传播）

### D3 dsh 区块

currentVersion（OverlayManager）/ 运行状态（RuntimeManager on(status)）/ 检查更新（S3 Updater.check）/ 回滚（canRollback 禁用态 + rollback）/ 版本通道入口（S4 ChannelService get/set/listVersions）/ 升级失败提示（按钮下方）。

### D4 Hull 区块

版本（app.getVersion）/ 检查更新（S5 HullUpdater.check）/ autoCheckHull 开关 / 失败提示（按钮下方）。

### D5 通用设置

registry（校验 + 持久化 + 广播）/ closeToQuit（S1 消费——WindowManager close 行为）/ autoCheckDsh（S3 maybeAutoCheck 消费）。

**B4 门控落点（main/index.ts，代码归实现波）**：`maybeAutoCheck` 补 `autoCheckDsh` 门控（settings 读）+ 新增 `maybeAutoCheckHull`（autoCheckHull 门控，S5 已实现 isAutoCheckEnabled——S6 统一走 settings 动态读）。

### D6 诊断

打开日志目录（S1 hull:openLogs 已有）/ 打开数据目录（新增 `hull:openDataDir`——shell.openPath userData）。

### D7 托盘完善（B6 修订）

S5 已加菜单（检查 dsh/Hull 更新），S6 补——dsh 运行状态显示（版本/地址 tooltip）+ 升级中禁用（queue.inFlight 数据源，S5 已实现 busy 禁用）+ 设置菜单启用（S1 禁用占位 → S6）。**B6：删托盘 Hull 更新入口表述**——Hull 更新入口在设置页 Hull 区块（确认框 = 设置页内嵌 dialog；契约 A3 托盘仅「检查 dsh 更新」）。

### D8 UI 设计（B9 落稿）

**designer 参与**（设置页布局/视觉）；UI 验证归 S7（Playwright）——S6 用 node:test 逻辑单测 + 注记（⛔️ 偏离 2）。

**B9 UI 方向落稿**：
- **四卡顺序**：通用设置 / dsh 运行时 / Hull 应用 / 诊断
- **视觉 token 表**：背景 `#f6f6f4` / 卡片 `#fff` / 边框 `#e3e3df` / 主文字 `#1f2328` / 辅助 `#5a6370` / 强调 `#4c6ef5` / 成功 `#2f9e44` / 警告 `#f08c00` / 错误 `#e03131`
- **窗口**：560×640 单实例（已存在 → show + focus）
- **交互细则**：即时生效 0.3s 提示 / 校验错误就地红框 / 升级进度弹窗 / 回滚按钮 disabled + opacity + tooltip / 开关 role=switch
- **a11y**：focus ring / aria-live（测试归 S7）

### D9 测试策略

逻辑单测（node:test）：SettingsStore 广播/校验/registry 持久化/closeToQuit 消费/autoCheck 开关消费 + UI 结构验证注记归 S7。

---

## 3. 模块划分

| 模块 | 职责 | 依赖 | 契约接口 |
|---|---|---|---|
| `settings/SettingsProvider.ts`（扩展为 SettingsStore） | get/set/on(changed) + 校验（SETTINGS_ERRORS）+ registry 字段 | — | #1~#3 |
| `renderer/settings.html` + `preload/settings.ts` | 设置页 UI（双区块/通用/诊断）+ 桥（getSettings/setSettings + 功能 IPC，250ms 轮询——B2 无事件订阅） | — | #1~#3 消费 |
| `window/SettingsWindow.ts` | 设置窗口创建/加载/生命周期（单实例） | — | — |
| `main/index.ts` | 托盘设置菜单启用 + IPC 接线 + 诊断入口（openDataDir） | SettingsStore、各功能模块 | #1~#4 |
| `tray/TrayController.ts` | 完善：dsh 运行状态 tooltip + 设置菜单启用 + 升级中禁用（S5 已有 busy） | RuntimeManager、Updater、HullUpdater、queue | #4 |

**依赖方向**（单向，无环）：`SettingsWindow → {SettingsProvider, preload}`；`main → {SettingsWindow, SettingsProvider, 各功能模块}`；`TrayController → 各状态源`。

**S6→S7 承载点**：设置页 UI 结构即 S7 Playwright 验证对象；广播/校验逻辑即 S7 端到端断言基础。

---

## 4. 关键机制实现形态

### 4.1 SettingsStore.set 校验链（D2）

```
set(patch):
  校验链（SETTINGS_ERRORS）：
    registry 存在 → URL 格式校验（new URL + http/https）→ registry-invalid
    channel=pinned → pinnedVersion 必填 + isValidVersion（S4 复用）→ version-invalid
    channel=latest → 清 pinnedVersion（S4 B4 语义保持）
  原子写 settings.json（temp+rename，S4 B5）→ 写失败 → persist-failed（内存丢弃 + get 恒读磁盘）
  成功 → emit('changed', 全量 settings)（广播）
```

### 4.2 on(changed) 广播与即时生效（B3 表述修正）

```
即时生效 = 消费方动态读（已实现，非广播驱动）：
  WindowManager：closeToQuit 每次 close 读（S1 isCloseToQuit 动态读 ✓）
  Updater/HullUpdater：autoCheckDsh/autoCheckHull 每次启动自动检查读（S3/S5 消费点动态读机制已实现；**autoCheckDsh/autoCheckHull 门控接线归 S6 实现波，B4**）
  npmRunner/registry：registry 每次安装/检查读（B7：settings.registry 优先 + env 兜底，代码归实现波）
广播 = 契约 #3 SettingsStore.on(changed) main 侧接口预留（当前无订阅者；S6 实现接口，消费方仍走动态读）
```

### 4.3 设置窗口生命周期（D1 + B5 迁移落点）

```
打开（托盘菜单/重复触发）：
  已存在 → show + focus（单实例）
  不存在 → new BrowserWindow（contextIsolation+sandbox，partition 'settings'，settings preload 直挂）→ loadFile settings.html
关闭：默认销毁（设置页非主窗口，无托盘隐藏语义）

B5 schemaVersion 迁移逻辑（设置页首次运行检测）：
  settings.schemaVersion < 3 → 1→2→3 字段补齐（channel/pinnedVersion/autoCheckDsh/autoCheckHull/registry 缺省补默认）
  损坏文件 → 告警 + 默认值 + 备份（S2 M11 先例：损坏不覆盖，备份原文件）
```

### 4.4 双区块状态订阅（D3/D4 + B8/B10 修订）

```
设置页渲染数据源：
  dsh 区块：OverlayManager.currentVersion + RuntimeManager on(status) + Updater on(status) + ChannelService.get/listVersions
  Hull 区块：app.getVersion + HullUpdater on(status)
  经 preload 桥（hull:getSettings + 各状态 IPC）→ 页面 250ms 轮询渲染（B2，不透传回调不变式）

B8 双入口并发注记：托盘 + 设置页 check 并发 → queue-busy 提示（接受 + UI 处理——设置页内嵌提示）
B10 失败提示位置定稿：升级/回滚结果在弹窗内；设置校验错误在卡片内就地（红框 + 提示）
```

---

## 5. 工程基线

**判级**：复杂+安全敏感（与头部一致）。

| 项 | 现状 | S6 动作 |
|---|---|---|
| git | 已有 | 直接复用 |
| 脚手架 | S1~S5 完成（TS + Electron 43 + tsc 构建） | 跟随；**零新依赖**（UI 原生 HTML/CSS/JS，不引框架，YAGNI） |
| 测试框架 | node:test（201 用例） | 沿用；新增 SettingsStore 逻辑单测；UI 端到端归 S7（⛔️ 偏离 2） |
| 脚本 | build/typecheck/test/dev | 无新增 |

**S1~S5 复用清单**：SettingsProvider 读写（S4，扩展 on(changed)）、WindowManager 安全 webPreferences（S1）、preload 桥模式（S1/S2，不透传回调）、ChannelService（S4）、Updater/HullUpdater 状态（S3/S5）、TrayController busy 禁用（S5）、temp+rename 原子写（S1 §5.1）。

---

## 6. 目录/工程结构（新增部分）

```
dsh-hull-desktop/
├── src/
│   ├── renderer/
│   │   └── settings.html          # 设置页 UI（双区块/通用/诊断，原生 HTML/CSS/JS）
│   ├── preload/
│   │   └── settings.ts            # 设置页桥（getSettings/setSettings + 功能 IPC，250ms 轮询）
│   ├── window/
│   │   └── SettingsWindow.ts      # 设置窗口（单实例 + 生命周期）
│   ├── settings/SettingsProvider.ts  # 扩展：on(changed) + registry 字段 + 校验
│   ├── main/index.ts              # 托盘设置菜单启用 + IPC 接线 + openDataDir
│   └── tray/TrayController.ts     # 完善：dsh 状态 tooltip + 设置菜单启用
```

---

## 7. 风险与对策

| 风险 | 影响 | 对策 | 归属 |
|---|---|---|---|
| registry 字段裁决（S4 env vs S6 settings） | 变更传播冲突 | D2 倾向落地 settings.json 字段（契约 schema 明确 + T6-05 验收），S2 偏离 3 修订（settings 优先 + env 兜底）——**标注评审裁** | S6/S4/S2 |
| 设置页与官方 UI 隔离 | 注入边界 | 独立窗口 + 独立 settings preload（官方 UI 不挂 preload，S1 零注入保持） | S6 |
| 广播风暴（set 高频） | 消费方抖动 | 设置页低频操作（用户手动改）可接受；on(changed) 全量广播 + 消费方幂等 | S6 |
| closeToQuit 即时生效 | 关窗口行为 | WindowManager isCloseToQuit 每次 close 动态读（S1 已实现）✓ | S6 |
| autoCheck 开关即时生效 | 自动检查行为 | Updater/HullUpdater isAutoCheckEnabled 每次启动自动检查动态读（S3/S5 已实现）✓ | S6 |
| 设置窗口单实例 | 重复窗口 | D1 单实例（已存在 → show + focus） | S6 |
| UI 验证归 S7 | S6 验收缺口 | ⛔️ 偏离 2：S6 交付逻辑单测 + 设置页结构，端到端 UI 验证 S7（Playwright） | S6/S7 |

---

## 8. 契约/共识对照与偏离标注

| # | 偏离点 | 契约/共识原文 | 设计取值 | 理由 |
|---|---|---|---|---|
| 1 | registry 字段落地 settings.json（设计保留标注，评审裁） | S4 曾裁 env 承载（HULL_REGISTRY，settings schema 冻结面不动）；S6 契约 schema 明确 registry 字段（默认官方）+ T6-05 校验 | 落地 settings.json 字段：npmRunner/registry.ts 读取顺序改 **settings.registry 优先 + HULL_REGISTRY env 兜底**（S2 偏离 3 修订）；校验 registry-invalid | S6 契约 schema 明确字段 + T6-05 验收要求字段持久化（改 registry + 重启保留）；S4 的 env 承载为「settings 冻结面」约束下的过渡方案，S6 打开写面后修订——变更传播登记（S4 注记 + S2 偏离 3） |
| 2 | UI 验证归 S7（设计保留标注） | 契约 T6 场景含 UI 交互验收 | S6 交付逻辑单测（SettingsStore 广播/校验/持久化）+ 设置页结构；端到端 UI 验证（Playwright）归 S7 | S7 契约含测试框架（Playwright）；S6 不重复建 UI 测试设施（YAGNI），验收口径随 S7 落地 |

**变更传播登记**：
- S4 registry 裁决修订（D2/⛔️ 偏离 1）——S4 契约注记 + SettingsProvider 代码扩展
- S2 偏离 3 修订（npmRunner/registry.ts 读 settings.registry 优先 + env 兜底）——**S2 契约偏离 3 修订注记 + S2 设计偏离 3 行修订**（P3 措辞：实际改 S2 设计行 + 本波补 S2 契约注记）+ 代码读取顺序调整
- S1 closeToQuit 消费确认（WindowManager 动态读已实现，S6 仅 UI 接线）
- S3 autoCheckDsh 消费（maybeAutoCheck 门控已实现，S6 仅 UI 接线）
- S5 autoCheckHull UI + HullUpdater 状态展示（IPC 已预留，S6 接线）

**非偏离的契约忠实点**：双区块（dsh/Hull 各自版本+检查+开关）；通用设置（registry/closeToQuit/autoCheckDsh）；诊断（日志/数据目录）；托盘完整（状态/入口/升级中禁用）；closeToQuit 默认隐藏（false 可改）；registry 任意源（CON-R013）；SETTINGS_ERRORS 三码；settings.json 持久化 + 广播即时生效。

**T6 场景 → 设计落点**：T6-01 §4.1（registry 持久化 + 重启保留——settings.json 字段落地）；T6-02 §4.4（双区块独立检查/进度——Updater/HullUpdater 状态订阅）；T6-03 §4.2（closeToQuit 开关 → WindowManager 动态读）；T6-04 §4.4/D7（升级中禁用——queue.inFlight 数据源，S5 已实现）；T6-05 §4.1（registry 校验 → registry-invalid 输入框提示）；T6-06 §4.4/D6（打开日志目录——S1 hull:openLogs 已有 + openDataDir 新增）。
