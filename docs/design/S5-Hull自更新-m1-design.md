# S5 Hull 自更新 技术方案

> 工作项：S5 Hull 自更新（飞书 dsh-hull-desktop 清单）
> 状态：已冻结（多方复评通过，2026-08-17）
> 版本：0.2 · 2026-08-17
> 事实源：契约 `docs/api/feishu-s5-m1-api-contract.md` v0.2（已冻结）；共识 `docs/spec/共识-Hull桌面壳-M1.md` v1.4（CON-R003/009/012、Q-008/Q-012）；S3 设计 0.2（UpgradeQueue 复用面 + Updater 状态机模式）；S1 设计 0.2（退出编排双 flag + RuntimeManager.stop）；S2 设计 0.2（打包专项/extractNode 接线遗留）
> 判级：复杂+安全敏感。理由：自更新=安装软件安全面（Gatekeeper/下载校验）+ 双通道互斥（UpgradeQueue 复用）+ 退出编排交互（quitAndInstall vs S1 双 flag）+ GitHub Releases 外部集成 + CI 发布链
> 偏离契约/共识处统一标注：⛔️ 见 §8 对照表

---

## 1. 背景与范围

**定位**：Hull 壳自更新——electron-updater 接入（GitHub provider，latest-mac.yml）+ 检查/下载/重启安装（重启前停 dsh）+ 自动检查开关 + 失败提示 + 与 dsh 升级互斥（UpgradeQueue 复用）+ Gatekeeper 引导 + CI release.yml。

**规则绑定**：CON-R003（双升级通道独立：dsh〔npm overlay〕与 Hull〔electron-updater〕互不阻塞）、CON-R009（升级触发可配置 + 应用前必须用户确认 + 稍后再说当日不再提示）、CON-R012（双通道互斥单槽）、Q-008（稍后再说当日不重复）、Q-012（**无「稍后重启」选项**——确认即执行，延迟由确认框「稍后再说」覆盖）。

**范围**（契约 §范围，冻结）：electron-updater 接入（GitHub provider）；检查/下载/重启安装（重启前先停 dsh 子进程）；自动检查开关（默认开）+ 手动检查；失败提示（可重新点击）；与 dsh 升级互斥（复用 S3 UpgradeQueue）；无公证：更新后启动被 Gatekeeper 拦时弹窗引导放行；CI：release.yml（build → electron-builder → 发布 GitHub Releases）。

**非目标**（契约 §非目标）：Apple 公证/签名（后续里程碑）；dsh 升级（S3）；Windows/Linux 打包（后续）。

**交付验收**：T5-01（Releases 发 0.2.0 → 检查提示含变更说明）、T5-02（完整更新：版本变化 + dsh 数据无损）、T5-03（dsh 升级中触发 Hull → 入口禁用/提示）、T5-04（断网下载 → 按钮下方提示 + 重试成功）、T5-05（未公证包安装 → Gatekeeper 引导提示）、T5-06（自动检查关闭后启动 → 无网络检查请求）。

**跨 S 协同点**（本设计必列，§8 登记）：
- ① **S2 打包专项缺口**（extractNode 接线 + fetch-node 产物内嵌）：S5 需要 electron-builder 打包产物（latest-mac.yml/dmg/zip）→ 打包配置落地归属（S5 内 vs 打包专项）——D8 裁决点 a/b，标注让评审裁
- ② **S1 退出编排交互**：quitAndInstall vs S1 双 flag（quitting/quitProceeding）——D5
- ③ **S4 settings schema 再扩展**（autoCheckHull）——D7，⛔️ 偏离 2

**范围剪裁说明（YAGNI）**：公证/签名不预做（契约非目标）；Windows/Linux 打包不预做；electron-updater 真实行为不可测 → DI 抽象 + 集成测试标注（D2/D9）；Gatekeeper 引导文案先行（dialog，S6 设置页不涉及）。

---

## 2. 架构决策（含备选）

### D1 模块位置

- **A**：`src/updater/HullUpdater.ts`（更新域收敛）
- **B**：`src/hull-updater/` 独立 → **选 A**

理由：与 `Updater.ts`（dsh 升级）同域——更新编排；UpgradeQueue 同目录引用（S3 单槽互斥）；S6 设置页单入口消费（一个 updater 域，两个 Updater 实例）。

### D2 electron-updater 抽象（B4 修正）

DI 注入 `ElectronUpdaterAdapter` 接口（checkForUpdates/downloadUpdate/quitAndInstall/on 事件透传）——单测 mock，不真调 electron-updater（需打包环境）；**electron-updater 是契约明确要求的库**（S1~S4 零新依赖纪律让位于冻结契约决策，注记）；**dependencies 引入（B4：devDependency 致生产包缺模块）**。

```
interface ElectronUpdaterAdapter {
  checkForUpdates(): Promise<UpdateInfo | null>          // { version, releaseNotes?, releaseDate? }
  downloadUpdate(): Promise<void>
  quitAndInstall(): void
  on(event: 'download-progress', cb: (p: { percent: number }) => void): void
  on(event: 'error', cb: (err: Error) => void): void
}
```

### D3 状态机（6 态 + restart-prompt 枚举注记）

复用 S1~S4 模式（EventEmitter + TRANSITIONS 迁移表 + snapshot 深拷贝）。**6 态照契约 §状态转换**：idle/checking/confirm/downloading/restarting/done + 冲突行为（升级中再次检查忽略）；`HullUpdateStatus.phase` 枚举按契约 schema 含 `restart-prompt`（7 值）——**注记**：契约枚举含 restart-prompt 但状态转换表 6 行（Q-012 无「稍后重启」：downloading → restarting 自动），restart-prompt 保留为枚举字段供 S6 UI 渲染态，S5 状态机不迁移到它。

- 迁移表：idle→checking；checking→confirm/idle；confirm→downloading/idle（稍后再说）；downloading→restarting（Q-012 自动）/idle（下载失败/取消）；restarting→done；done→idle（重启后新实例启动即 done 语义——重启前终态）
- Q-012 确认即执行；延迟由确认框「稍后再说」覆盖——**Q-008 当日不重复复用 S3 DismissStore**（Hull 通道独立 dismiss 键？——同文件同键：dismiss 语义是「今日不提示任何更新」跨通道共享，注记：与 dsh 通道共用 dismissToday 当日去重，S6 复核）

### D4 互斥（B2 修正）

**check/download/installAndRestart 全占槽 + 单次 acquire 连续持有至终态**——与 S3 Updater 同语义（实证：S3 `Updater.ts` check 自身 scope 内 acquire/release〔gamma 裁决〕，check 实占槽；「查询不占槽」为 S5 初稿引据错误，修正）。冲突行为：dsh 升级进行中 Hull 全流程 → queue-busy 入口禁用（T5-03，S6 UI 数据源：queue.inFlight()）。**S3-m1-record「check 占互斥槽待 S5 复核」空窗闭环义务随本波履行（B9）**：S3 check 占槽语义确认为契约行为，S5 全流程占槽同族，S5 实现时对 S3 Updater 无改动。

### D5 退出编排交互（重点）

```
installAndRestart():
  queue.acquire('hull')（失败 → queue-busy，T5-03）
  try:
    RuntimeManager.stop()（停 dsh 防孤儿——契约「重启前必须先停 dsh」；失败 → idle + install-failed，B3）
    quitAndInstallMode = true            # S1 双 flag 衔接标志
    adapter.quitAndInstall()             # 内部 app.quit()
  finally:
    queue.release('hull')

before-quit handler 衔接（S1 🟡-A 双 flag 之上）：
  if (quitAndInstallMode) return;        # 放行默认退出（不 preventDefault 不启动编排）
  if (quitProceeding) return;
  e.preventDefault();
  if (!quitting) void quitOrchestration();
```

**注记**：quitAndInstallMode 为自更新专用标志——正常退出路径（quitting/quitProceeding 双 flag）完全不受影响；quitAndInstallMode 在 quitAndInstall 调用前置位、进程退出即失效（无需复位）。回归面：S1 退出编排双 flag 测试全量回归 + 新增 quitAndInstallMode 放行路径（electron 集成标注）。

### D6 Gatekeeper 预防性提示（B1 修订：删 flag 机制）

**删「安装后检测/flag」机制**（壳无法自检被拦——进程起不来，flag 检测不成立）。改**安装前预防性提示**：
- 更新确认（confirm）与下载完成（downloading→restarting）时弹 dialog，文案覆盖两失败模式：① 隔离/未公证 → 右键 → 打开 ② 签名损坏 → 重新下载安装包
- README 新增引导章节（同文案）
- T5-05 落点 = 预防性提示（契约 A2 口径同步）；`pendingInstall.flag` 相关描述全部删除

### D6b cancel()（B6）

`HullUpdater.cancel()`：**仅 downloading 阶段可取消**——CancellationToken 接线（adapter.downloadUpdate(token)）；installAndRestart 阶段不可取消（停 dsh + quitAndInstall 一旦开始即执行完）；UI 取消入口归 S6 设置页（契约 #5）。

### D7 自动检查开关

settings.json 扩展 `autoCheckHull`（默认 true）+ **同批扩展 `autoCheckDsh`（S3 启动自动检查开关注记落地——默认 true 行为零变化）**：S4 schema 再扩展（⛔️ 偏离 2 变更传播注记；**schemaVersion 定 3**——S4 扩展波 channel/pinnedVersion + S5 两字段 = 最终版本号 3，单次迁移，S6 迁移以 3 为判据）；SettingsProvider 读路径兼容旧文件；S6 设置页 UI 接线；启动自动检查（Hull）在 whenReady 后 + **DismissStore 分通道当日去重**（T5-06：关闭开关 → 无网络检查请求）。

### D8 CI 发布链（跨 S 协同裁决点——B5 定案 a）

`electron-builder.yml` 最小配置（appId/productName/mac targets zip+dmg/publish GitHub provider）+ `.github/workflows/release.yml`（build → electron-builder → GitHub Releases，GH_TOKEN secrets 已配置——契约协调事项已就绪）。

**S2 extractNode 接线 + fetch-node 产物内嵌（B5 定案 a）**：
- **electron-builder.yml `extraResources`**：node 归档（`vendor/node-*`）打进产物
- **runtime seam**：复用 S2 `InstallFlow.extractNode` 注入点（打包产物内嵌 → 解压 `<userData>/node/`；dev 无内嵌 → PATH 兜底）
- **T2-06 关联验收注记**：捆绑 Node 版本检查（fetch-node 锁定小版本）随 S5 打包产物验收一并落地
- 一次落地（避免两处打包配置漂移）；S2 打包专项取消（S2-m1-record C3 关闭，见 Tier 2）

### D8b DismissStore 双键（B7）

```
dismiss.json 双键子句：{ dsh?: 'YYYY-MM-DD', hull?: 'YYYY-MM-DD' }
dismissToday(channel: 'dsh' | 'hull') / isDismissedToday(channel)
旧单键读兼容：{ date } 视作 dsh 侧（对齐 S3 实际实现字段名；迁移读兼容，不覆盖原文件）
方法签名变更 + S3 调用点传 'dsh' —— 代码实现归 S5 实现波（本波仅文档注记）
```

### D9 测试策略

- 单测（node:test）：状态机迁移/冲突行为、互斥（queue-busy）、错误映射（HULL_UPDATE_ERRORS 五码）、DI mock adapter（check/download/quitAndInstall/事件透传/CancellationToken）、预防性提示触发点、autoCheckHull/autoCheckDsh 读（SettingsProvider 扩展回归）
- electron-updater 真实调用集成测试标注「待打包环境 + electron 二进制」
- release.yml 语法验证（actionlint 或注记——CI 生效后由 workflow 运行验证）

### D10 小项落稿（B8）

- `currentVersion = app.getVersion()`（HullUpdateStatus 数据源）
- **下载中退出 = 自然中断**（进程退出即下载终止；下次启动状态机从 idle 起，无残留态注记）
- **双通道并发确认框 = 接受**（两确认框可同时弹出——互斥只约束 installAndRestart/upgrade 执行段；S6 UI 排队展示注记）
- `quitAndInstallMode` 以 getter/hook 暴露（before-quit 衔接点，实现细节——S1 双 flag 零改动）

---

## 3. 模块划分

| 模块 | 职责 | 依赖 | 契约接口 |
|---|---|---|---|
| `updater/HullUpdater.ts` | 6 态状态机 + check/download/installAndRestart + on(status) + Gatekeeper 预防性提示 + quitAndInstallMode 衔接 | ElectronUpdaterAdapter、UpgradeQueue、RuntimeManager、DismissStore、SettingsProvider、Logger | #1~#4 |
| `updater/electronUpdaterAdapter.ts` | electron-updater 封装（DI 注入点：checkForUpdates/downloadUpdate/quitAndInstall/on） | electron-updater | #1~#3 支撑 |
| `electron-builder.yml` + `.github/workflows/release.yml` | 发布链（zip+dmg + GitHub Releases） | — | #5 |
| `settings/SettingsProvider.ts` | 扩展 autoCheckHull（S4 schema 再扩展） | — | 变更传播 |
| `main/index.ts` | 启动自动检查（Hull）+ Gatekeeper 预防性提示 dialog + quitAndInstallMode before-quit 衔接 | HullUpdater | #1~#4 消费 |

**依赖方向**（单向，无环）：`HullUpdater → {ElectronUpdaterAdapter, UpgradeQueue, RuntimeManager, DismissStore, SettingsProvider}`；`main → HullUpdater`；与 S3 `Updater`（dsh 域）平行无依赖（仅共享 UpgradeQueue/DismissStore/SettingsProvider）。

**S5→S6 承载点**：HullUpdater 状态事件 = 设置页 Hull 更新区数据源；autoCheckHull 开关 UI；失败提示按钮下方（S6 渲染）；queue-busy 入口禁用态（queue.inFlight()）。

---

## 4. 关键机制实现形态

### 4.1 installAndRestart 全链路伪码（D5 + B3 修订）

```
installAndRestart():
  queue.acquire('hull') 或 throw queue-busy（T5-03）
  try:
    phase = restarting
    try:
      await runtime.stop()                    # 停 dsh 防孤儿（契约：重启前必须先停）
    catch err:
      phase = idle; error = install-failed    # B3：stop 失败 → 中止，不调 quitAndInstall
      throw HullError(install-failed, ...)
    adapter.quitAndInstall()                  # 内部 app.quit() → before-quit 放行
  finally:
    queue.release('hull')
```

### 4.2 quitAndInstallMode 与 S1 双 flag 交互时序（文字图）

```
正常退出：quitOrchestration（quitting=true → stop → 500ms → quitProceeding=true → app.quit）
自更新退出：quitAndInstallMode=true → before-quit 首行放行（return）→ app 默认退出流程
  —— 不 preventDefault、不启动 quitOrchestration（dsh 已在 installAndRestart 内 stop 过）
二次触发竞态：quitAndInstallMode 前置期间用户再触发退出 → before-quit 仍放行（自更新主导，语义正确）
```

### 4.3 预防性提示生命周期（D6，B1 修订）

```
确认（confirm）/下载完成（downloading→restarting）时弹 dialog：
  ① 隔离/未公证 → 「若更新后无法打开：右键 → 打开」
  ② 签名损坏 → 「若仍无法打开请重新下载安装包」
README 引导章节同步（同文案）
无 flag 写入/读取/删除（B1：删 pendingInstall.flag 机制）
```

### 4.4 错误映射表（HULL_UPDATE_ERRORS 五码）

| 语义错误码 | 触发条件 | 事件/UI | 可重试 |
|---|---|---|---|
| check-failed | Releases 检查失败（网络/非 2xx） | status.error + 提示稍后重试 | 是 |
| download-failed | 下载失败/中断 | 按钮下方提示，可重新点击（T5-04） | 是 |
| install-failed | quitAndInstall 前置失败（stop 失败等） | 按钮下方提示 | 是 |
| gatekeeper-blocked | 无公证更新（预防性提示） | 提示（右键打开/重下载引导） | 否 |
| queue-busy | dsh 升级进行中 | 入口禁用/提示（T5-03） | 是 |

### 4.5 状态机迁移表 + 冲突行为（D3）

```
TRANSITIONS:
  idle → [checking]
  checking → [confirm, idle]        # 无新版/失败 → idle
  confirm → [downloading, idle]     # 确认 → 下载；稍后再说 → idle（DismissStore 当日去重）
  downloading → [restarting, idle]  # Q-012：下载完成自动重启；下载失败/取消 → idle
  restarting → [done]
  done → [idle]                     # 重启前终态（重启后新实例从 idle 起）
冲突：升级中（非 idle）再次 check → 忽略；check/download/installAndRestart 全占槽 + 单次 acquire 连续持有至终态（D4/B2）；queue-busy → 入口禁用
```

---

## 5. 工程基线

**判级**：复杂+安全敏感（与头部一致）。

| 项 | 现状 | S5 动作 |
|---|---|---|
| git | 已有 | 直接复用 |
| 脚手架 | S1~S4 完成（TS + Electron 43 + tsc 构建） | 跟随；**新依赖 electron-updater**（契约冻结决策，D2 注记——零新依赖纪律让位于冻结契约） |
| 测试框架 | node:test（179 用例） | 沿用；新增 HullUpdater 单测（DI mock adapter）+ SettingsProvider autoCheckHull 回归 |
| CI | 无 | `.github/workflows/release.yml`（build → electron-builder → Releases） |

**S1~S4 复用清单**：UpgradeQueue（S3，单槽互斥）、DismissStore（S3，Q-008 当日去重）、TRANSITIONS 迁移表模式（S1~S4）、RuntimeManager.stop()（S1，停 dsh）、退出编排双 flag（S1 🟡-A）、SettingsProvider 读写（S4，autoCheckHull 扩展）、temp+rename 原子写（S1 §5.1）。

---

## 6. 目录/工程结构（新增部分）

```
dsh-hull-desktop/
├── src/
│   ├── updater/
│   │   ├── HullUpdater.ts              # 6 态状态机 + check/download/installAndRestart（契约 #1~#4）
│   │   └── electronUpdaterAdapter.ts   # electron-updater 封装（DI 注入点）
│   ├── settings/SettingsProvider.ts    # 扩展 autoCheckHull（S4 schema 再扩展）
│   └── main/index.ts                   # 启动自动检查（Hull）+ Gatekeeper 预防性提示 + quitAndInstallMode
├── electron-builder.yml                # 打包配置（zip+dmg + GitHub provider）
└── .github/workflows/release.yml       # CI 发布链（GH_TOKEN 已配置）
```

---

## 7. 风险与对策

| 风险 | 影响 | 对策 | 归属 |
|---|---|---|---|
| electron-updater 真实行为不可测 | 单测假绿/集成炸 | DI 抽象（D2）+ 集成测试标注「待打包环境 + electron 二进制」；adapter 薄封装单点收敛 | S5 |
| Gatekeeper 预防性提示文案/路径 | 用户无法放行 | D6 预防性提示 dialog（右键打开/重下载说明）+ README 章节；正式发布前补公证（契约非目标注记） | S5 |
| quitAndInstall 与退出编排竞态 | 双重退出/孤儿 | D5 quitAndInstallMode 首行放行 + S1 双 flag 回归全量 + 集成标注 | S5 |
| 下载失败/中断 | 更新不可用 | download-failed 语义 + 重试入口（T5-04） | S5 |
| 互斥队列占用 | 与 dsh 升级冲突 | D4 全占槽 + 单次 acquire 连续持有至终态 | S5 |
| dsh 停不干净 | 孤儿 dsh | RuntimeManager.stop()（SIGTERM→5s→SIGKILL 既有）+ stop 失败 → install-failed 中止不重启 | S5 |
| release.yml 失效（GH_TOKEN 缺失） | 发布失败 | workflow 运行失败可见（CI 即验证）；契约协调事项 GH_TOKEN 已就绪注记 | S5 |
| extractNode 打包衔接（S2 遗留） | 打包产物缺 node 内嵌 | D8 裁决点 a/b（倾向 a：S5 内一次落地），评审裁 | S5/S2 |

---

## 8. 契约/共识对照与偏离标注

| # | 偏离点 | 契约/共识原文 | 设计取值 | 理由 |
|---|---|---|---|---|
| 1 | UI 载体归 S6（设计保留标注） | 契约失败提示「按钮下方」、自动检查开关调用方=设置页 | S5 交付 main 侧 HullUpdater 接口 + 状态事件 + **Gatekeeper 引导 dialog 先行**；失败提示/开关 UI 归 S6 设置页接线 | 设置页内容归 S6（S3/S4 同款处置）；S5 先落接口与关键引导（Gatekeeper 无 UI 即不可用） |
| 2 | settings schema 再扩展 autoCheckHull（变更传播） | S4 契约 v0.2 schema（channel/pinnedVersion） | SettingsProvider 扩展 autoCheckHull（默认 true，读路径兼容旧文件）；S4 schema 变更传播续（S4 契约修订 + 代码扩展） | 自动检查开关须持久化（契约 S5 范围）；SettingsProvider 读写面已由 S4 打开 |

**跨 S 协同登记**：
- S2 extractNode 打包衔接：**D8 定案 a**（S5 内一次落地：electron-builder.yml extraResources + runtime seam 复用 S2 extractNode 注入点）；fetch-node 产物（vendor/node-*）内嵌进打包产物；T2-06 关联验收注记
- S1 退出编排交互：D5 quitAndInstallMode 衔接——S1 双 flag 零改动（before-quit 首行新增自更新放行分支），回归面 = S1 退出测试全量
- S4 schema 扩展续：autoCheckDsh/autoCheckHull 同批（D7，schemaVersion 定 3）——S4 契约修订 + SettingsProvider 代码扩展（实现归 S5 波）
- S3 DismissStore 分通道键（D8b）——S3 调用点传 'dsh'（代码归实现波）；S3-m1-record「check 占槽待复核」空窗闭环义务随本波履行（B2/B9）

**非偏离的契约忠实点**：6 态迁移表（契约 §状态转换）；Q-012 无「稍后重启」（downloading→restarting 自动，延迟由「稍后再说」覆盖）；Q-008 当日不重复（DismissStore 复用，dsh/Hull 共享当日去重注记）；UpgradeQueue 互斥（installAndRestart 前置 acquire，T5-03）；Gatekeeper 预防性提示（D6 dialog + README）；CI release.yml（#5，GH_TOKEN 已配置）；HULL_UPDATE_ERRORS 五码；HullUpdateStatus schema（含 restart-prompt 枚举值——状态机 6 态不迁移到它，注记）。

**T5 场景 → 设计落点**：T5-01 §4.5（check → confirm，含变更说明——adapter checkForUpdates 透传 releaseNotes，缺失降级纯版本对比）；T5-02 §4.1（installAndRestart 全链路，dsh 数据无损 = 壳升级不触碰 userData/dsh）；T5-03 §4.4（queue-busy 入口禁用）；T5-04 §4.4（download-failed + 重试）；T5-05 §4.3/D6（**预防性提示**——确认/下载完成 dialog + README 引导，契约 A2 口径）；T5-06 §4.5/D7（autoCheckHull=false → 无网络检查请求）。
