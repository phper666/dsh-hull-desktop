# S1 实现记录与核验记录

> 判级：复杂+安全敏感（含子进程生命周期清理防误杀与 preload 注入边界，跨契约/状态机/窗口多子系统）
> 事实源：契约 `docs/api/feishu-s1-api-contract.md` v0.2（冻结）、设计 `docs/design/S1-壳骨架-design.md` 0.2（冻结 2026-08-16）

## 实现记录

### 文件清单（src 19 文件）

**业务代码（13）**
| 文件 | 职责 |
|---|---|
| `src/main/index.ts` | 主进程编排：单实例锁 → 兜底清理（FR-7）→ Logger/Settings → whenReady 窗口∥start 并行 → 双 flag 退出编排 → 崩溃 dialog → ipcMain 两通道 |
| `src/window/WindowManager.ts` | 主窗口：安全 webPreferences、占位页/官方 UI 双加载（session.setPreloads 控制 preload 挂载）、close 按 closeToQuit 分派、status 订阅、t4 计时 |
| `src/tray/TrayController.ts` | 托盘：占位 16x16 PNG、三菜单项（打开主窗口/设置占位禁用/退出先停 dsh）、tooltip 订阅 status |
| `src/runtime/RuntimeManager.ts` | dsh 状态机 + 进程编排：迁移表、start 幂等三语义、spawn（buildSpawnArgv/detached/overlay 校验/node 三顺序解析）、双流 tee 落盘（FR-8）、ReadinessProbe 接线 + 失败映射、pid 落盘/删除、SIGTERM→5s→SIGKILL 进程组清理、t0~t3 埋点 |
| `src/runtime/ReadinessProbe.ts` | 双流就绪判定：行缓冲（半行重组/8KB 截断/ANSI strip）、60s 就绪行预算、固定 15s 探测窗口周期重试（网络错误继续）、注入目标仅作用探测 |
| `src/runtime/spawnArgs.ts` | dsh CLI 契约收敛点：spawn 参数串（--expose-internals 在脚本名前）、就绪行正则、ANSI strip/cleanLine、命令行签名（兜底清理校验） |
| `src/runtime/SingleInstance.ts` | 单实例锁封装（requestSingleInstanceLock → { ok, onSecondInstance }，app ready 前调用） |
| `src/settings/SettingsProvider.ts` | settings.json 只读：缺失默认不建文件、损坏回退默认不覆盖原文件（closeToQuit/schemaVersion） |
| `src/log/Logger.ts` | hull.log + dsh-`<pid>`.log 追加、1MB size 轮转 .1/.2/.3、失败降级 console.warn 不抛 |
| `src/preload/index.ts` | contextBridge 白名单桥：hull.retry()/hull.openLogs()（sandbox 兼容） |
| `src/shared/types.ts` | RuntimePhase 枚举 / RuntimeSnapshot 四字段 / 迁移表类型 / RuntimeLogger + NOOP_LOGGER |
| `src/shared/errors.ts` | 具名错误集：HullError 基类 + start-timeout/spawn-failed/dsh-missing/child-exited |
| `src/renderer/placeholder.html` | 占位页三视图（starting/failed 重试+日志/未安装引导态），调 window.hull 桥 |

**测试（6）**：`types.test.ts` / `spawnArgs.test.ts` / `ReadinessProbe.test.ts` / `RuntimeManager.test.ts` / `SettingsProvider.test.ts` / `Logger.test.ts`

### TDD：60 用例，核心路径全测

| 文件 | 用例数 | 覆盖要点 |
|---|---|---|
| ReadinessProbe | 14 | 就绪行正则/ANSI/半行重组/8KB 截断/双流任一/60s 预算超时/streams-ended/15s 窗口耗尽/网络错误重试/非 200 重试/注入目标仅作用探测/真实回环慢就绪/readyTimer 清除 |
| RuntimeManager | 23 | 迁移表合法/非法 dev throw/start 幂等三语义/stop 全状态幂等/child-exited 立即/crash 事件/主动停止不判崩溃/snapshot 深拷贝/message 200 截断/overlay 缺失/node 解析三顺序/pid 落盘删除/探测超时映射/spawn-failed/信号序列 SIGTERM→SIGKILL/FR-8 tee/旧 child 晚退出/stop 并发 |
| spawnArgs | 8 | 参数串顺序（--expose-internals 在脚本名前）/web 子命令/正则匹配与不匹配/cleanLine/CLI 签名/dshBinPath |
| SettingsProvider | 5 | 缺失默认不建文件/正常读/parse 失败回退不覆盖/字段类型错/部分字段 |
| Logger | 4 | 追加落盘/轮转 .1/.2/.3 顺序/无 .4/dshLog/写失败降级 |
| types | 6 | 枚举值/迁移表类型/snapshot 字段/错误类 name+code |

> 注：骨架预估 61，实际 60（npm test 实测 pass 60）。

### 质量
- `npm run typecheck`（tsc --noEmit）：干净
- `npm test`（tsc && node --test "dist/**/*.test.js"）：60 pass / 0 fail，~0.7s
- `npm run build`：dist/ 全量产出

## 核验记录

### Code Review
- 双席 AI review（oracle + gamma）→ 有条件通过：🔴×2（FR-8 dsh 输出未落盘、旧 child 晚退出误判）+ 🟡×3（dev 脚本 tsc -w 阻塞、readyTimer 未清除、quitting 守卫）+ Y-2（stop 并发）+ 🟢-5（t4 误记）
- 修复 7 项全部落地（TDD：先补 4 测试用例再修实现）→ ora-1 复核「通过」
- 追加 🟡-A（2026-08-16）：before-quit 编排中途二次退出漏防 → 双 flag（quitting=编排中 / quitProceeding=最终 quit 已发出），二次触发 preventDefault 拦截，慢退出场景不再跳过 SIGKILL 升级与 500ms 延时

### Semgrep
- 1.172.0 自动配置 227 规则、21 文件扫描：0 findings

### 契约符合性（T1 场景对照）

| 场景 | 契约要求 | 单元级证据 | 状态 |
|---|---|---|---|
| T1-01 冷启动 ≤10s | 含 dsh 启动 | 窗口∥start 并行（main）；计时埋点 t0~t3（RuntimeManager） | 单元级 ✓，集成待 electron 二进制 |
| T1-02 退出零残留 | 无 dsh/node 残留 | stop() SIGTERM→SIGKILL 进程组（⑲ 信号序列）；兜底清理签名校验（matchesDshSignature 用例）；pid 删除（⑯⑲⑳） | 单元级 ✓，集成待 electron |
| T1-03 单实例唤醒 | 第二实例唤醒第一个 | acquireSingleInstanceLock + second-instance → show/focus/restore（main，electron API） | 集成待 electron |
| T1-04 崩溃提示+可选重启 | dialog + 重启/忽略 | crash 事件（⑧）；dialog 分支 + retry IPC（main）；忽略 → 占位页 failed | 单元级 ✓（⑧），dialog 集成待 electron |
| T1-05 探测注入走超时→failed | HULL_PROBE_TARGET 注入 | 注入目标仅作用探测（probe 用例）；探测超时 → failed(start-timeout)（⑰）；15s 窗口耗尽（probe 用例） | 单元级 ✓ |
| T1-06 关闭隐藏托盘 | closeToQuit=false hide，dsh 继续跑 | WindowManager close → preventDefault+hide（electron） | 集成待 electron |

### 环境阻塞
- electron 二进制下载失败：github.com 不可达（`TypeError: fetch failed`），npmmirror 镜像安装 300s 未完成
- T1 集成验证待网络恢复后执行：`ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ node node_modules/electron/install.js`，随后 `npx electron .`（需先在 `<userData>/dsh/bin` 放置 dsh 脚本）

### 风险登记
- 🟢-4：`session.setPreloads` 为 session 级共享——S6 设置窗口需独立 partition（或显式管理 preload 挂载），否则继承占位页 preload
- 🟢-B：start-during-stop 竞态（S1 入口不可达：start 幂等语义已覆盖 starting/ready/failed 各态；S3 swapping 承载点注记，不预做）
- 🟡-4：`ps -p <pid> -o command=` 输出截断时签名校验失败 → 跳过兜底清理为已知降级（不误杀优先，设计 §4.5 best-effort 语义一致）
- 🟢-6：message 200 字符截断按 code point 截（slice），可能切断 surrogate pair（外观级，无功能影响）
