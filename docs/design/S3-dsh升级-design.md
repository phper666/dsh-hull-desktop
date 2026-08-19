# S3 dsh 升级编排 技术方案

> 工作项：S3 dsh 升级编排（飞书 dsh-hull-desktop 清单）
> 状态：已冻结（多方复评通过，2026-08-17）
> 版本：0.2 · 2026-08-17
> 事实源：契约 `docs/api/feishu-s3-api-contract.md` v0.2（已冻结）；共识 `docs/spec/共识-Hull桌面壳-M1.md` v1.4（CON-R005/009/012/014、Q-003/004/008/010）；S2 设计 0.2 + 契约 v0.3（冻结 2026-08-17，复用面 OverlayManager/InstallFlow/swapBack）；S1 设计 0.2（冻结 2026-08-16，复用面 RuntimeManager/ReadinessProbe）；`docs/records/S2-record.md`（S3 侧 P3 对齐项登记）
> 判级：复杂+安全敏感。理由：7 态升级状态机 + 跨模块编排（Updater/SwapManager/UpgradeQueue ↔ S2 OverlayManager/S1 RuntimeManager）+ 自动回滚 + 崩溃恢复 + 双通道互斥 + 外部系统 registry 检查
> 偏离契约/共识处统一标注：⛔️ 见 §8 对照表

---

## 1. 背景与范围

**定位**：dsh 升级编排——检查 → 确认 → 安装 → 替换 → 验证 → 回滚全链路；崩溃残留恢复（Q-004 已落 S2 ensure，S3 复用）；自动回滚（验证失败）；手动回滚（设置页按钮，S3 交付 main 接口）；失败提示；当日不重复（Q-008）；双通道互斥（S5 复用 UpgradeQueue）。

**规则绑定**：CON-R005（升级原子性 staging→替换→就绪验证→失败自动回滚）、CON-R009（升级触发可配置 + 应用前必须用户确认 + 稍后再说当日不再提示）、CON-R012（dsh/Hull 双通道互斥单槽）、CON-R014（启动残留检测恢复，Q-004）、Q-003（确认后立即升级，无排队无会话状态桥）。

**范围**（契约 §范围，冻结）：升级状态机（checking→confirm→installing→swapping→verifying→rollback）；staging 安装（可取消）；原子替换（dsh→previous，staging→dsh）；崩溃残留检测恢复；自动/手动回滚；失败提示 + 当日不重复；双通道互斥队列（S5 复用）；确认后立即升级。

**非目标**（契约 §非目标）：版本通道（S4）、Hull 自更新（S5，仅复用互斥队列）、首次安装（S2，复用 OverlayManager.install）。

**交付验收**：T3-01（正常升级版本变化+数据无损）、T3-02（坏版本注入→验证失败→自动回滚→可用）、T3-03（替换两步间 kill 壳→重启残留自愈）、T3-04（installing 中取消→原版本保留+staging 清理）、T3-05（install-failed 注入→按钮下方提示→重试成功）、T3-06（稍后再说当日不提示，次日提示）、T3-07（dsh 升级中 Hull 检查入口禁用/提示）。

**S2 record 登记的 S3 侧 P3 对齐项（本设计逐项落位）**：
- P3-① S2 #9 `OverlayManager.swap()` 与 S3 #6 `SwapManager.swap()` 承接方式 → D2 薄封装
- P3-② swap 错误码域跨契约映射（S2 npm-install-failed/cancelled vs S3 install-failed/swap-broken）→ D2/§4.3
- P3-③ S3 `Updater.rollback()` 反向操作承载 → D6/D7 rollbackSwap 原语
- P3-④ 态 2 续替后 verify/rollback 段（S3 契约空白）→ D10 补注：ensure 态2/态3 恢复后直接 ready，不重复 verify
- ⑤ 🟢-B 回滚成功但 UI 报 failed 语义 → D6 语义区分（回滚成功 = 可用态提示，非失败）
- ⑥ W3 手动回滚按钮可用条件 → D7 previous 存在检查（禁用态归 S6 设置页）

**范围剪裁说明（YAGNI）**：版本比较手写最小 semver（D4，不引依赖）；升级进度不推送事件流（托盘 tooltip + 状态快照轮询，复用 S1 模式）；设置页 UI 归 S6（S3 交付 main 接口 + 托盘入口 + 原生 dialog 先行，⛔️ 偏离 1/2）。

---

## 2. 架构决策（含备选）

### D1 模块位置

- **A**：`src/updater/` 与 src/overlay、src/runtime 平级
- **B**：`src/main/updater/` 内嵌 main 树 → **选 A**

理由：与 S1（runtime）、S2（overlay）平级结构一致；UpgradeQueue 被 S5 HullUpdater 复用，独立模块边界清晰；Updater 核心（状态机/registry 检查/semver）纯 Node 能力可单测，electron 仅在 main 集成层。

### D2 SwapManager 承接（P3-① + B5/B13 修订）

- **A**：更名 S2 `OverlayManager.swap()`
- **B**：**薄封装**——SwapManager 委托 `OverlayManager.swap()` + 错误码域映射 → **选 B**

理由：S2 契约 v0.2 冻结面零改动（OverlayManager.swap() 已是独立接口 #9，对齐 S3 #6 的拆分语义）。

**B13 收敛**：SwapManager = 纯映射薄层（一行委托 `return overlay.swap()`，**不承载验证/回滚决策**——决策在 Updater 状态机）；保留理由注记：契约 #6 接口兼容（S3 #6 与 S2 #9 对齐面），S5 复用面 = UpgradeQueue 而非 SwapManager。gamma 内联记升级路径（升级 = Updater → SwapManager.swap 委托 → OverlayManager，三层职责单一）。

**P3-③/B5 落位**：回滚反向原语 = **`OverlayManager.swapBack()` 新原语（S2 契约 #10，v0.3）**：
```
swapBack(): rename dsh → dsh-staging（保留现场） + rename dsh-previous → dsh
```
**非复用 S2 既有 rollbackSwap**——S2-record 🟢-A 澄清：S2 的 rollbackSwap 是「替换失败即时回滚 + 清 staging」，语义与 swapBack（保留现场、供手动/自动回滚多次操作）相反；swapBack 为独立 public 原语（S2 契约 #10），S2 内部序列不动。

### D3 状态机（7 态）

- **A**：xstate 等状态机库
- **B**：EventEmitter 子类 + TRANSITIONS 迁移表（复用 S1/S2 模式）→ **选 B**

7 态（idle/checking/confirm/installing/swapping/verifying/rollback）+ 迁移表照契约（idle→checking；checking→confirm/idle；confirm→installing/idle；installing→swapping/idle；swapping→verifying/idle；verifying→idle/rollback；rollback→idle）+ `on('status')` + `UpgradeStatus` snapshot（phase/currentVersion/targetVersion/error/pct）+ 冲突行为：升级中再次 check → 忽略 + 提示「升级进行中」（queue 单槽天然拦截）。`UpgradeStatus` 深拷贝（S1 模式）。

### D4 check() 实现

- **A**：走 npmRunner spawn `npm view`
- **B**：**HTTP GET registry JSON**（`<registry>/@deepseek-ai/dsh/latest`，HULL_REGISTRY env 可配，超时注入）→ **选 B**

理由：无子进程开销；registry JSON 元数据接口稳定（`dist-tags.latest`）；与 S2 npmRunner 职责分离（npmRunner = 安装执行，registry.ts = 查询）。**版本比较：手写最小 semver compare（~40 行纯函数，prerelease 感知，不引依赖）**——dsh 用 rc 版本（共识 §8 实测 latest = 0.1.0-rc.6），契约已标注 prerelease 感知；参考社区实现 myYangyunfan/updater.js 的序数比较规则（0.1.0-rc.6 < 0.1.0-rc.7 < 0.1.0）。

### D5 upgrade() 编排

```
upgrade(target):
  queue.acquire('dsh')（失败 → queue-busy，T3-07）
  try:
    phase = installing（OverlayManager.install(target)，可取消 T3-04）
    phase = swapping → RuntimeManager.stop()（停子进程，S1 既有）
    → SwapManager.swap()（委托 S2 swap 序列）
    → RuntimeManager.start() + phase = verifying
       （ReadinessProbe 复用：就绪行+HTTP 探测；Q-010 注入坏地址 → T3-02）
    → 成功 → phase = idle（版本号变化，T3-01）
    → verify 失败 → 自动 rollback（D6）
  finally:
    queue.release()（try/finally 防泄漏）
```

### D6 自动回滚

verifying 失败（start() reject，B2 合并语义）→ rollback：
```
rollback():
  phase = rollback
  previous 存在 → delete HULL_PROBE_TARGET（B3）→ OverlayManager.swapBack()（#10：dsh→staging 保留现场 + previous→dsh）
    → RuntimeManager.start() 恢复启动 → phase = idle（🟢-B/B6：UI 显示「已回滚，原版本可用」，非失败提示；
      currentVersion 回写 previous 版本号，B11）
  previous 缺失（首装后首次升级异常）→ 告警 + 保留现场 + error 语义（verify-failed 但无可回滚素材）
```

**P3-③ 落位**：回滚反向操作承载 = S2 契约 #10 `swapBack()`（B5 定义，见 D2），SwapManager 薄封装暴露。

### D7 手动回滚（W3 / P3-⑥ + B4 修订）

`Updater.rollback()`（设置页按钮；S3 先行托盘/dialog 形态）：入口检查 `previous` 目录存在（canRollback()）——无则返回错误语义 `rollback-unavailable`（内部码，UI 映射为禁用/不可用提示）；有则走 **ready 态三步**（B4）：
```
runtime.stop() → OverlayManager.swapBack()（#10）→ runtime.start()
```
**rollback 中途失败语义（B4 补）**：stop 失败 → 告警 + 保持原状（升级态 error 语义，不强制回滚）；swapBack 失败 → 保留现场 + rollback-unavailable 语义；start 失败 → 原版本已就位但启动失败 → S1 failed 态占位页重试（不再次回滚——previous 已被消耗）。
设置页按钮禁用态（W3 可用条件）归 S6 落 UI——S3 交付 `canRollback()` 查询接口（previous 存在性），S6 绑定按钮 disabled。⛔️ 偏离 1 见 §8。

### D8 互斥队列（UpgradeQueue）

- **A**：文件锁/跨进程锁
- **B**：in-memory 单槽锁 → **选 B**

`acquire(channel)` 单槽（dsh/Hull 互斥，S5 复用）：in-memory 标志 + 当前 channel 记录 + `inFlight()` 查询 + `release()`（try/finally 防泄漏——升级/检查路径统一 finally release）；acquire 失败 → `queue-busy` 语义（T3-07：Hull 检查入口禁用/提示）。in-memory 足够：单实例进程内互斥（S1 D4 单实例锁保证仅一个壳进程）。

### D9 DismissStore（当日不重复）

`稍后再说` → 写 `<userData>/dismiss.json`（`{ "date": "2026-08-17" }` 单键，**不动 settings.json schema**——S1 冻结面，与 S2 registry env 化同族）；启动自动检查前读：当日有记录 → 跳过自动提示（手动检查不受限，T3-06）；次日/无记录 → 正常检查。读损坏（JSON.parse 失败）→ 默认无记录（无害降级，不覆盖原文件——S1 settings 损坏处理同款）。日期比较用本地日期 YYYY-MM-DD。

> 注记（S5 变更传播）：**分通道键扩展** `{ dsh?, hull? }`——dsh 通道 `dismissToday('dsh')`/`isDismissedToday('dsh')`，旧单键 `{ dismissedDate }` 读兼容视作 dsh 侧；`autoCheckDsh` 开关读取落地（默认 true 行为零变化，S6 设置页接线）。代码归 S5 实现波。

### D10 verifying 复用（P3-④ 补注 + B2/B3 修订）

verify **合并进 RuntimeManager.start()**（B2：start() 内部 ReadinessProbe 即就绪行+HTTP 探测，无独立 probe 段——S1 既有语义）；`HULL_PROBE_TARGET` 注入生命周期（B3）= **verify 段（探测坏地址 → start() reject → T3-02）与回滚恢复段（注入清除 → 正常就绪）各一次**，回滚恢复 start() 前 `delete process.env.HULL_PROBE_TARGET`。verify 只针对本会话 upgrade——S2 ensure 态2/态3 恢复路径已返回 ready（S2 设计 0.2 D9），S3 不再重复 verify（契约空白处补注：崩溃恢复 = 信任 S2 既有就绪判定，S3 只做状态迁移到 ready，不新增验证段；若 S2 ensure 返回非 ready → 视为启动失败走 S1 failed 态，不触发升级回滚）。

### D11 升级入口 UI（⛔️ 偏离 2 + B7/B12 修订）

设置页归 S6（契约 #1/#4 调用方=设置页）；S3 交付：**main 侧接口 + 托盘菜单「检查更新…」入口 + 原生 dialog 确认**（S1 dialog 先例：showMessageBox [立即升级/稍后再说]）+ 启动自动检查（开关默认开，注记 S6 落设置页）；升级进度 → 托盘 tooltip（S1 status 订阅已有）+ 设置页占位（S6 接线）。

**B7 失败提示载体**：failed 事件 + **主窗原生 dialog（可关）**——T3-05 验收口径按此（S3 验收 = 失败后有可见 dialog 提示；设置页按钮下方形态归 S6 分期）。

**B12 check 超时**：check() 超时 `CHECK_TIMEOUT_MS = 10_000` 常量 + AbortController abort 能力（超时/中止 → check-failed）。**队列语义对齐 §4.4（P1，gamma 裁决）**：check() 在自身 scope 内 acquire/release（finally）；upgrade() **独立 acquire**——契约 CON-R012 互斥对象是**升级**非版本查询，confirm 期间另一通道可正常 check/upgrade，竞得即 T3-07 queue-busy（契约语义正确，不引入跨阶段锁机制）。⛔️ 偏离 2 见 §8。

### D12 升级中退出

quitting 守卫（S1 🟡-A 双 flag + S2 quitting 守卫同族）：升级中退出 → installing 段先 `cancelInstall()`（kill npm + 清 staging，防孤儿）；swapping+ 段（swap 起始后）等 swap 完成再退出（cancel 已忽略语义一致，防半替换）；rollback 段等回滚完成。退出编排扩展见 §4.5。

---

## 3. 模块划分

| 模块 | 职责 | 依赖 | 契约接口 |
|---|---|---|---|
| `updater/Updater.ts` | 7 态状态机 + check/upgrade/cancel/rollback + on(status) + 自动回滚编排 + inFlightUpgrade()（B8） | SwapManager、UpgradeQueue、DismissStore、registry、S1 RuntimeManager、S2 OverlayManager | #1~#4 #7 #8 |
| `updater/SwapManager.ts` | 纯映射薄层（B13）：一行委托 OverlayManager.swap() + 错误码域映射（P3-②/B6）+ swapBack()/canRollback() 委托（P3-③） | S2 OverlayManager | #6 |
| `updater/UpgradeQueue.ts` | 单槽互斥：acquire(channel)/release/inFlight（S5 复用） | — | #5 |
| `updater/DismissStore.ts` | 当日不重复：dismiss.json 读写（Q-008 承载） | — | — |
| `updater/registry.ts` | HTTP registry 查询（latest 元数据，HULL_REGISTRY env，超时注入） | — | #1 支撑 |
| `updater/semver.ts` | 最小 semver compare（prerelease 感知，纯函数 ~40 行） | — | — |
| `main/index.ts` | 集成：托盘「检查更新…」菜单 + dialog 确认 + 启动自动检查 + 进度 tooltip + quitting 扩展 + hull:checkForUpdates IPC | Updater、SwapManager、TrayController、WindowManager | #1~#4 |
| `tray/TrayController.ts` | 菜单扩展「检查更新…」（现有三菜单项之上） | Updater（订阅 status） | #7 |

**依赖方向**（单向，无环）：`Updater → {SwapManager, UpgradeQueue, DismissStore, registry, RuntimeManager, OverlayManager}`；`SwapManager → OverlayManager`；`registry/semver` 无依赖（纯函数可单测）。

**S3→S4/S5/S6 承载点**：registry.ts 目标版本参数即 S4 pinned 通道落点；UpgradeQueue 即 S5 HullUpdater 复用点；DismissStore 即 S6 设置页「稍后再说」按钮接线；canRollback() 即 W3 设置页按钮禁用态数据源。

---

## 4. 关键机制实现形态

### 4.1 upgrade() 全链路伪码（D5，B1/B2/B3 修订）

```
upgrade(target):
  queue.acquire('dsh') 或 throw queue-busy（T3-07）
  try:
    status.phase = installing; pct 0→90（OverlayManager 进度事件转发）
    overlay.install(target)（可取消 T3-04；错误码域映射见 §4.3）
    status.phase = swapping; pct 100
    runtime.stop()                      # 停子进程（S1 既有，SIGTERM→5s→SIGKILL）
    swapManager.swap()                  # 委托 S2 swap 序列（门禁/原子替换/symlink/版本记录）
    if overlay.installStatus().phase !== Ready:   # B1：swap 后校验
      取消/中止（idle + 原版保留 + 不 start）——单测项：swap 返回非 ready → upgrade 返回 cancelled 语义
    status.phase = verifying; pct 100
    runtime.start()                     # 新版本启动 + 就绪判定一体（B2：合并 verify，
                                        # 就绪行+HTTP 探测即 start() 内部 ReadinessProbe，无独立 probe 段）
    验证失败 = start() reject → 自动回滚（§4.2）——T3-02 语义：注入坏地址（Q-010）→ start() reject → 回滚
    成功 → status.phase = idle; currentVersion = 新版本（T3-01）
  finally:
    queue.release()
```

### 4.2 自动回滚伪码（D6，🟢-B 语义区分 + B3/B6/B11 修订）

```
rollback(reason):
  status.phase = rollback
  if !swapManager.canRollback():        # previous 缺失
    告警 + 保留现场; status.error = verify-failed; UI「验证失败且无可回滚素材」（保留现场待排查）
    → status.phase = idle
  else:
    delete process.env.HULL_PROBE_TARGET   # B3：回滚恢复 start() 前清探测注入
                                            # 注入生命周期 = verify 段（探测坏地址）与回滚恢复段（正常探测）各一次
    swapManager.swapBack() # 反向：dsh→staging 保留现场 + previous→dsh（P3-③，B5 定义）
    runtime.start() 恢复启动                # 原版本（无探测注入 → 正常就绪）
    成功 → status.phase = idle; currentVersion = previous 版本号回写 snapshot（B11）
           UI「已回滚，原版本可用」（🟢-B：非失败提示；B6：overlay phase 已 Ready → 非 swap-broken）
    失败 → status.error = verify-failed; UI 失败提示（可重试）
```

### 4.3 错误映射表（UPGRADE_ERRORS 六码 + S2 码域映射，P3-② + B6 修订）

| S3 语义码 | 触发条件 | 来源/映射 | 可重试 |
|---|---|---|---|
| check-failed | registry 检查失败（网络/超时/HTTP 非 2xx） | registry.ts（CHECK_TIMEOUT_MS=10s，B12） | 是 |
| version-invalid | 目标版本非法（semver 校验，三触发点见契约 A4 注记） | semver.ts / S2 install 门禁 / S2 swap 版本校验 | 否 |
| install-failed | npm install 失败 | ← S2 npm-install-failed / registry-unreachable / runtime-unavailable / disk-insufficient（映射归 install-failed 域） | 是 |
| verify-failed | 就绪验证失败（start() reject，Q-010 注入路径） | RuntimeManager.start() 异常 | 否（自动回滚） |
| swap-broken | 替换中断/失败 | **B6：先读 overlay phase**——Ready（已回滚）→「已回滚，原版可用」非 swap-broken；非 Ready → swap-broken；← S2 swap 失败（npm-install-failed 域内替换段）或 cancelled 边界（swap 起始后取消被忽略 → 视为继续完成） | 否（启动残留恢复） |
| queue-busy | 另一通道升级中 | UpgradeQueue.acquire 失败（T3-07） | 是 |

**边界注记**：S2 `cancelled` 码在 swapping 起始后不会产生（S2 swap 已忽略取消）；若出现（installing 段取消的正常路径）→ S3 映射为「升级未开始/中止」→ phase = idle + 原版本保留（T3-04 语义），不归 swap-broken。

### 4.4 check() 流程（D4 + B9/B10/B12 修订）

```
check():
  queue.acquire('dsh')（失败 → queue-busy）
  try:
    phase = checking
    GET <registry>/@deepseek-ai/dsh/latest（HULL_REGISTRY env 可配；CHECK_TIMEOUT_MS = 10_000 常量 + AbortController
                                           abort 能力 → 超时/中止归 check-failed）
    URL 编码（B9）：encodeURIComponent('@deepseek-ai/dsh') 拼路径，/latest 兼容（registry 可能重定向或按包名直查）
    读完整元数据 JSON → dist-tags.latest 取值；缺失 → fallback（版本字段取 dist-tags.latest 等价路径）
    单测项：注入 URL 断言（编码后路径 + /latest 后缀）
    semver.compare(latest, current) > 0 → 有新版 → phase = confirm（pinned 目标归 S4，P1 清理）
    changeNotes（B10）：可空（UI 不展示）；纯版本对比为主路径；GitHub Releases 拉取 = 可选增强**不建**
    否则 → phase = idle（无更新）
  finally: queue.release()
  输出 { hasUpdate, current, latest, changeNotes? }
```

### 4.5 升级中退出（D12 + B8/B14 修订）

```
Updater 暴露 inFlightUpgrade(): Promise<void> | null（B8：当前升级编排 promise，无则 null）
quitOrchestration 扩展（S1 🟡-A 双 flag 之上）：
  升级中（phase ∈ {checking, confirm, installing}）→ updater.cancel()（installing 段 kill npm + 清 staging）
  phase ∈ {swapping, verifying} → await updater.inFlightUpgrade()（等待升级完成；
    超时强退 → Q-004 ensure 启动自愈注记：半替换残留由 S2 ensure 态2/3 恢复）
  phase = rollback → 等待回滚完成
  随后走既有 runtime.stop() → 500ms → quit
实现回归清单（B14）：退出路径改动跨 S 侵入 → **S1 退出测试全量回归**（RuntimeManager stop/退出相关 60 回归 + 本模块新增）
```

### 4.6 DismissStore 读写（D9）

```
dismissToday(): 写 { "date": <YYYY-MM-DD> } 到 <userData>/dismiss.json（temp+rename 原子写，S1 §5.1 同款）
isDismissedToday(): 读 date === 今日（缺失/损坏 → false；不覆盖原文件）
启动自动检查：isDismissedToday() → 跳过自动提示（手动检查不受限）
```

### 4.7 UpgradeQueue 单槽语义（D8）

```
acquire(channel): inFlight ? throw queue-busy : { channel, inFlight = true }
release(): inFlight = false
inFlight(): boolean（T3-07 入口禁用数据源）
所有调用方统一 try/finally release（防泄漏；泄漏 = 通道永久占用 → 重启自愈，注记）
```

---

## 5. 工程基线

**判级**：复杂+安全敏感（与头部一致）。

| 项 | 现状 | S3 动作 |
|---|---|---|
| git | 已有 | 直接复用 |
| 脚手架 | S1/S2 完成（TS + Electron 43 + tsc 构建） | 跟随；**零新依赖**（semver 手写，D4） |
| 测试框架 | node:test（97 用例） | 沿用；新增 updater 单测（状态机/映射/队列/DismissStore/semver/registry 注入） |
| 脚本 | build/typecheck/test/dev | 无新增 |

**S1/S2 复用清单**：TRANSITIONS 迁移表模式（S1 D7 / S2 D8）、RuntimeManager.stop()/start()（S1）、ReadinessProbe（S1，构造注入 + Q-010）、OverlayManager.install()/swap()（S2 v0.2 #2/#9）、ensure() 三态（S2，Q-004 承载）、quitOrchestration 双 flag（S1 🟡-A）、RuntimeLogger/NOOP_LOGGER（shared）。

---

## 6. 目录/工程结构（新增部分）

```
dsh-hull-desktop/
├── src/
│   ├── updater/
│   │   ├── Updater.ts            # 7 态状态机 + check/upgrade/cancel/rollback + on(status)（契约 #1~#4 #7）
│   │   ├── SwapManager.ts        # 薄封装：委托 S2 swap + 错误码映射 + rollbackSwap/canRollback（契约 #6）
│   │   ├── UpgradeQueue.ts       # 单槽互斥 acquire/release/inFlight（契约 #5，S5 复用）
│   │   ├── DismissStore.ts       # 当日不重复 dismiss.json（Q-008）
│   │   ├── registry.ts           # HTTP registry 查询（latest 元数据 + 超时）
│   │   └── semver.ts             # 最小 semver compare（prerelease 感知，纯函数）
│   ├── main/index.ts             # 集成：托盘入口/dialog/自动检查/进度 tooltip/quitting 扩展
│   └── tray/TrayController.ts    # 菜单扩展「检查更新…」
```

---

## 7. 风险与对策

| 风险 | 影响 | 对策 | 归属 |
|---|---|---|---|
| registry 检查失败（T3-02 周边） | 升级入口不可用 | check-failed 语义 + 稍后重试；离线启动已有 overlay 不受影响（S2 ensure 态1 先行） | S3 |
| 版本比较边界（prerelease/非法版本） | 误判有/无更新 | semver.ts 纯函数单测覆盖（rc 序数、非法串、相等、major/minor/patch 优先级） | S3 |
| swap 错误码域映射遗漏 | 错误语义错报 | §4.3 映射表全量单测（S2 六码 → S3 六码逐项） | S3 |
| 回滚失败（无 previous） | 新版本残留/不可用 | D6/D7：canRollback() 前置检查 + 保留现场 + 语义区分（🟢-B） | S3 |
| 升级中崩溃 | 半替换残留 | Q-004 复用：S2 ensure 态2/态3 启动自愈（T3-03） | S3（复用 S2） |
| 队列 release 泄漏 | 通道永久占用 | try/finally 统一 + inFlight 查询；泄漏 → 重启自愈（注记） | S3 |
| 升级中退出 | 孤儿 npm/半替换 | D12 quitting 守卫扩展（cancel installing 段 / 等待 swap+ 段完成） | S3 |
| 自动检查频繁打扰 | 用户反感 | D9 DismissStore 当日去重（T3-06）；开关默认开注记 S6 落设置页 | S3 |
| S2 swap 已带版本校验的二次校验 | 重复逻辑 | 信任 S2 pre-swap 门禁 + swap ⑥ 版本记录（契约 v0.2）；S3 不再重复校验，只读 currentVersion 前后对比（T3-01 断言） | S3 |

**实现期注记**（beta 复评 5 条，冻结时记录）：

- **S2 #10 swapBack 代码未实现**：S2 契约/设计仅登记、代码零改动——**S3 开工清单显式挂**：先给 OverlayManager 补 `swapBack()` 实现 + 测试，再写 S3 模块（Updater.rollback 依赖该原语）
- swapBack 前 staging 目标存在性语义（rename 目标已存在时的处理）由 S2 实现时定
- #10「无 previous → 错误语义」错误码未指明 → S3 D7 `canRollback()` 前置检查避免；竞态（检查后 previous 被消耗）时映射 `rollback-unavailable`（实现期定）
- B3 `delete HULL_PROBE_TARGET` 依赖 S1 ReadinessProbe 每次 start() 重新读 env（实现期确认——S1 probe 构造时读 env，start() 每次新建 probe 实例，预期满足）
- P1 删 confirm 占位后，原「占位无超时」风险项随之消失（gamma 修法闭环），不重复登记

---

## 8. 契约/共识对照与偏离标注

| # | 偏离点 | 契约/共识原文 | 设计取值 | 理由 |
|---|---|---|---|---|
| 1 | 失败提示/手动回滚 UI 归 S6 设置页（设计保留标注） | 契约 #1/#4 调用方 = 设置页；#4 rollback() 调用方 = 设置页 | S3 交付 main 接口（check/upgrade/cancel/rollback/canRollback）+ 托盘入口 + 原生 dialog；设置页 UI 占位注记 | 设置页内容归 S6（S1 非目标同款）；S3 先落接口与可用入口（托盘 + dialog，S1 先例），S6 接线 UI（按钮禁用态 = canRollback() 数据源，W3 落位） |
| 2 | 升级入口 UI 托盘先行（设计保留标注） | 契约：升级触发可配置（设置页） | 托盘「检查更新…」菜单 + 原生 dialog 确认（[立即升级/稍后再说]）+ 启动自动检查（开关默认开） | S6 前设置页不可用；托盘 + dialog 为 S1 既有交互面（托盘三菜单 + 崩溃 dialog 先例），零新 UI 面 |

**P3 对齐项落位表**（S2-record 登记 → 本设计落点）：
| # | S2-record 登记项 | 落位 |
|---|---|---|
| ① | S2 #9 与 S3 #6 承接方式 | D2：SwapManager 薄封装（委托 + 映射），S2 冻结面零改动 |
| ② | swap 错误码域跨契约映射 | §4.3 映射表（S2 npm-install-failed/cancelled → S3 install-failed/swap-broken，cancelled 边界注记） |
| ③ | Updater.rollback() 反向操作承载 | D2/D6/D7：S2 契约 #10 `OverlayManager.swapBack()` 新原语（rename dsh→staging 保留现场 + previous→dsh；非复用 S2 rollbackSwap——🟢-A 语义澄清），SwapManager 薄封装暴露 |
| ④ | 态 2 续替后 verify/rollback 段（契约空白） | D10 补注：ensure 态2/态3 返回 ready 即信任（S2 既有就绪判定），S3 不重复 verify；非 ready → S1 failed 态，不触发升级回滚 |
| ⑤ | 🟢-B 回滚成功但 UI 报 failed | §4.2：回滚成功 → 「已回滚，原版本可用」非失败提示；失败才报 error |
| ⑥ | W3 手动回滚按钮可用条件 | D7：canRollback()（previous 存在性）；S6 绑定按钮禁用态 |

**非偏离的契约忠实点**：7 态迁移表与冲突行为（升级中再次检查忽略/提示，queue 单槽）；UPGRADE_ERRORS 六码；Q-004 崩溃恢复（复用 S2 ensure，不重复实现）；Q-003 确认后立即升级（无排队）；prerelease 感知版本比较；互斥单槽（S5 复用）；稍后再说当日不重复（dismiss.json 独立文件不动 settings.json schema）；确认框「稍后再说」语义（Q-008）。

**T3 场景 → 设计落点**：T3-01 §4.1（正常升级链路 + currentVersion 前后对比，**回滚场景断言含 currentVersion 回写 previous 版本号，B11**）；T3-02 §4.1/B2（Q-010 注入坏地址 → **start() reject** → 自动回滚 §4.2，B3 注入生命周期）；T3-03 §1/Q-004（S2 ensure 态2/3 自愈）；T3-04 §4.1（installing 段 cancel → 原版本保留 + staging 清理）；T3-05 §4.3/B7（install-failed 映射 + **dialog 可见提示** + 重试）；T3-06 §4.6（DismissStore 当日去重）；T3-07 §4.7（queue-busy + 入口禁用/提示）。
