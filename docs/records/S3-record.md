# S3 实现记录与核验记录

> 判级：复杂+安全敏感（7 态升级状态机 + 跨模块编排（Updater/SwapManager/UpgradeQueue ↔ S2 OverlayManager/S1 RuntimeManager）+ 自动回滚 + 崩溃恢复 + 双通道互斥 + 外部系统 registry 检查）
> 事实源：契约 `docs/api/feishu-s3-api-contract.md` v0.2（冻结 2026-08-17）、设计 `docs/design/S3-dsh升级-design.md` 0.2（冻结 2026-08-17）

## 实现记录

### 文件清单
- `src/updater/Updater.ts` + 测试 — 7 态状态机（TRANSITIONS 照契约 + idle→rollback 补充边〔W3〕）+ check（自身 scope acquire/release〔gamma〕）+ upgrade（独立 acquire + B1 swap 后 phase 校验 + B2 verify 并入 start）+ 自动回滚（三步 + B3 注入生命周期 + B11 版本回写 + 🟢-B 语义）+ cancel（仅 installing）+ rollback（canRollback 前置）+ inFlightUpgrade（B8）+ 错误码域映射
- `src/updater/SwapManager.ts` + 测试（经 Updater.test）— 纯映射薄层（B13）：一行委托 swap/swapBack + B6 域映射（swap-recovered 内部码）+ canRollback 委托 + UPGRADE_ERRORS 八码
- `src/updater/registry.ts` + 测试 — HTTP registry 检查（encodeURIComponent 包名 + dist-tags.latest + /latest fallback + CHECK_TIMEOUT_MS=10s + AbortController + check-failed 语义）
- `src/updater/DismissStore.ts` + 测试 — dismiss.json 当日去重（原子写 + 读/写失败无害降级）
- `src/updater/UpgradeQueue.ts` + 测试 — 单槽互斥（acquire/release/inFlight，S5 复用）
- `src/updater/semver.ts` + 测试 — 最小 semver compare（prerelease 感知，零依赖）
- `src/overlay/OverlayManager.ts` — `swapBack()`（S2 契约 #10 变更传播代码落地：① dsh→staging 保留现场 ② previous→dsh ③ symlink 重建 ④ 版本回读）+ `canRollback()`（W3 数据源）
- `src/main/index.ts` — S3 装配（queue→SwapManager→Updater）+ 托盘入口 runCheck + 原生 dialog 确认/失败/回滚提示（B7/🟢-B）+ 启动自动检查（🟢-2 + DismissStore 门控）+ quitting 扩展（B8/D12：installing 段 cancel / swapping+ 段 await inFlightUpgrade 90s 上限）+ hull:checkForUpdates IPC（S6 预留）
- `src/tray/TrayController.ts` — 「检查更新…」菜单 + tooltip 合并（升级中 phase+pct 优先）
- `src/shared/types.ts` — UpgradePhase 枚举 + UpgradeStatus（契约字段 + message 扩展）

### TDD：55 新用例（Updater 20 / swapBack 6 / semver 11 / registry 7 / DismissStore 6 / UpgradeQueue 5），S1+S2 97 回归 → 152 全绿

> 注：骨架预估 52（Updater 18+修复），实测 55（Updater 20 = 18 + 评审修复新增 Y-1/Y-2；S1+S2 回归实测 97 非 100），总数 152 一致。

核心路径全测：全链路调用序（install→stop→swap→start）/自动回滚序（verify-start→stop→swapBack→恢复 start）/注入生命周期两段（HULL_PROBE_TARGET）/queue 互斥与 queue-busy/check 无闪事件/cancel 窗口（installing 可取消、swapping 忽略）/swapBack 四步与三态失败/semver prerelease 规则全集/registry 超时与 /latest fallback/DismissStore 读写降级/状态机非法迁移 dev throw

### 质量
- `npm run typecheck`（tsc --noEmit）：干净
- `npm test`：152 pass / 0 fail，~0.7s
- `npm run build`：dist/ 全量产出（35 js）

## 核验记录

### Code Review
- 双席 AI review（oracle 通过 + 🟡×3 / gamma 有条件通过 + Y-1/Y-2）→ 修复 7 项（🟡-1 swap-recovered 语义码独立 / 🟡-2 失败 dialog 重试改「重新检查」 / 🟡-3 dismissToday 写失败降级 / Y-1 check 闪事件消除 / Y-2 Updater.canRollback 代理〔契约 #8〕 / 🟢-1 死参数删除 / 🟢-2 成功路径版本回读）→ ora-1 复评「通过」
- 修复全程 TDD：先补/改测试（⑱ 语义改 + Y-1/Y-2/DismissStore ⑥ 新增）再修实现

### Semgrep
- 1.172.0 自动配置 227 规则、39 文件扫描：0 findings

### 契约符合性（T3 场景对照）

| 场景 | 契约要求 | 单元级证据 | 状态 |
|---|---|---|---|
| T3-01 正常升级 | 版本变化 + 数据无损 | Updater ⑥（调用序 + currentVersion=target）+ ①（状态序列） | 单元级 ✓，集成待 electron + 真实 registry |
| T3-02 坏版本注入 | 验证失败→自动回滚→可用 | Updater ⑧⑨⑩（start reject→回滚序 + 注入生命周期 + 版本回写）+ registry ⑤ | 单元级 ✓，集成待 electron |
| T3-03 崩溃恢复 | 替换两步间 kill → 残留自愈 | S2 ensure 态2/3（S2 用例⑭⑮回归）+ quitting 90s 超时 Q-004 注记 | 单元级 ✓（S2），集成待 electron |
| T3-04 取消升级 | 原版本保留 + staging 清理 | Updater ⑬（cancel installing）+ ⑭（swapping 忽略） | 单元级 ✓，集成待 electron |
| T3-05 失败重试 | 可见提示 + 重试成功 | main dialog（B7，electron）+ 🟡-2 重新检查语义；Updater ⑰⑱（swap-broken/swap-recovered） | 单元级 ✓，dialog 集成待 electron |
| T3-06 当日不重复 | 稍后再说当日不提示 | DismissStore ①~⑥（写/读/损坏/旧日期/写失败降级）+ main 门控 | 单元级 ✓，集成待 electron |
| T3-07 互斥 | dsh 升级中 Hull 入口禁用/提示 | UpgradeQueue ①~⑤ + Updater ⑮（queue-busy）+ Y-1（check 无闪事件） | 单元级 ✓，S5 复核注记 |

### 环境阻塞
- electron 二进制未下载（github.com 不可达）；恢复命令：`ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ node node_modules/electron/install.js`
- 真实 registry 检查/升级端到端待网络恢复（T3-01/02/04/06 集成段；registry 测试全为注入桩）
- fetch-node.mjs 下载验证待构建期执行（S2 遗留同源）

### 风险登记
- **🟢-A**：DismissStore logger 未传（main 装配默认 NOOP——补一行 `logger` 注入随 S6）
- **🟢-B**：swap-recovered 失败 dialog 标题口吻（现「升级失败」含已回滚消息——文案打磨随 S6）
- **S6 接线预留**：hull:checkForUpdates IPC / 设置页升级按钮与进度 / canRollback 禁用态 / 手动回滚按钮 / 托盘 tooltip 失败展示 / 手动检查无更新提示（现静默）
- **check 占互斥槽**：check() 短暂占用 'dsh' 槽（自身 scope finally release）——待 S5 HullUpdater 接入时复核互斥粒度（CON-R012 约束对象=升级，check 为查询，gamma 裁决已定，S5 复核注记）
- **quitting 90s 上限**：swapping+ 段等待上限 90s，超时强退 → 半替换残留由 Q-004 ensure 启动自愈（注记，S2 承载）
