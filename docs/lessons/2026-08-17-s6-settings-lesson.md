# S6 经验沉淀：跨 S 消费点变更传播逐点核验 与 UI 层 IPC 白名单边界

> 三硬标准：可复用 / 非显而易见 / 有代价（均通过）
> 来源：S6 设置页（dsh-hull-desktop）实现与评审期

---

## Lesson 1：跨 S 消费点变更传播必须逐消费点核验——登记清单 + 实现后 grep 双保险

### 现象
registry 字段落地（S6）影响三个消费点：S2 安装（npmRunner）+ S3 check（registry.ts）+ S4 listVersions（registry.ts）。S6 变更传播登记只列了 S2（安装源，安全面），**评审 beta 抓出 registry.ts（S3 模块）遗漏**；实现期 gamma 又抓出 `checkLatestVersion` 调 `fetchLatestVersion` 未透传 getRegistry——**B7 三消费点缺一**（npmRunner/ChannelService 已正确，S3 check 路径绕过 settings.registry）。

### 根因
变更传播登记按「模块归属」列（S2/S3/S4），但 registry 读取是**跨模块共享函数**（registry.ts 被 S3 check 与 S4 listVersions 共用）——按模块列会漏「共享函数内部的多调用路径」。且透传类缺陷（参数没往下传）在单点测试（fetchLatestVersion 直测）下全绿，只有端到端路径（checkLatestVersion → fetchLatestVersion）才暴露。

### 对策
- **变更传播清单按「消费点」而非「模块」列**：每个字段改造列出所有读取该字段的调用路径（含共享函数内部）
- **实现后逐消费点 grep 核验**：`grep -rn "HULL_REGISTRY\|getRegistry\|settings.registry"` 三消费点逐一确认优先级一致
- **透传类缺陷补端到端测试**：checkLatestVersion（外层）注入 getRegistry 断言 URL——单点测试覆盖不了参数透传

### 代价
- 评审 beta + 实现期 gamma 两轮才抓全；若流入生产，dsh 检查更新走 env 而非用户设置的 registry——行为不一致难排查

---

## Lesson 2：UI 实现者新增 IPC 白名单须评审确认边界——纯透传 vs 越界

### 现象
designer 实现设置页时新增 7 个 IPC 方法（upgradeDsh/cancelDshUpgrade/dismissDshUpdate/getHullUpdateStatus/downloadHullUpdate/cancelHullUpdate/dismissHullUpdate）——评审确认全为 S3/S5 既有接口透传（Updater/HullUpdater 方法直通），无新逻辑，安全面可控（独立 partition 'settings' + 独立 preload）。

### 根因
UI 层为闭环（按钮 → 功能）补 IPC 是常态——设置页需要触达 S3/S5 的升级/回滚/下载接口，而这些接口此前只有 main 内部调用（托盘/dialog），无 IPC 通道。机械拒绝新增会卡死 UI 闭环；无边界放行会扩大攻击面。

### 对策
- **评审核三点**：① 是否纯透传（无新逻辑/新权限）② 是否越界（触达未授权能力）③ 挂载边界（独立 partition + 独立 preload，不污染官方 UI）
- 纯透传 + 边界正确 → 放行（S6 7 个 IPC 全为 S3/S5 既有接口透传，确认通过）
- 与 S1/S2 桥「不透传回调、不暴露任意通道」不变式一致——IPC 白名单是「方法级」白名单，非「通道级」

### 代价
- 评审多一轮 IPC 清单核对；若放行越界方法（如直接暴露 fs），安全面扩大——白名单逐方法核是必要成本
