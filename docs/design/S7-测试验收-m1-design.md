# S7 测试与验收体系 技术方案

> 工作项：S7 测试与验收体系（飞书 dsh-hull-desktop 清单）
> 状态：已冻结（多方复评通过，2026-08-17）
> 版本：0.2 · 2026-08-17
> 事实源：契约 `docs/api/feishu-s7-m1-api-contract.md` v0.2（已冻结）；共识 `docs/spec/共识-Hull桌面壳-M1.md` v1.4（Q-009/Q-010、CON-R015）；S1~S6 设计（测试分层/埋点/注入点）
> 判级：复杂。理由：测试体系搭建（分层）+ 跨层验证（单元/集成/e2e/验收）+ 外部依赖（electron 二进制/dsh 包/registry）；无安全敏感面（测试代码不碰生产安全面）
> 偏离契约/共识处统一标注：⛔️ 见 §8 对照表

---

## 1. 背景与范围

**定位**：S7 测试与验收体系——单元（S1~S6 已 219 用例 node:test 覆盖〔B7：预估数，实现时核实际〕）+ 集成（真实 spawn/就绪）+ e2e（Playwright electron）+ 10s 验收测量（Q-009 总时长含 dsh）。

**规则绑定**：Q-009（10s 验收 = 总时长含 dsh 启动，测量口径明确）、Q-010（坏版本注入 = 就绪探测目标/超时配置注入，不改业务代码）、CON-R015（就绪判定：就绪行 + HTTP 探测，探测目标/超时可注入）。

**范围**（契约 §范围，冻结）：单元测试（升级状态机迁移合法性、VersionCompare prerelease、SwapManager 残留检测恢复、SettingsStore 校验）；集成测试（真实 spawn dsh + 就绪判定，探测目标可注入）；坏版本注入（Q-010 → 自动回滚路径）；Playwright _electron e2e（启动→首装→升级全流程→回滚）；10s 验收测量（Q-009 含 dsh 启动）。

**非目标**（契约 §非目标）：三平台测试矩阵（后续里程碑）、dsh 官方自身的测试。

**交付验收**：U3-01~07（状态机 + 残留检测）/ U4-01~03（版本比较）/ E2E-01~07+（e2e 全流程含托盘/设置页场景组）+ 10s 验收。

**环境阻塞**（本设计必列）：
- **electron 二进制未下载**（github.com 主站 + npmmirror 均不可达）——e2e/集成真实运行段阻塞；恢复命令 `ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ node node_modules/electron/install.js`
- **真实 @deepseek-ai/dsh 包 registry 可达性待验证**（契约协调事项：e2e 首次测试环境需 registry 可达）——fake dsh 兜底（D2）

**范围剪裁说明（YAGNI）**：vitest 不引入（D1 裁决点，单元层已 node:test 覆盖）；三平台矩阵不预做；dsh 官方测试不重复。

---

## 2. 架构决策（含备选）

### D1 测试框架裁决点（⛔️ 偏离 1，评审裁）

契约要求 vitest，但 S1~S6 已 219 用例在 node:test（S1 设计 §5「vitest 归 S7」但实现已覆盖单元层）：
- **A**：引入 vitest（契约字面，219 用例迁移 + 双框架并存）
- **B**：**沿用 node:test**（单元层已覆盖，vitest 引入是重复建设 YAGNI）→ **倾向 B，标注评审裁**

理由：219 用例已在 node:test 全绿（状态机/版本比较/残留检测/设置校验——契约 U3/U4 场景全部已覆盖）；vitest 引入 = 迁移成本 + 双框架维护，无新增覆盖价值。契约修订注记「单元层沿用 node:test，vitest 不引入」（D7）。

### D2 集成测试（⛔️ 偏离 2）

真实 spawn dsh：
- **A**：真实 @deepseek-ai/dsh 包（registry 可达性未知 + 不可控）
- **B**：**fake dsh 脚本**（`tests/fixtures/fake-dsh.js`：输出就绪行 + 可注入坏行为/坏地址/慢启动——Q-010 注入可控）→ **选 B**

理由：可控（坏行为/坏地址/慢启动全注入）+ 不依赖 registry（环境阻塞下可跑）；真实包端到端标注待 registry 可达（契约协调事项）。

### D3 e2e

Playwright `_electron`——需要 electron 二进制（缺失）。搭建 Playwright 配置 + 写 e2e 场景（E2E-01~07+）+ 注记「待 electron 二进制」；Playwright 引入 devDependency（契约要求）。

### D4 10s 验收（B1/B2/B4 修订）

**B1 验收口径**：**E2E-01（Playwright 完整冷启动计时）为 Q-009 权威**；`verify:acceptance` 定位为 **dsh 段分解参考**（t0→t1 spawn / t1→t2 就绪行 / t2→t3 探测 / t3→t4 UI 加载各段耗时），**不单独作 PASS/FAIL 判据**。

**B2 [timing] 埋点格式锁定**（引用 S1 实现——已核验全部存在）：
```
[timing] t0 start entry          # RuntimeManager.ts
[timing] t1 spawn <ms>ms         # RuntimeManager.ts
[timing] t2 ready-line <ms>ms    # RuntimeManager.ts（probe onReadyLine）
[timing] t3 ready <ms>ms         # RuntimeManager.ts（注：名为 ready，非 probe-ok——verify-acceptance 按实际格式解析）
[timing] t4 did-finish-load      # WindowManager.ts
```

**B4 verify-acceptance 失败处理**：
```
日志存在缺特定 [timing] 段 → FAIL + 「segment X 日志缺失」
日志完全不存在 → FAIL + 「e2e 日志未找到——先跑 e2e」（A4：不启动 electron，依赖 e2e 已产日志）
```

### D5 坏版本注入（Q-010）

`HULL_PROBE_TARGET` 注入——集成测试覆盖（fake dsh + 注入坏地址 → 就绪失败 → 自动回滚路径）；不改业务代码（S1 ReadinessProbe 构造读 env，Q-010 已落）。

### D6 测试分层

单元（node:test 沿用 219 用例）+ 集成（tests/integration，fake dsh spawn/就绪/overlay 安装）+ e2e（tests/e2e，Playwright，待 electron）+ 验收（verify:acceptance 脚本）。

### D7 契约修订

版本指针 v1.4 + vitest 不引入注记（若裁 B）+ 测试分层注记（node:test 单元层 + Playwright e2e）。

---

## 3. 模块划分

| 模块 | 职责 | 依赖 | 契约接口 |
|---|---|---|---|
| `tests/fixtures/fake-dsh.js` | fake dsh 脚本（就绪行输出 + 注入点：坏地址/慢启动/崩溃） | — | 集成测试支撑 |
| `tests/integration/*.test.ts` | 集成测试（spawn fake dsh + 就绪判定 + overlay 安装 + 坏版本注入回滚） | S1~S6 模块 | #2 |
| `tests/e2e/*.spec.ts` + `playwright.config.ts` | e2e 场景（E2E-01~07+，待 electron） | Playwright | #3 |
| `scripts/verify-acceptance.mjs` | 10s 验收测量（读 hull.log t0~t4） | — | #4 |
| `package.json` scripts | test:unit / test:integration / test:e2e / verify:acceptance | — | #1~#4 |

**依赖方向**（单向）：`tests/integration → {S1~S6 模块, fake-dsh}`；`tests/e2e → Playwright`；`verify-acceptance → hull.log`。

---

## 4. 关键机制实现形态

### 4.1 fake-dsh.js 行为矩阵（D2）

```
fake-dsh.js（env 或参数注入行为）：
  FAKE_DSH_MODE=ready      → 输出就绪行 `dsh web: http://127.0.0.1:<port>` + 起 HTTP 200 服务
  FAKE_DSH_MODE=slow       → 延迟 N ms 后输出就绪行（慢启动，Q-009 预算内/外可控）
  FAKE_DSH_MODE=bad-addr   → 输出就绪行但地址指向坏端口（Q-010 坏版本注入 → 探测失败）
  FAKE_DSH_MODE=crash      → 输出部分输出后非零退出（崩溃路径）
  默认：node tests/fixtures/fake-dsh.js（spawn 参数与真实 dsh 同构：node --expose-internals fake-dsh web --host 127.0.0.1 --port 0）
```

### 4.2 集成测试用例（D2/D5 + B3 双路）

```
tests/integration/：
  主路（spawnFn DI 注入 fake-dsh 路径——S1 已支持）：
    spawn fake dsh（ready）→ ReadinessProbe 就绪 → RuntimeManager ready（T1-01 单元级）
    spawn fake dsh（bad-addr）+ HULL_PROBE_TARGET 注入坏地址 → 就绪失败 → failed → 自动回滚路径（Q-010）
    spawn fake dsh（crash）→ starting 中退出 → failed(child-exited) 立即
    overlay 安装（fake npm 注入）→ swap → 版本校验（S2 集成）
  补验路（真实 spawn 路径验证）：
    临时 overlay + bin/dsh symlink → fake-dsh（验证真实 spawn 参数/就绪行解析链路）
```

### 4.3 verify-acceptance 脚本（D4）

```
scripts/verify-acceptance.mjs：
  读 <userData>/logs/hull.log → 提取 t0/t1/t2/t3/t4 埋点时间戳
  计算总时长 = t4 - t0（含 dsh 启动，Q-009 口径）
  输出各段耗时（t0→t1 spawn / t1→t2 就绪行 / t2→t3 探测 / t3→t4 UI 加载）+ 参考对比（E2E-01 权威），不设 PASS/FAIL 阈值（B1）
  不依赖 electron 运行（读日志文件）
```

### 4.4 e2e 场景骨架（D3 + B5/B6/B8，待 electron）

```
tests/e2e/（Playwright _electron，待 electron 二进制）：
  B5 userData 隔离：Playwright launch --user-data-dir 临时目录（CON-R002 精神：永不触碰真实用户数据）
  B6 骨架推迟注记：electron 就绪后一次性创建（设计保留全部 e2e 设计，仅代码创建时点后移）
  B8 E2E-02 首装真实 registry 依赖注记：阻塞面确认，解封项（registry 可达后跑）
  E2E-01 冷启动：启动 → UI 可交互 → 总时长记录 ≤10s（Q-009 权威口径）
  E2E-02 首装+取消：引导态 → 安装 → 取消 → 引导态 → 重装成功
  E2E-03 升级全流程：检查 → 确认 → 安装 → 替换 → 验证 → 版本变化 + 数据无损
  E2E-04 坏版本注入：HULL_PROBE_TARGET 坏地址 → 自动回滚 → 可用
  E2E-05 退出清理：退出 → ps 检查零残留
  E2E-06 托盘：打开主窗口/设置入口/升级中禁用（覆盖 T6-04/T1-06）
  E2E-07+ 设置页场景组：T6-01 registry 持久化 / T6-03 关闭即退出 / T6-05 校验提示
```

---

## 5. 工程基线

**判级**：复杂（与头部一致；无安全敏感面）。

| 项 | 现状 | S7 动作 |
|---|---|---|
| git | 已有 | 直接复用 |
| 脚手架 | S1~S6 完成（TS + Electron 43 + tsc 构建） | 跟随；**新依赖 Playwright**（契约要求，devDependency）；**vitest 裁决点（D1，倾向不引入）** |
| 测试框架 | node:test（219 用例） | 单元层沿用；新增集成（node:test）+ e2e（Playwright）+ 验收脚本 |
| 脚本 | build/typecheck/test/dev | 新增 test:unit / test:integration / test:e2e / verify:acceptance |

**S1~S6 复用清单**：ReadinessProbe Q-010 注入（S1）、Logger t0~t4 埋点（S1）、RuntimeManager/Updater/OverlayManager 状态机（S1~S3）、fake npm 注入模式（S2）、node:test 219 用例（S1~S6）。

---

## 6. 目录/工程结构（新增部分）

```
dsh-hull-desktop/
├── tests/
│   ├── fixtures/
│   │   └── fake-dsh.js            # fake dsh 脚本（行为矩阵注入）
│   ├── integration/
│   │   └── *.test.ts              # 集成测试（spawn fake dsh + 就绪 + overlay + 回滚）
│   └── e2e/
│       └── *.spec.ts              # e2e 场景（E2E-01~07+，待 electron）
├── playwright.config.ts           # Playwright _electron 配置
├── scripts/
│   └── verify-acceptance.mjs      # 10s 验收测量（读 hull.log t0~t4）
└── package.json                   # scripts：test:unit / test:integration / test:e2e / verify:acceptance
```

---

## 7. 风险与对策

| 风险 | 影响 | 对策 | 归属 |
|---|---|---|---|
| electron 二进制缺失 | e2e/集成真实运行阻塞 | 注记 + 恢复命令（ELECTRON_MIRROR）；e2e 场景先写后跑 | S7 |
| 真实 dsh 包 registry 可达性 | 集成/验收真实段阻塞 | fake dsh 兜底（D2，可控 + 不依赖 registry）；真实包端到端标注待 registry | S7 |
| 10s 验收口径（Q-009 含 dsh） | 测量偏差 | t0~t4 埋点（S1 已备）+ verify-acceptance 读日志计算 | S7 |
| Playwright 引入体积 | 依赖膨胀 | devDependency 仅测试；不引生产 | S7 |
| vitest 裁决（D1） | 框架重复建设 | 倾向不引入（node:test 已覆盖），评审裁 | S7 |

---

## 8. 契约/共识对照与偏离标注

| # | 偏离点 | 契约/共识原文 | 设计取值 | 理由 |
|---|---|---|---|---|
| 1 | vitest 不引入（设计保留标注，评审裁） | 契约测试分层：单元/集成用 vitest | 单元层沿用 node:test（S1~S6 已 219 用例覆盖 U3/U4 全部场景）；vitest 不引入 | 219 用例已在 node:test 全绿，vitest 引入 = 迁移 + 双框架维护，无新增覆盖价值（YAGNI）；契约修订注记（D7） |
| 2 | 集成测试用 fake dsh 脚本（设计保留标注） | 契约集成测试：真实 spawn dsh | fake dsh 脚本（行为矩阵注入：就绪/慢启动/坏地址/崩溃） | 可控（Q-010 注入）+ 不依赖 registry（环境阻塞下可跑）；真实包端到端标注待 registry 可达 |

> 注记（信息滞后型偏离）：偏离 1（vitest）早于 S1 评审裁决（S1 §5「vitest 归 S7」时未预判 node:test 已覆盖单元层）；偏离 2（真实 dsh）受环境阻塞（registry 可达性待验证）——均非设计主动偏离，登记供契约修订追溯。

**非偏离的契约忠实点**：分层测试（单元/集成/e2e/验收）；Q-010 坏版本注入（HULL_PROBE_TARGET，不改业务代码）；Q-009 10s 总时长（含 dsh 启动，t0~t4 埋点——E2E-01 权威，verify-acceptance 段分解参考）；Playwright _electron e2e（E2E-01~07+）；U3-01~07 / U4-01~03 场景（node:test 已覆盖，S7 补集成层）；verify:acceptance 脚本（#4，依赖 e2e 已产日志）。

**U3/U4/E2E 场景 → 落点对照**：
- U3-01~04（状态机合法/非法/取消/验证失败）：S3 Updater 用例已覆盖（①~⑱ 回归）
- U3-05~07（残留检测）：S2 OverlayManager ensure 用例已覆盖（⑬⑭⑮ 回归）
- U4-01~03（版本比较）：S3 semver 用例已覆盖（①~⑪ 回归）
- E2E-01~07+：tests/e2e 场景骨架（D3，待 electron 二进制）
- 10s 验收：verify-acceptance 脚本（D4，读 hull.log t0~t4）
