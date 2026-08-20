# S1 壳骨架与进程管理 技术方案

> 工作项：S1 壳骨架与进程管理（飞书 dsh-hull-desktop 清单）
> 状态：已冻结（多方复评通过，2026-08-16）
> 版本：0.2 · 2026-08-16
> 事实源：契约 `docs/api/feishu-s1-m1-api-contract.md` v0.2；共识 `docs/spec/共识-Hull桌面壳-M1.md` v1.4；PRD `docs/prd/2026-08-14-m1-prd.md`；原型 `docs/prototype/2026-08-14-m1-prototype.html`
> 判级：复杂+安全敏感。理由：含子进程生命周期清理（防误杀）与 preload 注入边界，跨契约/状态机/窗口多子系统。（评审终审裁决）
> 偏离契约/共识处统一标注：⛔️ 见 §8 对照表

---

## 1. 背景与范围

**定位**：Hull Desktop 是包住官方 DeepSeek Harness (dsh) 的 Electron 桌面壳。S1 交付壳骨架与进程管理——主进程骨架、dsh 子进程 spawn/守护/崩溃重启、就绪判定、零注入加载官方 UI、托盘基础、退出零残留。

**规则绑定**（规则索引）：CON-R001（纯壳，永不 fork/patch/替换）、CON-R006（仅 macOS Apple Silicon，代码跨平台友好）、CON-R015（就绪判定可注入）。

**范围**（契约 §范围，冻结）：
- Electron 主进程骨架（窗口/生命周期/单实例锁）
- dsh 子进程 spawn/守护/崩溃重启
- 主窗口 loadURL 官方 UI（零注入）
- 就绪判定协议（就绪行 + HTTP 探测）
- 托盘基础（打开主窗口/设置入口/退出）

**非目标**（契约 §非目标）：首装（S2）、升级编排（S3）、版本通道（S4）、Hull 自更新（S5）、设置页内容（S6）、测试框架（S7）、官方 UI 任何修改。

**交付验收**：契约测试场景 T1-01（冷启动 ≤10s 含 dsh）、T1-02（退出零残留）、T1-03（单实例唤醒）、T1-04（崩溃提示+可选重启）、T1-05（探测注入走超时→failed）、T1-06（关闭隐藏托盘，dsh 继续跑）。

**范围剪裁说明（YAGNI）**：设置页（S6）、升级队列互斥（S3/S5）、会话状态桥（已删除）、版本查询展示（S2/S4）均不进入 S1；日志仅做最小落盘（FR-8 关键路径可查），不做日志 UI。

---

## 2. 架构决策（含备选）

### D1 主进程结构分层

- **A**：单文件 main.js 承载全部逻辑
- **B**：主进程按职责拆模块（runtime / window / tray / settings / log）+ preload/renderer 边界 → **选 B**

理由：S2~S6 全部长在主进程（installer、Updater×2、自更新），单文件不可承载；分层使 RuntimeManager 的 start/stop 接口在 S3（swapping/verifying）、S5（quitAndInstall 前停）直接复用而不用触碰窗口/托盘代码。preload/renderer 边界是 PRD §6 安全要求（renderer 仅经 preload 桥访问壳能力）的落点。

边界规则（写入代码评审 checklist）：
- main 进程独占 child_process / net / 文件系统
- renderer 无 Node 能力（contextIsolation: true + sandbox: true + nodeIntegration: false）
- 子进程仅允许 127.0.0.1 回环（spawn 参数硬编码，见 D3）
- DSH_HOME（~/.dsh）壳代码零引用（CON-R002，S1 无任何触碰点）

### D2 语言：TypeScript vs JavaScript

- **A**：JavaScript（社区参照 myYangyunfan 实现即 JS）
- **B**：TypeScript → **选 B**

理由：契约冻结了 RuntimeSnapshot schema、4 相位枚举、状态机迁移表——TS 类型即契约的机器可读形态，S7 单测与契约字段级约束（message ≤200 字符）可直接落类型+运行时校验；Electron 官方脚手架默认 TS；vitest（S7）对 TS 零成本。代价仅一个 tsc 构建步骤，S1 规模下可忽略。反方论点"社区实现用 JS"不构成技术理由。

### D3 子进程 spawn 与进程组清理

- **A**：`spawn(..., { detached: true })` 使 dsh 自建进程组；POSIX 用 `process.kill(-pid, 'SIGTERM')` 整组清理；win32 预留 `taskkill /pid <pid> /T /F` 分支
- **B**：不 detached，递归遍历子孙进程逐个 kill（macOS 无 /proc，需 ps 解析，脆弱）→ **选 A**

理由：detached: true 让 dsh 成为独立进程组组长——壳崩溃时 dsh 虽脱离（成为孤儿），但残留进程是**一个可识别的进程组**，兜底清理可按组杀；遍历子孙方案在 macOS 上无可靠进程树 API，且组内进程会自行派生（dsh 的 node 工作线程），逐个 kill 必漏。Windows 分支按共识 §13 预留（`execFile('taskkill', ['/pid', String(pid), '/T', '/F'])`），代码以 `process.platform === 'win32'` 分支隔离，M1 不执行不回归。

**兜底清理（FR-7）**：启动时读 `<userData>/dsh.pid`，若存在则先 `ps -p <pid> -o command=` 校验命令行含签名 `web --host 127.0.0.1 --port 0`（防误杀用户手动跑的 dsh——其命令行不含该签名组合）→ 校验通过则 `kill(-pid)` 整组清理并删 pid 文件。签名校验为 **best-effort 概率防护，非绝对防误杀**：单实例前提下（D4）无多实例并存误杀场景。限制天花板：未来若允许多实例并存，需升级为 token 方案（pid 文件写随机 token + `ps eww` 校验命令行）；不预做 token+ps eww 实现（终审裁决，YAGNI）。

### D4 单实例锁

- **A**：`app.requestSingleInstanceLock()`（Electron 原生）
- **B**：自写锁文件（lockfile + pid + 自管 IPC 唤醒）→ **选 A**

理由：官方 API 与 app 生命周期天然集成，自动提供 `second-instance` 事件作为唤醒信号，锁失败即 `app.quit()`。自写锁在 macOS 要处理崩溃残留 stale lock（锁文件在、进程已死），且要自造跨进程唤醒机制——全部是 Electron 已解决的问题，重造即债务。唤醒语义（T1-03）：`second-instance` → 主窗口 `show() + focus() + restore()`（最小化时还原）。

### D5 就绪行解析：stdout/stderr 合并流策略

- **A**：双流独立行缓冲解析（stdout 优先、stderr 兜底），任一命中即提取 URL
- **B**：物理合并为单一流再解析 → **选 A**

理由：契约就绪行"来源 stdout/stderr"——dsh 实际写哪个流不受壳控制，双流各自解析即覆盖；物理合并需 tee 且丢失流归属信息（诊断日志需知道输出来自哪个流）。实现形态：每流维护行缓冲（`chunk.split('\n')` + 残留拼接，解决半行问题），单行长度上限 8KB 截断（防畸形输出）；命中前每行先 strip ANSI CSI 序列（一行正则 `\x1b\[[0-9;]*[a-zA-Z]` 清除）+ `trim()`（容 \r\n）。

**兜底路径**：
- 就绪行 60s 内未出现 → 超时 → failed（契约值；就绪行超时预算与探测预算分离）
- 就绪行出现 → 探测在固定 15s 窗口内周期重试（间隔 500ms），成功即 ready；窗口耗尽 → failed（15s 为常量，不注入配置）。⛔️ 偏离 1 已合入契约 v0.2（见 §8）

全部子进程输出同时落盘 `dsh-<pid>.log`（FR-8），就绪行原文入日志（回环地址无敏感信息）。

### D6 preload 桥安全边界

- **A**：主窗口挂最小 preload（contextBridge 白名单暴露 2 个方法：retry / openLogs）
- **B**：S1 不建 preload，失败态重试改用原生 dialog → **选 A + 严格约束**

理由：共识 §4.1（Q-007 结论）明确"主窗口失败态（重试按钮 + 日志入口）"——页面按钮必须经 IPC 触达 main，原生 dialog 无法满足页面态要求。⛔️ 偏离 4：契约接口清单（#1~#6）未列 IPC 接口，此为支撑 Q-007 的实现细节。

约束：
- webPreferences：`contextIsolation: true`、`sandbox: true`、`nodeIntegration: false`（PRD §6 安全基线）
- API 面仅 `hull.retry()` / `hull.openLogs()` 两个 `ipcRenderer.invoke`，不暴露任意通道、不透传回调
- 零注入语义：preload 仅随占位页 loadURL 显式传入；官方 UI loadURL 时不传 preload（不挂载即零注入，CON-R001）；`window.hull` 命名冲突概率低，S6 设置页桥再扩展（不预做）
- 挂载点：显式传参（`loadURL(url, { preload })` 仅占位页路径传）优于 file: 协议运行时判断（终审裁决）
  > 注记（2026-08-18）：Electron 实际不支持 loadURL preload 选项（LoadURLOptions 无此字段，核对 electron 43 d.ts），实现形态偏离为 session 级 preload 脚本：`setPreloads`（Electron 43 弃用）→ **已迁移 `registerPreloadScript`**（frame 型、固定 id `hull-placeholder`，占位页注册 / 官方 UI unregister 实现零注入 CON-R001）。设计结论（仅占位页挂载、官方零注入）不变。

### D7 运行时状态机实现形态

- **A**：EventEmitter 子类 + 显式迁移表校验
- **B**：xstate 等状态机库 → 重依赖，4 态 5 迁移不值
- **C**：裸字段 + 散落 if → 无法表达冲突行为 → **选 A**

理由：契约 §4.2 状态机仅 4 状态，xstate 属过度；但裸字段无法承载契约的**冲突行为**（starting 中重复 start 忽略）与非法迁移（S7 单测需对着迁移表测）。实现形态：
- `phase` 私有字段 + `TRANSITIONS: Record<Phase, Phase[]>` 迁移表 + 非法迁移 dev 下 throw / prod 下 log 并忽略
- `extends EventEmitter`，`on('status', cb)` 天然对应契约 #4（托盘/标题栏订阅）
- `snapshot()` 返回深拷贝（防外部改内部状态）；message 超 200 字符截断（契约字段约束）

**start 幂等（契约 v0.2 统一语义）**：starting 中重复 start → 忽略；ready 中 start → 先停后起（等价 restart）；failed 中 start → 直接起。

**starting 中子进程非预期退出** → 立即 `failed(child-exited)`，不等超时（契约 v0.2 已补迁移行）。

**⛔️ 偏离 2**：契约状态机表未列 stop 迁移——设计补充"任意状态 stop() → idle"（含 starting 中停止 = kill 子进程组 + 清理）。**已合入契约 v0.2**（stop 迁移行已补），见 §8。

---

## 3. 模块划分

| 模块 | 职责 | 依赖 | 契约接口 |
|---|---|---|---|
| `main/index.ts` | app 生命周期编排：单实例锁 → 兜底清理 → Logger/Settings 初始化 → 窗口创建 ∥ start() → 退出编排 | 全部 | — |
| `runtime/RuntimeManager.ts` | dsh 状态机 + spawn + 守护 + stop/snapshot/on；spawn cwd = overlay 目录（`<userData>/dsh`），`snapshot().launchDirectory` 回填该值 | ReadinessProbe、spawnArgs、SettingsProvider、Logger | #1~#4 |
| `runtime/ReadinessProbe.ts` | 就绪行正则解析（双流）+ HTTP GET 探测；target/timeout/interval 可注入（构造参数 + env `HULL_PROBE_TARGET`/`HULL_READY_TIMEOUT_MS`，Q-010） | —（纯逻辑，可单测） | #5 |
| `runtime/spawnArgs.ts` | **dsh CLI 契约收敛点**：spawn argv（`node --expose-internals <dsh> web --host 127.0.0.1 --port 0`；--expose-internals 为 node flag 须在脚本名之前）与就绪行正则常量 | — | — |
| `runtime/SingleInstance.ts` | 封装 `requestSingleInstanceLock` → `{ ok, onSecondInstance }` | — | #6 |
| `window/WindowManager.ts` | 主窗口创建/占位页/loadURL/隐藏/标题状态/失败态 | RuntimeManager（只订阅） | — |
| `tray/TrayController.ts` | 托盘图标 + 菜单（打开主窗口 / Hull 设置…〔S1 禁用占位，S6 启用〕/ 退出先停 dsh）+ 状态 tooltip | RuntimeManager、WindowManager | — |
| `settings/SettingsProvider.ts` | 读 `<userData>/settings.json` + 默认值（closeToQuit=false）；S1 只读，S6 补写；路径构造注入（测试）；损坏恢复：JSON.parse 失败 → 告警日志 + 回退默认值，不覆盖原文件 | — | — |
| `log/Logger.ts` | hull.log 追加 + dsh-`<pid>`.log，统一 size 轮转（如单文件 1MB → hull.log.1/2/3，dsh 日志同规则）；初始化失败降级（磁盘满/权限不足 → fallback console.warn，不阻塞启动） | — | — |
| `preload/index.ts` | contextBridge 白名单：retry / openLogs | — | — |
| `shared/types.ts` | RuntimeSnapshot / RuntimePhase / 状态迁移表类型 | — | — |
| `shared/errors.ts` | 具名错误集（W1 落地）：`HullError` 基类 + `StartTimeoutError('start-timeout')` / `SpawnFailedError('spawn-failed')` / `DshMissingError('dsh-missing')` / `ChildExitedError('child-exited')`，与 S2/S3 命名风格统一 | — | — |

**依赖方向**（单向，无环）：`index → {WindowManager, TrayController, RuntimeManager, SingleInstance, SettingsProvider, Logger}`；`RuntimeManager → {ReadinessProbe, spawnArgs, SettingsProvider, Logger}`；`WindowManager/TrayController → RuntimeManager`（仅订阅 on + 调 snapshot()）。

**S1→S6 承载点**（接口冻结，后续 S 不重构）：
- S2 首装：安装完成后调 `RuntimeManager.start()`；`DshMissingError` → "未安装"引导态（S1 只做引导态占位页，安装动作 S2 落地）
- S3 升级：swapping 前 `stop()`；verifying 复用 `start()` + ReadinessProbe（就绪验证同一套）
- S5 自更新：`quitAndInstall` 前 `stop()`
- S6 设置页：SettingsProvider 补写 + TrayController 扩展

---

## 4. 关键机制实现形态

### 4.1 就绪判定（T1-01 / T1-05）

```
start():
  校验 overlay 存在（<userData>/dsh）→ 缺失抛 DshMissingError（S2 处理）
  state = starting
  spawn(nodePath, ['--expose-internals', overlayBin/dsh, 'web',
                   '--host', '127.0.0.1', '--port', '0'], { detached: true, cwd: overlayDir })
  pid 落盘 <userData>/dsh.pid
  stdout/stderr 双流 → ReadinessProbe 行缓冲解析（ANSI CSI 剥离 + trim）
  命中 /^dsh web: (http:\/\/127\.0\.0\.1:[0-9]+)/ → 提取 url（就绪行超时预算 60s 独立计算）
  探测：对注入目标（默认就绪行 URL）在固定 15s 窗口内周期重试（间隔 500ms）
       网络错误（ECONNREFUSED/ETIMEDOUT/ECONNRESET）继续重试不立即 failed；窗口耗尽 → failed
  探测成功 → state = ready → emit
  语义固化：注入目标仅作用于探测；loadURL 恒用就绪行提取的 URL
```

计时埋点（hull.log）：t0 入口 → t1 spawn 发出 → t2 就绪行 → t3 探测 200 → t4 did-finish-load，S7 测量数据源。

### 4.2 崩溃守护重启（T1-04）

- `child.on('exit')`：非主动停止（主动标志位区分 stop() 路径）且 state != idle → 判定崩溃——starting 中退出 → 立即 `failed(child-exited)`（不等超时）；ready 中 → `failed`（崩溃）→ 原生 dialog「dsh 已崩溃，是否重启？」[重启 / 忽略]；重启 → `start()`（先清理残留 pid 文件）；「忽略」→ 窗口切回占位页 failed 态（复用 retry/openLogs）
- `child.on('error')`（spawn 失败）→ `failed(spawn-failed)`
- `did-fail-load`（官方 UI 加载失败）→ 占位页 failed 态（复用 retry/openLogs）
- failed 迁移统一删除 dsh.pid（防死 pid 残留）
- 托盘 tooltip 与主窗口标题随 `on('status')` 更新（契约 #4 调用方：托盘/标题栏；S1 标题只显示状态 phase，dsh 版本展示归 S2/S4）

### 4.3 退出清理（T1-02 / T1-06）

```
退出编排（托盘退出 / Cmd+Q）:
  before-quit → e.preventDefault() + quitting flag（防递归）→ await stop()（SIGTERM 进程组 → 5s 宽限未退 → SIGKILL 进程组）
  → 删 dsh.pid → 完成后 app.quit()
  SIGKILL 后短延时（~500ms）再退出（防 zombie）

窗口关闭（closeToQuit 读取 SettingsProvider）:
  closeToQuit=false（默认）→ close 事件 preventDefault + hide()（dsh 继续跑，T1-06）
  closeToQuit=true → 走退出编排
  window-all-closed → 不退出（macOS）
  app.on('activate') → 窗口 show + focus（托盘隐藏后点 dock 恢复）
```

starting 中退出：stop() 直接 kill 进程组，不等待就绪（全状态可用，偏离 2）。

### 4.4 单实例唤醒（T1-03）

锁失败 → `app.quit()`；`second-instance` → 主窗口 `show + focus + restore`。锁调用必须在 app ready 之前（Electron 要求尽早）。

### 4.5 启动兜底清理（FR-7 孤儿防护）

启动流程第 2 步：读 `dsh.pid` → `ps -p <pid> -o command=` 校验签名（含 `web` + `--host 127.0.0.1` + `--port 0`）→ 校验通过按组杀 → 删 pid 文件。签名校验为 **best-effort 概率防护，非绝对防误杀**（与 D3 一致）：单实例前提下无多实例并存误杀场景；无 pid 文件时不扫全系统（YAGNI，pid 文件丢失属罕见双保险场景，S7 再评估）。

---

## 5. 工程基线

**判级**：复杂+安全敏感（与头部一致）。理由：含子进程生命周期清理（防误杀）与 preload 注入边界，跨契约/状态机/窗口多子系统。

| 项 | 现状 | S1 动作 |
|---|---|---|
| git | 已有（docs-only 历史） | 直接复用 |
| 脚手架 | 无 | 最小 Electron+TS 骨架：`package.json`（`main: dist/main/index.js`）+ `tsconfig.json` + `electron` devDependency + 构建 = `tsc`（不引 esbuild/electron-builder，打包归 S2） |
| 测试框架 | 无（vitest 归 S7） | S1 用 Node 内置 `node:test`（零依赖）覆盖纯函数——就绪行解析（正则+ANSI+半行）、状态迁移表；不装 vitest（归 S7）、不重复 S7 范围 |
| 脚本 | — | `dev`: tsc -w + electron .；`build`: tsc；`typecheck` |

**Node 解析器来源**（⛔️ 偏离 3）：契约 #1"捆绑 Node"，但捆绑交付在 S2——S1 采用注入顺序：`HULL_NODE_PATH` env → 捆绑路径探测（`<userData>/node/bin/node`，S2 落位后生效）→ PATH 兜底（dev 模式）。RuntimeManager 只认解析器路径，S2 交付捆绑后接口不变。**已合入契约 v0.2**（#1 Node 来源注记：env → 捆绑路径探测 → PATH，S2 收口），见 §8。

**冷启动预算分解**（T1-01，壳侧）：单实例锁+兜底清理+配置读 ~几十 ms；whenReady ~1s；spawn 与窗口创建**并行**（Promise.all）；探测间隔 500ms 首轮即中。壳编排开销目标 <1s（PRD §6），剩余预算归 dsh 自身启动 + 官方 UI 加载（Q-009 验收口径含 dsh）。

**dev overlay 来源**（非阻断，实现期落地）：README dev 章节写明 symlink / npm-install 到 `<userData>/dsh` 的步骤。

### 5.1 数据存储

**userData 布局**（`<userData>/` 属壳可写）：

| 路径 | 内容 | 谁建/何时建 |
|---|---|---|
| `settings.json` | 壳设置（S1 只读；S4 起扩展写，见下） | S1 首次启动（缺失则用默认值，不建文件） |
| `dsh.pid` | dsh 子进程 pid + spawn 时间戳 | S1 每次 spawn 成功后写 |
| `logs/` | hull.log + dsh-`<pid>`.log（size 轮转） | S1 启动建目录 |
| `dsh/` | dsh overlay（运行时） | S2 首装 |
| `node/` | 捆绑 Node | S2 首装 |
| `dsh-staging/` + `dsh-previous/` | 升级暂存与备份 | S3 升级时建 |
| `dismiss.json` | 「稍后再说」当日不重复记录——**分通道双键 `{ dsh?, hull? }`（S5 勘误补登：原单键扩展为 dsh/hull 分通道，旧单键读兼容视作 dsh 侧）** | S3/S5 DismissStore 写入 |

**settings.json 最小 schema**（S1 仅读 + **S4 变更传播扩展**）：`closeToQuit: boolean`（默认 false）+ `schemaVersion: number`（预留 S6 迁移）+ **`channel: 'latest'|'pinned'`（默认 'latest'，S4 扩展）** + **`pinnedVersion?: string`（channel=pinned 时必填，S4 扩展）**。损坏（JSON.parse 失败）→ 告警日志 + 回退默认值，**不覆盖原文件**。**schemaVersion bump 策略（S4 评审波）：schema 扩展必 bump（当前 1 → 2），S6 迁移以 bump 后版本号为判据**。

**dsh.pid 规范**：内容 `{ pid, spawnAt }`（pid + spawn 时间戳）；写入时机 = spawn 成功后；删除时机 = exit / stop() / 兜底清理 / failed 迁移；损坏解析失败 → 跳过清理（无害降级）。

**日志规范**：size 轮转统一（单文件 1MB → `.1/.2/.3`，与 §3 Logger 一致）。

**DSH_HOME/userData 边界**：壳可写 = userData 全部；DSH_HOME 零读写（CON-R002）；overlay 属 userData（`<userData>/dsh`）。

**原子写原则**：temp + rename 原子写落 dsh.pid 写入；settings.json 写路径——**S4 承担首个写者（channel 字段，temp+rename 原子写；S4 变更传播修订）**，S6 设置页 UI 接线。

---

## 6. 目录/工程结构

```
dsh-hull-desktop/
├── package.json                  # main: dist/main/index.js；scripts: dev/build/typecheck
├── tsconfig.json
├── src/
│   ├── main/
│   │   ├── index.ts              # app 生命周期 + 启动/退出编排
│   │   ├── window/WindowManager.ts
│   │   ├── tray/TrayController.ts
│   │   ├── runtime/
│   │   │   ├── RuntimeManager.ts
│   │   │   ├── ReadinessProbe.ts
│   │   │   ├── spawnArgs.ts      # dsh CLI 契约收敛点
│   │   │   └── SingleInstance.ts
│   │   ├── settings/SettingsProvider.ts
│   │   └── log/Logger.ts
│   ├── preload/
│   │   └── index.ts              # 最小桥：retry / openLogs
│   ├── renderer/
│   │   └── placeholder.html      # 本地占位页：starting / failed（重试+日志入口）/ 未安装引导态
│   └── shared/
│       ├── types.ts              # RuntimeSnapshot / RuntimePhase / 迁移表
│       └── errors.ts             # 具名错误集（W1）
└── docs/design/S1-壳骨架-m1-design.md  # 本文
```

官方 UI 不落本仓库（CON-R001 零 fork），运行时 loadURL 官方地址。

---

## 7. 风险与对策

| 风险 | 影响 | 对策 | 归属 |
|---|---|---|---|
| dsh rc 期 CLI 契约变（就绪行/参数/入口路径） | 启动/就绪失败 | spawn 参数 + 就绪行正则收敛 `spawnArgs.ts` 单一修改点（PRD §8 风险缓解）；官方发布后回归 T1-01/T1-05 | S1 起持续 |
| 壳崩溃/被 kill 致 dsh 孤儿 | 残留进程（T1-02 验收失败） | detached 进程组 + 启动兜底清理（pid 文件 + 命令行签名校验防误杀） | S1 |
| Gatekeeper 拦无公证 dmg | 打不开（dev 模式无影响） | README 引导右键打开；dmg 打包在 S2，S1 不受影响 | S2 |
| 10s 冷启动超预算 | T1-01 验收失败 | 并行启动 + 500ms 探测间隔 + 分阶段计时埋点（hull.log t0~t4，S7 测量）；若官方 UI 加载吃预算 → 以 did-finish-load 计并 S7 专项优化，不预做缓存策略（YAGNI） | S1+S7 |
| 就绪行正则脆弱（前缀/CRLF/半行） | 误判超时 | trim + 行缓冲 + 双流兜底 + 原始输出落盘可查 | S1 |
| starting 中用户退出 | 卡死 | stop() 全状态可用，直接杀组不等就绪（偏离 2） | S1 |
| 兜底清理误杀用户进程 | 用户数据进程被杀 | 命令行签名校验 + pid 文件双重确认 | S1 |

---

## 8. 契约/共识对照与偏离标注（设计核验对照）

| # | 偏离点 | 契约/共识原文 | 设计取值 | 理由 |
|---|---|---|---|---|
| 1 | 探测语义（**已合入契约 v0.2**） | 契约 §就绪行协议"HTTP GET 目标地址，200 即通过"；共识 Q-009"就绪行出现后 HTTP 探测**一次**" | 探测在固定 15s 窗口内周期重试（间隔 500ms），成功即 ready；窗口耗尽 → failed | T1-05 要求探测指向坏地址时走"**超时**→failed"路径——一次性探测失败立即 failed 与 T1-05 冲突；周期重试同时满足"成功后即 loadURL"（不会白屏）。契约 v0.2 已按此封口（探测语义 + 语义固化） |
| 2 | stop 迁移（**已合入契约 v0.2**） | 契约 §状态转换表仅 idle→starting→ready/failed + restart/重试 | 补充：任意状态 `stop()` → idle（含 starting 中 = 杀组清理） | 契约 #2 stop 幂等、T1-02 退出零残留均要求 starting 中可停；表未列属契约空白，接口语义必须覆盖。契约 v0.2 已补 stop 迁移行 |
| 3 | Node 来源（**已合入契约 v0.2**） | 契约 #1"spawn（捆绑 Node + …）" | S1 解析器注入顺序：env → 捆绑路径探测（S2 落位）→ PATH；RuntimeManager 只认路径 | 捆绑 Node 交付在 S2（CON-R007），S1 需可运行 dev 路径；接口不变，S2 无缝切换。契约 v0.2 已加 #1 注记（交付分期，终态一致） |
| 4 | preload IPC（设计保留标注） | 契约接口清单（#1~#6）无 IPC 接口 | 最小桥 2 方法（retry/openLogs），contextIsolation+sandbox | Q-007 要求主窗口失败态页面按钮；契约 v0.2 已补 #7 IPC 接口（hull.retry()/hull.openLogs()）；preload 仅随占位页挂载，官方 UI 不挂（D6） |

**T1 场景 → 设计落点**：T1-01 §4.1+§5 预算；T1-02 §4.3+§4.5；T1-03 §4.4；T1-04 §4.2；T1-05 §4.1+偏离 1；T1-06 §4.3。

**非偏离的契约忠实点**：状态机 4 态迁移与冲突行为照契约 v0.2 表（starting 中重复 start 忽略；starting 子进程退出即 failed；任意状态 stop() → idle）；RuntimeSnapshot 四字段（message ≤200 截断）；就绪行正则、60s 就绪行超时、双流来源、15s 探测窗口；spawn 参数（`node --expose-internals <dsh> web --host 127.0.0.1 --port 0`）；start 幂等（starting 中重复 start 忽略 / ready 中先停后起 / failed 中直接起）；托盘三菜单项；closeToQuit 默认 false；单实例唤醒。

**开放问题承接**：W1（P2）具名错误集 → 本设计 §3 `shared/errors.ts` 落地，命名风格向 S2/S3 看齐。
