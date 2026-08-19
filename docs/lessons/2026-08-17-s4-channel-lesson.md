# S4 经验沉淀：失败路径状态迁移闭环 与 错误码域契约归属

> 三硬标准：可复用 / 非显而易见 / 有代价（均通过）
> 来源：S4 版本通道（dsh-hull-desktop）实现与评审期

---

## Lesson 1：失败路径必须状态迁移闭环——拒绝前先迁移，补「失败后可恢复」测试

### 现象
Updater B3 guard（目标 == 当前运行版本 → 拒绝「已在该版本」）抛 version-invalid 前**未做状态迁移**——phase 停留在 Confirm。调用方 catch 错误后，后续 check() 被「非 idle 忽略」冲突语义拦截，phase **永久卡 Confirm**，check/upgrade 全部失效。S6 设置页无参 upgrade（pinned X == current）必触发该路径。

### 根因
只把 guard 当作「提前返回的错误」，没与 doUpgrade 其他失败路径对齐（那些路径都是 transition(Idle) 后 throw）。状态机的冲突语义（非 idle 忽略）把「未迁移的失败」放大成「永久卡死」。

### 对策
- **任何拒绝/失败路径与成功路径同等对待**：先迁移到终态（idle）再抛错——guard 补 `transition(Idle)` 一行
- **补「失败后可恢复」测试**：guard 触发后再次 check() 可正常执行（断言 hasUpdate=true，而非被忽略的 hasUpdate=false——两态可区分）
- 双席评审都从代码读出了卡死链（oracle/gamma 独立命中同一缺陷）——失败路径的状态闭环是评审 checklist 级关注点

### 代价
- 一行修复 + 一用例；若流入 S6 才被发现，用户侧表现为「设置页升级按钮点了没反应」（check/upgrade 全静默失效），排查成本高得多

---

## Lesson 2：错误码域必须归属单一契约面——跨模块复用函数时随边界映射

### 现象
ChannelService.resolveTarget() latest 路径直接复用 S3 `fetchLatestVersion`——该函数抛 `check-failed`（UPGRADE_ERRORS 域）。而契约 #1 声明 resolveTarget 异常 = **CHANNEL_ERRORS 三码**（version-invalid/version-not-found/registry-unreachable）。S6 设置页按契约三码映射 UI 文案时，check-failed 会漏判（无对应渲染分支）。

### 根因
复用跨模块函数时只考虑了「返回值复用」，没做「错误码域随调用边界映射」——错误码域属于**被调函数的契约面**，跨契约面调用必须转换。

### 对策
- resolveTarget latest 路径 try/catch → 映射 `HullError(registry-unreachable, ...)`（CHANNEL_ERRORS 域）
- 评审波同类先例：S2 swap-recovered vs cancelled（系统动作 vs 用户动作分域）——错误码域的「单一契约面」原则贯穿多 S
- 补测试断言具体码（非 check-failed），锁死域边界

### 代价
- 一行映射 + 一用例；若流入 S6，UI 渲染漏判表现为「registry 失败无提示或走默认分支」，用户误导
