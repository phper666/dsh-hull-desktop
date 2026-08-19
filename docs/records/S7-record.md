# S7 实现记录与核验记录

> 判级：复杂（测试体系搭建 + 跨层验证 + 外部依赖 electron/dsh/registry；无安全敏感面）
> 事实源：契约 `docs/api/feishu-s7-api-contract.md` v0.2（冻结 2026-08-17）、设计 `docs/design/S7-测试验收-design.md` 0.2（冻结 2026-08-17）

## 实现记录

### S7 收尾（e2e 补全，2026-08-18，electron 二进制 + registry 阻塞解除）

#### 文件清单（e2e 层）
- `playwright.config.ts` — Playwright 配置（testDir tests/e2e、workers=1 串行〔单实例锁 + 共享资源〕、120s 默认超时〔慢测试用例内覆盖〕）
- `tests/e2e/helpers.ts` — 公共助手：临时 userData 隔离（CON-R002 精神）+ fake dsh overlay 种子（结构对齐真实 npm 安装链：bin/dsh → node_modules/.bin/dsh → lib/bin.js）+ launch（HULL_USER_DATA/HULL_E2E/FAKE_DSH_MODE/HULL_REGISTRY 注入）+ 就绪判定（webContents URL + HTTP body=ok，page 对象 URL 跟踪与 webContents 不同步故不走 renderer）+ 托盘菜单状态读取 + 假 registry 启动 + 版本/settings 落盘轮询
- `tests/fixtures/fake-registry.js` — 本地假 npm registry（@deepseek-ai/dsh 单包：manifest + 裸版 + gzip tar〔最小 ustar 手写 + 内嵌 fake-dsh.js 为 lib/bin.js〕；tarball 延迟可注入〔E2E-06 升级窗口〕；npm 实测 509ms 装完）
- `tests/e2e/cold-start.spec.ts` — E2E-01（冷启动计时 ≤10s Q-009 权威口径）/ E2E-05（退出零残留：pid 文件 + ps 双查）/ E2E-06（托盘：菜单存在 + 关闭隐藏→openMain 恢复 + 设置入口 + 升级中「检查更新…」禁用→恢复）
- `tests/e2e/install.spec.ts` — E2E-02（首装自动触发→取消→引导态→重装成功；registry 用本地假源〔见下「偏离与注记」〕；失败快速失败不空等）
- `tests/e2e/upgrade.spec.ts` — E2E-03（升级全流程：版本 0.1.0-rc.7→9.9.9 + 数据无损〔marker/settings.json 跨升级保留〕）/ E2E-04（HULL_PROBE_TARGET 坏地址注入→verify 失败→自动回滚→原版可用）
- `tests/e2e/settings.spec.ts` — E2E-07（registry 持久化〔落盘+重开保留〕/ 非法 registry 校验提示 / 关闭即退出）
- `package.json` — test:e2e = `tsc && playwright test`；devDependencies + playwright + @playwright/test

#### 配套源码改动（e2e 暴露的真实 bug，均已修复 + 回归）
1. **退出编排被窗口 close 拦截（🔴）**：closeToQuit=false 时主窗口 close 处理器 preventDefault+hide，阻断 quitOrchestration 最终 app.quit()——托盘「退出」与关闭即退出均无法退出应用（单测不覆盖 main 装配路径，e2e 暴露）。修复：WindowManager 加 quitting 标记 + setQuitting()，main 在最终 app.quit() 前调用；close 处理器放行。
2. **托盘升级完成后永久禁用（🔴）**：Updater 状态机 Idle 迁移事件在 queue.release() 之前发出，托盘 busy 数据源（queue.inFlight）未刷新→升级完成后「检查更新…」永远禁用（E2E-06 暴露）。修复：UpgradeQueue 加 changed 事件（acquire/release 广播），TrayController 订阅直连 rebuildMenu（不额外 emit status——保 status 事件序列契约，HullUpdater 同款）。
3. **设置页开关全坏（🔴）**：settings.html bindSwitch 传假 errorEl `{previousElementSibling:null}`，setError 访问 el.style 崩溃→closeToQuit/autoCheckDsh/autoCheckHull 三个开关均不可用（E2E-07 暴露）。修复：bindSwitch 传 null + setError 空值防御。
4. **窗口标题导航后回退（🟡）**：官方 UI（无 <title> 的纯文本页）加载后窗口标题从「Hull — ready」回退「Hull」。e2e 就绪判定改走 webContents URL + HTTP 内容（真实可交互信号），标题仅作设计意图注记。

#### 场景覆盖状态
| 场景 | 状态 | 说明 |
|---|---|---|
| E2E-01 冷启动 | ✅ 完成 | 实测 960-1120ms ≤10s；Q-009 权威口径（launch→官方 UI 可交互） |
| E2E-02 首装+取消 | ✅ 完成 | 取消→引导态→重装→ready 全编排真实执行；registry 用本地假源（见偏离注记） |
| E2E-03 升级全流程 | ✅ 完成 | 版本变化 + 数据无损（marker + settings.json 跨升级保留） |
| E2E-04 坏版本注入 | ✅ 完成 | HULL_PROBE_TARGET 注入→15s 探测窗口→自动回滚→原版可用 |
| E2E-05 退出清理 | ✅ 完成 | pid 文件删除 + 进程消亡 + ps 零残留 |
| E2E-06 托盘 | ✅ 完成 | 打开主窗口/设置入口/升级中禁用（菜单项 enabled 状态读取） |
| E2E-07 设置页 | ✅ 完成 | T6-01 registry 持久化 / T6-03 关闭即退出 / T6-05 校验提示 |

#### 偏离与注记
- **E2E-02 registry 注入模拟（⛔️ 偏离注记）**：任务允许「注入模拟」；真实官方 registry 网络慢且波动（冷装实测 261s、多次超 590s 仍不完成——runtime-verification 已注「网络瓶颈非代码 bug」）。本地假 registry 使 E2E-02 秒级完成且确定性；真实包安装路径由 2026-08-18 runtime-verification 文档 + 手动安装 4 次验证（240-304s 全成功）覆盖。
- 托盘菜单为原生菜单（Playwright 无法点击）：E2E-06 通过 HULL_E2E 测试钩子（main 侧全局 __hullTest：openSettings/openMain/quit/trayMenu）驱动入口 + 读菜单 items 校验禁用态；钩子仅 HULL_E2E=1 时暴露，生产零影响。
- userData 隔离：HULL_USER_DATA env 在单实例锁之前 app.setPath（锁基于 userData 目录）；verify-acceptance.mjs 已同约定读取。
- 窗口标题断言改 URL+HTTP（见上 bug 4）——真实 dsh UI 有自身 <title>，「Hull — ready」为就绪瞬间设计标题，官方页加载后会被页面标题覆盖。

#### 运行结果
- `npm run typecheck`（tsc --noEmit）：干净
- `npm test`（219 单元 + 8 集成）：227 pass / 0 fail
- `npm run test:e2e`：7 pass / 0 fail（51.5s 全量）
- 遗留：无（退出清理后 ps 零残留，含 fake dsh 进程组）

### 文件清单（S7 主体）
- `tests/fixtures/fake-dsh.js` — fake dsh 脚本（行为矩阵 FAKE_DSH_MODE env：ready 默认〔http server 随机端口 + 就绪行〕/ slow〔延时〕/ bad-addr〔就绪行指向 :1〕/ crash〔就绪行后非零退出〕；参数与真实 dsh CLI 同构 `web --host 127.0.0.1 --port 0`；就绪行匹配 S1 READY_LINE_RE）
- `tests/integration/readiness.test.ts` — 集成测试（spawnFn DI 主路 + symlink 补验路 + Q-010 坏地址注入 + crash child-exited + 格式断言）
- `scripts/verify-acceptance.mjs` — 10s 验收段分解参考（[timing] t0~t4 段耗时 + 总时长；不设 PASS/FAIL 阈值〔B1〕；失败处理：缺段 → FAIL + segment 诊断 / 无日志 → FAIL + 先跑 e2e〔B4〕）
- `package.json` — scripts 四项（test:unit / test:integration / test:e2e 占位〔B6 骨架推迟〕/ verify:acceptance）
- `tsconfig.tests.json` — tests/ 独立编译（rootDir "." → dist-tests/，import 的 src 文件随编译，不破坏主 build dist/ 布局）

### TDD：8 新用例（fake-dsh 4 模式 + 双路 spawn + Q-010 注入 + 格式断言），S1-S6 219 回归 → 227 全绿

核心路径全测：fake-dsh ready 就绪行命中 + URL 提取 + HTTP 200 / slow 延迟出现 / bad-addr 坏地址 / crash 非零退出 / spawnFn DI 主路（fake-dsh → RuntimeManager ready）/ symlink 补验路（临时 overlay + bin/dsh symlink → 真实 spawn 就绪）/ HULL_PROBE_TARGET 坏地址注入（Q-010）→ start-timeout → failed / 就绪行格式与 READY_LINE_RE 匹配

### 质量
- `npm run typecheck`（tsc --noEmit）：干净
- `npm test`：227 pass / 0 fail（219 单元 + 8 集成），~1.5s
- `npm run build`：dist/ 全量产出

## 核验记录

### Code Review
- 双席 AI review（oracle 通过 🟡×2 注记级 / gamma 通过 🟢×3）——无阻断项，🟡 折入风险登记
- 修复 1 项（实现期自修）：集成测试 5s 挂起——RuntimeManager 默认 sleep 的 kill 宽限 5s 定时器在 child 退出后仍挂起拖住进程退出（S2 npmRunner 测试 ⑥ 同款）→ 注入即时 sleep

### Semgrep
- 1.172.0 自动配置 261 规则、51 文件扫描：0 findings

### 契约符合性
- **U3-01~07**（状态机 + 残留检测）：S1~S6 用例已覆盖（Updater ①~⑱ + OverlayManager ensure ⑬⑭⑮ 回归）+ 集成层补 spawn 串联（⑤⑥）
- **U4-01~03**（版本比较）：S3 semver 用例已覆盖（①~⑪ 回归）
- **E2E-01~07+**：✅ 全部落地（2026-08-18 收尾，见上「S7 收尾」节——7 场景全绿）
- **Q-009**（10s 总时长含 dsh）：E2E-01 权威（实测 960-1120ms）+ verify-acceptance 段分解参考（B1）
- **Q-010**（坏版本注入）：HULL_PROBE_TARGET 注入（⑦ 集成测试 + E2E-04 端到端自动回滚 + S1 ReadinessProbe 构造读 env）

### 环境阻塞
- ~~electron 二进制未下载~~ —— ✅ 已解除（2026-08-17/18 curl npmmirror 直下解压，见 runtime-verification）
- ~~真实 @deepseek-ai/dsh 包 registry 可达性待验证~~ —— ✅ 已解除（08-18 实测 200/0.78s；E2E-02 用本地假源规避网络波动，真实安装路径由 runtime-verification 覆盖）

### 风险登记
- **🟡-1**：⑥「argv 顺序验证」表述修正——顺序由 spawnArgs.test.ts 单元层保证，⑥ 定位为真实 spawn 链路验证（argv 顺序经 fake-dsh 同构接收间接覆盖）
- **🟡-2（S7 收尾项）**：~~electron 二进制就绪后——引入 Playwright devDependency + 建 playwright.config.ts + 实现 E2E-01~07+（含托盘/设置页场景组）~~ ✅ 完成（2026-08-18）
- **🟢**：FAKE_DSH 路径依赖编译产物结构（dist-tests/tests/integration → 项目根解析，注记——结构变更需同步）
- **🟢**：测试⑤⑥ 无显式 start() 超时（sleep 注入下 ~15s 探测窗口上限可接受，注记）
- **🟢（新增）**：E2E-02 registry 注入模拟偏离（真实 registry 网络波动 >590s；本地假源确定性秒级，真实路径另档覆盖——见上偏离注记）
