# B-备份-backup 实现记录（B1~B5）

> 需求：`backup` · 分支：`feature/backup` · 日期：2026-09-17
> 依据：共识 v1.2（CON-R-backup-001~016）· 契约 `docs/api/feishu-backup-api-contract.md`（已冻结）· 技术方案 `docs/design/B-备份-backup-design.md`（已冻结）

## 一、范围与产物

| 子需求 | 产物 |
|:-------|:-----|
| B1 备份引擎与门控 | `src/backup/{errors,scope,manifest,gate,backupService}.ts`（+ 4 测试文件） |
| B2 恢复（校验/运行期/启动期） | `src/backup/{result,validators,restoreService,restoreExecutor}.ts`（+ 3 测试文件）；migrate 纯函数抽取（SettingsProvider/KanbanStore） |
| B3 合并引擎（7 类） | `src/backup/merge/{conflicts,index,kanban,notes,settings,workflows,notifications,skills}.ts`（+ 8 测试文件） |
| B4 IPC + UI + 接线 | `src/backup/BackupIpc.ts`；`src/shared/ipc-channels.ts`（+4 通道）；`src/preload/index.ts`；`src/main/index.ts`（启动期执行器挂载/门控/互斥/退出编排复用）；`src/renderer/shell.html`（数据卡）；`src/renderer/skills.js`（路径失效消费） |
| B5 测试与验收 | `tests/integration/backup/**`（16 用例）；`tests/e2e/backup.spec.ts`（4 用例）；验收 5 条断言可自动判定 |

## 二、验证留痕（证据）

| 项 | 命令/方式 | 结果 |
|:---|:----------|:-----|
| 类型检查 | `npx tsc --noEmit` | **0 error** |
| 单元测试 | `npm run test:unit` | **1212/1212 pass**（其中 backup 模块 123 用例） |
| 集成测试 | `node --test dist-tests/tests/integration/**/*.test.js` | **24/24 pass**（含备份 5 / 恢复守卫 7 / 自愈与合并 4 + 既有） |
| e2e | `npx playwright test tests/e2e/backup.spec.ts` | **4/4 pass**（happy replace / 高版本拒绝 / 半成品自愈 / merge；`HULL_USER_DATA` 隔离 + `HULL_E2E` 注入） |
| Code Review | ocr CLI 未配置 LLM（超时）→ 降级 oracle 评审（团队既有机制） | **4 轮**：首轮 🔴4+🟠7 → 修复；复验 🔴2+🟠1 → 修复；三验 🔴1 → 修复；四验通过 |
| Semgrep | `semgrep scan --config auto`（src/backup + main/preload/skills.js） | **0 findings** |
| Lint | 仓库无 lint 脚本（tsc 即门禁） | 降级记录 |

## 三、评审轮次与修复

| 轮 | 发现 | 修复要点 |
|:--|:-----|:---------|
| 1 | 🔴R1 换机缺项误判 manual / 🔴R2 回滚续做删已还原项 / 🔴R3 成功残留 backup 触发静默全量回滚 / 🔴R4 notes 非 md 致包不可恢复；🟠O1~O7（skills 升级门控/更新入口互斥/restart 门控/disabled 实体/notif 归类/回滚删除集/包移动可用性）；🟡Y1~Y9 | 全部修复（含 notes .md 过滤、skills/disabled part、canRestart、guardUpdateEntry、退出编排复用、incoming 优先、manifest 本地副本） |
| 2 | 🔴N1 新请求删唯一副本 / 🔴N2 半应用死锁；🟠N3 回滚残留；🟡对称性/校验口径 | orphan 保留改名、删 manual 守卫、回滚 copy 式、replace 实体标注、trash sizeBytes |
| 3 | 🔴N3-1 `#3` 补齐通道全量覆盖当前数据 | **repair-only**（只补缺失不删不覆盖）+ sourceDir 回退不删 |
| 4 | — | **通过**（可进入交付核验） |

## 四、设计级偏离（有意为之，已回写方案）

| # | 偏离 | 理由 |
|:--|:-----|:-----|
| D1 | replace 应用用 **copy** 而非 move（incoming 保留至收尾）；verified 以 incoming 复校验 | 守卫断言会命中 stagedRoot=userData 下的 `.restore`；copy 语义使复校验可重复且幂等 |
| D2 | 显式回滚步骤 2 用 **copy**（预备份不消费） | rename 消费导致回滚续做丢已还原数据（复验实锤）；copy 使任意崩溃点重跑收敛 |
| D3 | `#3`（无 pending 补齐）**repair-only** | 设计原语义即「补齐缺失项」，原实现为覆盖（复验实锤）；repair-only 同时化解旧备份驻留风险 |
| D4 | 决策表 #10 收紧为「backup 与 incoming 均缺失且 step ≥ backedUp」 | "两处皆无"的包内独有项在 copy 式回滚下安全可续，不再 manual |
| D5 | 新增 `hull:restart` 通道（契约原 3 通道） | 共识 013「立即重启并恢复」需要重启原语；门控对齐 + 复用既有退出编排；契约变更记录 v1.1 同步 |

## 五、已知债务 / v2 候选（核验登记）

- R11 `backup-orphan-<ts>/` 仅建不清理（异常态产生；v2 数据卡清理入口）
- R12 repair-only 复用 `status='rolledBack'`（未区分「补齐」）
- R13 成功归档仅保留最新 1 个（上轮 `result.bakDir` 崩溃窗口可能悬空）
- R14 显式回滚后活跃 `backup/` 保留（copy 语义必然；`#3` 已 repair-only 无覆盖风险）
- e2e 门控场景未跑（gate 分支单测覆盖；DOM 置灰端到端缺）
- ENOSPC 以注入失败等价覆盖（真实卷未构造）
- Windows 长路径/占用（设计 §8 R6，v2）
- 看板附件无实体（无内容可迁，契约已登记）；`kanban/attachments` 引用-only

## 六、交付核验结论（三层）

| 层 | 对照 | 结论 |
|:---|:-----|:-----|
| 设计核验 | 实现 vs 技术方案（含 D1~D5 偏离显式记录） | **通过**（偏离已回写） |
| 契约核验 | 实现 vs 契约（4 通道 / 数据格式 / 错误码 / 12 联调场景） | **通过**（契约变更记录 v1.1 同步） |
| PRD/业务核验 | 实现 vs PRD（备份/恢复/入口/边界）+ 判级匹配 | **通过**（复杂判级 → design 已产 + TDD 核心路径；无 PRD 阻断） |
| UI 视觉核验 | `docs/ui/UI规范.md` | **跳过 + 记录风险**（规范文件不存在；UI 复用既有组件/令牌） |
| 实现纪律 | TDD / lint / review / semgrep / 留痕 | TDD ✅（状态机/校验器/merge 先测后写）· lint 降级（无脚本）· review ✅（4 轮）· semgrep 0 · 留痕=本文 |

> 结论：**交付核验通过**；ticket 置 Verify 待用户验收 → 用户验收后走 PR 合并（teamflow git-pr）。

## 附录：测试缺口补齐记录（2026-09-17，用户要求）

用户复核"测试都覆盖了吗"→ 实测覆盖率暴露 3 处缺口 → 三路并行补齐：

| 缺口 | 补齐方式 | 结果 |
|:---|:---|:---|
| e2e 门控场景缺失 | `HULL_E2E_FORCE_GATE=backup-busy` 测试钩子（仅 HULL_E2E=1）+ 第 5 条 e2e（置灰 + 原因 + 主进程强制拒绝零写入） | e2e **5/5** |
| BackupIpc handler 无单测 | 重构成 `createBackupHandlers(deps)` 纯工厂（`isE2E` 注入，行为不变）+ **27 条**用例 | BackupIpc **94.6% / 分支 100%** |
| merge 三模块分支覆盖低 | **15 条**边界用例（settings 归一化全字段非法回退 / skills 实体与并集边界 / notes 改名递增与回收站） | settings **100/100** · skills **100/100** · notes **99.4/95** |

补齐后覆盖率（行/分支，unit + integration 触达口径）：
- 100% 行覆盖：errors · scope · result · conflicts · gate · manifest · settings · skills · workflows · notifications
- 其余：restoreExecutor 88.4/73.9 · validators 96.0/87.6 · BackupIpc 94.6/100 · restoreService 94.0/62.9 · backupService 86.7/69.8
- 残余未覆盖：restoreExecutor 防御分支 + restoreService 错误路径（非主干风险，登记债务）

全量回归（补齐后）：tsc 0 error · unit **1254/1254** · integration 24/24 · e2e 5/5 · semgrep 0 findings。
