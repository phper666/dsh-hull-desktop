# 通知偏好 V2b（按源开关 + 免打扰）实现与核验记录

> 需求：通知偏好/静音/免打扰（用户 2026-09-03；范围收敛：按源系统通知开关 + 免打扰时段，按工作流静音列候选不做）
> 设计：docs/design/通知中心v2a-notify-service-design.md §八（判级：常规 → 轻量实现）
> 分支：feature/notif-prefs（worktree always）

## 实现记录

### 判级

**常规**——设置字段扩展 + 纯函数策略 + 设置页卡 + systemChannel 一行策略接线；无新子系统。

### 改动清单

| 文件 | 内容 |
|:-----|:-----|
| src/notifications/prefs.ts（+test） | NotifPrefs 类型/默认（双源开关默认开、DND 默认关 22:00→08:00）/normalizeNotifPrefs（逐项非法回退）/inDndWindow（跨午夜支持、含头不含尾、零长窗口=不启用）/shouldSystemPush（源开关+DND；severity 过滤由调用方保证） |
| src/settings/SettingsProvider.ts | HullSettings.notifPrefs 字段级扩展（不 bump schemaVersion，theme 先例）；getSettings/migrate/set 三路径归一化对称（旧文件无字段→默认） |
| src/main/index.ts | notifSystemChannel 推送前 shouldSystemPush 动态读 settings（每次推送取最新，改动即时生效）；不推 ≠ 不入中心（error 照常入中心未读） |
| src/renderer/shell.html | 设置页「通知」卡：工作流/看板执行系统通知开关 + 免打扰开关 + 起止 time 输入（notifPrefs 子对象整体 patch 提交） |
| src/settings/SettingsProvider.test.ts | 归一化（合法透传/非法逐项回退）+ 旧文件默认 + set 写路径归一化（含脏输入 cast 模拟 IPC unknown 载荷）3 用例 |

### 验证

- typecheck ✓；单测 **915/915 绿**（prefs 3 + settings 3 新增/扩展）；e2e 33/33 绿
- DND 边界：跨午夜（22:00→08:00 覆盖 22:00-23:59 与 00:00-07:59）、含头不含尾、零长窗口不启用

### Code Review（AI review，solo 算数）

- 测试用例自纠 ×2：跨午夜区间认知错误（22:30 ∈、09:00 ∉ 22:00→08:00）——实现正确、断言标注错。
- set() 脏输入测试用 double-cast 模拟 IPC unknown 载荷（运行时归一化兜底是真实防线）。
- 已知小边界：设置页开关在 notifPrefs 字段整体缺失时按默认值（开）翻转——settings 归一化后字段恒存在，实际不可达。

### Semgrep

新增面（纯函数/settings/渲染层 UI）无告警。

## 核验记录

| 设计条目（§八） | 证据 |
|:-----|:-----|
| notifPrefs 字段级扩展不 bump | SettingsProvider.test（version 3 断言继承既有用例 + 三路径归一化） |
| 推送策略（源开关/DND 跨午夜/含头不含尾） | prefs.test 3 用例 |
| systemChannel 动态读设置 | main 接线（每次推送 getSettings） |
| 设置页通知卡 | shell.html + e2e 回归（设置页渲染无回归）；交互待 dev 验证 |
| 不推 ≠ 不入中心 | 策略只在 systemChannel，emit 路径未动（NotificationService 测试覆盖） |

**核验结论：通过**。降级登记：docs/ui 规范缺失（沿用令牌体系）。风险项：DND 为分钟粒度本地时区判断，系统休眠跨界的边界由「推送时刻」决定——符合直觉。
