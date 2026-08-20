# S7 经验沉淀：验收权威口径单一 与 测试替身真实链路分层

> 三硬标准：可复用 / 非显而易见 / 有代价（均通过）
> 来源-出生：S7 测试与验收体系（dsh-hull-desktop）· 来源 PRD：2026-08-14-m1-prd.md
> 来源-引用：实现与评审期

---

## Lesson 1：验收权威口径必须单一——测量脚本 vs 权威判定分离

### 现象
verify-acceptance 初稿设 PASS/FAIL 阈值（t4-t0 ≤ 10s）。评审 oracle 抓出：**t0 是 RuntimeManager.start() 入口（ensure 之后）**——t4-t0 不含壳启动 ~1s，Q-009「总时长（含 dsh 启动）」口径下会**误判 PASS**（实际超 10s 却显示 ≤10s）。

### 根因
测量脚本把「段分解参考」当成了「权威判定」——t0~t4 埋点只覆盖 dsh 启动段（RuntimeManager 起），不含壳自身启动（单实例锁/兜底清理/ensure/窗口创建）。Q-009 的「总时长」是用户感知的完整冷启动，埋点段只是其中一部分。

### 对策
- **权威口径单一**：E2E-01（Playwright 完整冷启动计时）为 Q-009 权威；verify-acceptance 定位段分解参考（t0→t1 spawn / t1→t2 就绪行 / t2→t3 探测 / t3→t4 UI 加载），**不设 PASS/FAIL 阈值**
- **埋点格式与实现锁定对齐**：[timing] 前缀 + t0~t4 命名（t3 名为 ready 非 probe-ok）——verify-acceptance 按 S1 实际格式解析，评审波核验实现已存在（无需变更传播）
- 失败处理显式化：缺段 → FAIL + segment 诊断；无日志 → FAIL + 先跑 e2e（防静默空跑）

### 代价
- 权威判定依赖 e2e（electron 就绪后）；若误设阈值流入，验收会假绿——单一权威 + 分解参考分离是必要成本

---

## Lesson 2：测试替身与真实链路分层——「同构 + 可控」替身 + 解封项显式登记

### 现象
集成测试需要真实 spawn dsh，但真实 @deepseek-ai/dsh 包 registry 可达性未知 + 不可控（坏行为/慢启动/崩溃无法注入）。fake-dsh 脚本（行为矩阵 FAKE_DSH_MODE env：ready/slow/bad-addr/crash）与真实 dsh CLI 同构（`web --profile web --host 127.0.0.1 --port 0`），就绪行匹配 S1 READY_LINE_RE。

### 根因
真实依赖（dsh 包）在测试环境不可控——坏版本注入（Q-010）需要「就绪行指向坏地址」这类行为，真实包无法按需触发。测试替身若与真实 CLI 不同构，会测出「假链路」（替身行为 ≠ 真实行为）。

### 对策
- **替身设计「同构 + 可控」**：fake-dsh 参数与真实 dsh CLI 同构（顺带验证 spawnArgs argv 顺序）+ 行为矩阵 env 注入（Q-010 坏地址/慢启动/崩溃全可控）
- **双路分层**：spawnFn DI 主路（替身测逻辑——RuntimeManager 就绪判定）+ symlink 补验路（真实 spawn 链路验证——临时 overlay + bin/dsh symlink → fake-dsh，验证 spawnArgs argv 顺序 + 就绪行解析链路），各司其职
- **真实依赖解封项显式登记**：真实 @deepseek-ai/dsh 包端到端（E2E-02 首装）标注「待 registry 可达」——替身兜底不掩盖真实依赖缺口

### 代价
- fake-dsh 维护成本（行为矩阵随测试需求扩展）；若替身与真实行为漂移（dsh 就绪行格式变更），集成测试假绿——就绪行格式由 spawnArgs.ts 单点收敛（S1 设计），变更即回归

---

## 附：S7 收尾项（electron 就绪后）
- 引入 Playwright devDependency + playwright.config.ts + 实现 E2E-01~07+（含托盘/设置页场景组）
- 恢复命令：`ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ node node_modules/electron/install.js`
- 真实 @deepseek-ai/dsh 包 registry 可达性验证（E2E-02 首装解封项）
