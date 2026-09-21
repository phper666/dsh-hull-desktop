# plugin-market 实现记录（P1~P5）

> 需求：`plugin-market` · 分支：`feature/plugin-market` · 日期：2026-09-21
> 依据：共识 v2.1（CON-R-plugin-001~012）· 契约 `docs/api/feishu-plugin-market-api-contract.md`（已冻结）· 技术方案 `docs/design/plugin-market-design.md`（已冻结）

## 一、范围与产物

| 子需求 | 产物 |
|:-------|:-----|
| P1 dsh CLI 通道 + profile | `src/plugins/{cli,profile,types,errors}.ts`（+4 测试） |
| P2 registry 发现与白名单 | `src/plugins/{registry,whitelist}.ts`（+测试）；`assets/plugins-registry-snapshot.json`（4105 条，同源生成）；`scripts/fetch-plugin-snapshot.mjs` |
| P3 安装/更新/卸载编排 | `src/plugins/{manifest,installer,gate}.ts`（+测试） |
| P4 IPC + UI + 接线 | `src/plugins/PluginsIpc.ts`；`ipc-channels`（68→74）；`preload`；`main/index.ts`（装配/门控/hull:showPlugin）；`WindowManager`（view plugin 态）；`shell.html`（nav-plugin + section#plugin）；`src/renderer/plugins.js`（+test） |
| P5 测试与验收 | `tests/fixtures/fake-dsh.js`（plugin mock 扩展）；`tests/fixtures/fake-plugin-registry.js`；`tests/integration/plugins/*`（16 例）；`tests/e2e/plugins.spec.ts`（3 例 5 断言） |

## 二、验证留痕（证据）

| 项 | 结果 |
|:---|:-----|
| 类型检查 | `npx tsc --noEmit` 0 error |
| 单元测试 | **1343/1343**（plugins 模块 60+ 用例） |
| 集成测试 | **40/40**（plugins 16 + 既有 24） |
| e2e | plugins **3/3**（5 断言：安装生效/更新版本/卸载恢复/白名单拒绝/registry 降级）· cold-start **4/4**（nav-plugin 断言） |
| Code Review | oracle 1 轮：🔴2（registry 源不同源 / entryId name 碰撞）+ 🟠4（门控字段/minDshVersion/snapshot 构建/懒加载）+ 🟡11 → **全部修复**（复合键/源统一/版本提示/懒加载/路径穿越/kill 兜底/ensureProfile 接线等 10 项） |
| Semgrep | `--config auto` scoped：**0 findings** |

## 三、评审轮次与修复

| 轮 | 发现 | 修复 |
|:--|:-----|:-----|
| 1 | 🔴 registry 快照与运行时默认源不同源（白名单随网络漂移） | 统一 `awesome-dsh-plugin.com`（与 snapshot 脚本/资产同源）；snapshot 元信息标注 |
| 1 | 🔴 entryId=`name` 碰撞（182 组重名 → 装错插件） | 稳定标识升级 `name#owner` 复合键（whitelist/UI/IPC/installer 全链），补防装错测试 |
| 1 | 🟠 renderer 门控死读 / minDshVersion 无实现 / snapshot 未接构建 / 4105 行全量 DOM | 改读 `c.ok`；preview.versionTooOld 提示链（dshVersion 注入比较）；`pack` 前置 snapshot 脚本；top-100 懒加载 |
| 1 | 🟡 manifest 路径穿越 / cli kill 兜底 / ensureProfile 孤儿 / 搜索文案 | resolve 后 `startsWith(pkgRoot)` 校验；SIGKILL 后 2s 强制 resolve（防 inflight 永久占用）；安装前置 ensureProfile（plugin-profile-missing）；文案改「名称/作者」 |

## 四、设计级偏离（有意为之，已回写/标注）

| # | 偏离 | 理由 |
|:--|:-----|:-----|
| D1 | design §1.8「64→70」通道计数为 68→74 | 计数基线未含 backup 4 通道；断言本身正确（记录） |
| D2 | registry 降级口径：快照兜底返回 `ok:true + source:'snapshot'`（契约文字写「错误码+仍带数据」） | 实现以 source 标记降级更利 UI 分支；契约变更记录注明 |
| D3 | verify 启发式（profileDir 恒真 + list substring 匹配，ponytail 标注） | dsh profile 落盘路径壳侧不可知（不触 DSH_HOME）；以 dsh list 为权威信号 |
| D4 | v1 updatable 死路径（registry 无版本字段 → registryVersion 恒 null） | R6 严格映射 v2；契约口径 |
| D5 | entryId 复合键（超出契约初稿「name」） | 评审实证重名装错风险；已回写契约变更记录 |

## 五、已知债务 / v2 候选

- 插件签名/哈希（U-4/U-5）、严格 versions.json 映射（U-3）、官方桌面壳市场接入（U-2）、dsh 版本差异热挂载（U-6）
- **真实 dsh 参数面未实测**（`dsh plugin add/remove <url|id>` 实参、`--profile` 隐式创建、list 输出结构）——fake-dsh mock 按假设行为；协调事项 R1，实机联调时核对
- 崩溃窗口（add 完成、verify 前退出）→ 下次 reconcile 可见、无 UI 提示（设计 §2.4 语义）
- stderr 2KB 尾部透传可能含路径（设计接受）
- e2e⑤ 与真实快照耦合（生成器失败写空列表 → e2e 误挂风险，已记录）

## 六、交付核验结论（三层）

| 层 | 对照 | 结论 |
|:---|:-----|:-----|
| 设计核验 | 实现 vs 技术方案（含 D1~D5 偏离显式记录 + ponytail 已知简化） | **通过** |
| 契约核验 | 实现 vs 契约（6 通道/9 错误码/12 场景/两段式安装/复合键/懒加载/版本提示） | **通过**（变更记录 v1 同步） |
| PRD/业务核验 | 实现 vs PRD（对接 dsh 生态/白名单/信任明示/双 tab）+ 判级匹配 | **通过**（复杂 → 设计已产 + TDD 核心路径） |
| 实现纪律 | TDD / lint / review / semgrep / 留痕 | TDD ✅（白名单/registry/状态机先测后写）· review ✅（oracle 1 轮全修）· semgrep 0 · 留痕=本文 |

> 结论：**交付核验通过**；ticket P1~P5 置 Verify 待用户验收 → 验收后走 PR 合并（teamflow git-pr）。
