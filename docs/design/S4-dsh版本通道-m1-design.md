# S4 dsh 版本通道 技术方案

> 工作项：S4 dsh 版本通道（飞书 dsh-hull-desktop 清单）
> 状态：已冻结（多方复评通过，2026-08-17）
> 版本：0.2 · 2026-08-17
> 事实源：契约 `docs/api/feishu-s4-m1-api-contract.md` v0.2（已冻结）；共识 `docs/spec/共识-Hull桌面壳-M1.md` v1.4（CON-R008/013、Q-001/Q-005）；S3 设计 0.2（冻结 2026-08-17，Updater 消费点 resolveTarget、registry.ts/semver.ts 复用面）；S1 设计 0.2（§5.1 存储章——settings.json schema 冻结面）
> 判级：复杂。理由：settings.json schema 扩展触碰 S1 冻结面（契约变更传播）+ 跨模块集成（S3 Updater 消费 resolveTarget）+ registry 外部集成；无安全敏感面（纯配置读写 + 查询）
> 偏离契约/共识处统一标注：⛔️ 见 §8 对照表

---

## 1. 背景与范围

**定位**：dsh 版本通道——channel（latest/pinned）+ 指定版本入口（手输 + 版本列表下拉）+ pinnedVersion 持久化（settings.json）+ 检查与 pinned 解耦 + prerelease 感知比较（S3 semver 复用）+ 非法版本校验。

**规则绑定**：CON-R008（dsh 版本策略：默认 @latest；设置页提供"指定版本"入口——手输版本号或从版本列表选择，不写死）、CON-R013（registry 通用：任意 npm registry）、Q-001/Q-005（默认 latest + 指定版本入口；不自建正式/开发双通道）。

**范围**（契约 §范围，冻结）：channel 设置（latest 默认 / pinned）；指定版本入口；pinnedVersion 持久化（settings.json）；检查与 pinned 解耦（自动检查照常提示新版；升级到非 pinned 版本需显式解锁，升级后 channel 回 latest）；prerelease 感知版本比较；非法版本号校验。

**非目标**（契约 §非目标）：升级执行（S3 复用）、安装流程（S2 复用）、自建正式/开发双通道（Q-005）。

**交付验收**：T4-01（latest 跟随：检查提示新版并升级到最新）、T4-02（pinned 锁定：检查照常提示，升级被守卫）、T4-03（解锁升级：升级到新版后 channel 回 latest）、T4-04（非法版本手输校验拦截）、T4-05（prerelease 比较顺序正确）、T4-06（registry 不可达列表加载失败提示）。

**变更传播面**（本设计必列，§8 登记）：
- ① **S1 settings.json schema 扩展**（channel/pinnedVersion）：S1 设计 §5.1 声明的 schema（closeToQuit/schemaVersion）与「写路径归 S6」需修订——⛔️ 偏离 2（P3 文案修正：真实 schema 所在为 S1 设计 §5.1，S1 契约无 schema 表）
- ② **S3 Updater 集成**：check/upgrade 目标来源改 resolveTarget + 解锁升级 channel 回写（Updater 完成回调）
- ③ S4 契约 v0.2（版本指针 v1.4 + 偏离登记）

**范围剪裁说明（YAGNI）**：listVersions 截取前 100（D4，W4 承接上限来源）；自建双通道不建（Q-005）；版本列表 UI 归 S6（S4 交付接口 + IPC 预留，⛔️ 偏离 1）；`Settings.registry` 字段不落地（S2 偏离 3 已定 env HULL_REGISTRY，S4 沿袭——忠实点注记）。

---

## 2. 架构决策（含备选）

### D1 模块位置

- **A**：`src/channel/` 平级
- **B**：并入 `src/updater/` → **选 A**

理由：独立通道域——被设置页（S6）、S3 Updater、S2 安装流程消费，与升级编排（Updater）解耦（S4 交付后 S3 不膨胀）；**VersionCompare 不新建**：契约 #5 由 S3 `semver.compareVersions` 承载（注记映射：契约 #5 VersionCompare.compare(a,b) ≡ semver.compareVersions(a,b)），零复制。

### D2 settings 持久化（变更传播核心 + B5/B7 修订）

S1 `SettingsProvider` 目前只读（closeToQuit/schemaVersion，损坏回退默认不覆盖）。契约 S4 要求 channel/pinnedVersion 持久化 + `set()` 写入 → **SettingsProvider 扩展读写**：

- schema 增：`channel`（枚举 latest/pinned，默认 'latest'）/ `pinnedVersion`（可选 string，channel=pinned 时必填）
- **写路径 temp+rename 原子写**（S1 §5.1 原子写原则沿用）；**写失败语义（B5）：内存态丢弃（与磁盘一致）+ 告警日志 + 返回错误语义**；`get()` 恒读磁盘权威（无内存缓存——避免读写不一致）
- **schemaVersion bump 策略（B7）**：schema 扩展必 bump（当前 1 → 2）；S6 迁移以 bump 后版本号为判据（本轮仅定原则，迁移实现归 S6）
- 损坏读 → 默认值不覆盖原文件（S1 语义保持）；旧文件无 channel 字段 → 默认 'latest'（兼容）
- **S1 存储章「写路径归 S6」修订为「S4 承担首个写者（channel 字段），S6 设置页 UI 接线」**——变更传播登记（⛔️ 偏离 2）
- **解锁回写失败容错（B5）**：set('latest') 回写失败 → 告警 + 内存回退 latest 显示 + resolveTarget 重读容错（下次 set/启动重写）

### D3 resolveTarget() 与 check 集成（B1 修订）

- channel=latest → registry dist-tags.latest（S3 `registry.checkLatestVersion` 复用，HULL_REGISTRY env）
- channel=pinned → 校验 pinnedVersion 存在性（**单版本端点**，见 D4-B2）→ 返回；不存在 → `version-not-found`
- **check 恒 registry latest（channel 无关）**——契约「检查与 pinned 解耦」字面化（G3/B1）：Updater.check 不消费 resolveTarget，只查 latest；pinned 守卫只作用于 upgrade 目标
- **upgrade 默认目标 = resolveTarget()**；**解锁升级显式传参绕过**（upgrade(Y) 显式目标，不经 resolveTarget——契约 G3）
- S3 Updater 集成：Updater 注入 `channelService`（默认 latest 行为不变），check 目标 = registry latest（现状），upgrade 默认目标来源改 resolveTarget

```
check 集成伪码（B1）:
  check(): 恒查 registry latest（channel 无关）→ hasUpdate 判断 → confirm
upgrade 集成伪码:
  upgrade(target?):
    target 显式（解锁升级）→ 用 target
    target 缺省 → channelService.resolveTarget()（channel=latest → latest；pinned → pinnedVersion）
    guard（B3）：target == 当前运行版本（overlay.currentVersion()）→ 拒绝「已在该版本」（单测项）
```

### D4 版本列表与存在性校验双层拆分（W4 + B2 修订）

**双层拆分（B2）**：
- **listVersions() 截断版**（UI select 用）：registry manifest `versions` keys 降序排列（semver 感知，S3 semver.ts 复用）+ 截取前 100（常量 `LIST_LIMIT = 100`，注记上限来源 W4：防超大 manifest 渲染压力，S4 不建分页）；dist-tags 标注（latest）；失败 → `registry-unreachable`
- **单版本端点存在性校验**（精确校验用）：`GET <registry>/<pkg>/<version>` → 200 = 存在 / 404 = `version-not-found`（**完整 manifest 不用**——payload 大；dist-tags 端点不适用——只含 tag 不含版本清单）

手输版本校验链：格式（isValidVersion）→ 单版本端点存在性（version-not-found）。

### D5 解锁升级语义

pinned 下 check 发现新版 Y ≠ pinnedVersion → confirm 弹窗「将解锁并升级到 Y」（S3 dialog 流程扩展文案；**S3 设计注记（B6）：dialog 按钮集 [保持锁定/解锁并升级] 扩展归 S6 接线**）→ 确认后 `upgrade(Y)`（**显式传参绕过 resolveTarget**）→ 成功 → **channel 回写 'latest'**（Updater 完成回调 → channelService.set('latest')）；拒绝 → 保持 pinned。解锁语义 = 契约「升级后 channel 回 latest」；**升级中途失败 channel 不动**（成功才回写，§7 风险定稿）。

### D5b set('latest') 显式清 pinnedVersion（B4）

`set('latest')` 显式清除 pinnedVersion 字段（与 channel 写入**同事务原子写**——单次 temp+rename，防残留旧锁定值误导 resolveTarget）。

### D6 校验（B8 修订）

手输版本 → `isValidVersion`（S3 semver 复用）→ 格式非法 `version-invalid`；registry 存在性 → **单版本端点**（D4-B2）→ `version-not-found`；channel=latest 时 `set()` 忽略 version 参数（latest 不需要锁定版本）。
**离线 set('pinned') 边界注记（B8）**：pinned 锁定须 registry 存在性校验 → **离线无法锁定**（registry-unreachable；UI 禁用 + 提示，非缺陷——与 registry-unreachable 可重试语义一致）。

### D7 UI 载体（⛔️ 偏离 1）

契约调用方全设置页；S4 交付 main 侧 ChannelService 接口 + **IPC 通道预留**（`hull:getChannel` / `hull:setChannel` / `hull:listVersions`，S6 启用接线）——与 S3 同款处置（S3 先行托盘/dialog，设置页 UI 归 S6）。

### D8 registry 复用细化

listVersions 用完整 manifest（版本列表核心用途——versions 全量在完整 manifest）；checkLatest 保持现状（registry.ts 已实现 dist-tags.latest + /latest fallback）；可顺手加 abbreviated manifest Accept 头（S3 🟢-3 落地注记——registry 支持 abbreviated 元数据时减少传输，实现期验证）。

### D9 测试策略

单测（node:test，S1/S2/S3 模式）：
- ChannelService：get/set 持久化（含损坏回退、旧文件兼容）、resolveTarget 两通道、listVersions 排序截断、非法版本、version-not-found、解锁语义（channel 回写时机）
- SettingsProvider 读写扩展回归：**现有 152 用例不破坏**（只读路径语义保持，新增写路径用例）
- S3 Updater 集成回归：注入 channelService 后现有 Updater 用例不破坏（默认 latest 行为不变）

---

## 3. 模块划分

| 模块 | 职责 | 依赖 | 契约接口 |
|---|---|---|---|
| `channel/ChannelService.ts` | get/set/resolveTarget/listVersions + 校验链 + 解锁语义（channel 回写） | SettingsProvider、registry（S3）、semver（S3）、logger | #1~#4 |
| VersionCompare | **不新建**：契约 #5 ≡ S3 `semver.compareVersions`（映射注记） | — | #5 |
| `settings/SettingsProvider.ts` | 扩展读写：schema + channel/pinnedVersion + 原子写 + 写失败语义（S1 只读保持兼容） | — | 变更传播 |
| `updater/Updater.ts` | 集成：注入 channelService，check/upgrade 目标来源 resolveTarget + 解锁回写回调 | channelService | #3 消费 |
| `main/index.ts` | IPC 预留三通道（hull:getChannel/setChannel/listVersions，S6 启用） | ChannelService | ⛔️ 偏离 1 |

**依赖方向**（单向，无环）：`ChannelService → {SettingsProvider, registry, semver}`；`Updater → ChannelService`（注入，默认 latest 行为不变）；`main → ChannelService`（IPC 预留）。

**S4→S6 承载点**：ChannelService 即设置页通道 UI 数据源；IPC 三通道即 S6 接线预留；解锁文案（D5）即 S6 dialog 扩展点。

---

## 4. 关键机制实现形态

### 4.1 resolveTarget 两通道伪码（D3）

```
resolveTarget():
  channel = settings.get().channel
  channel == 'latest':
    latest = registry.checkLatestVersion(currentVersion: overlay.currentVersion).latest
    返回 latest（registry 不可达 → registry-unreachable）
  channel == 'pinned':
    pinnedVersion 缺失 → version-invalid（pinned 必填）
    单版本端点校验（GET registry/<pkg>/<version> → 200 = 存在 / 404 → version-not-found；
                      对齐 D4-B2/§4.2——listVersions 截断前 100 会误拒 100 外版本）
    返回 pinnedVersion
```

### 4.2 set() 校验链（D6）

```
set(channel, version?):
  channel ∉ {latest, pinned} → version-invalid
  channel == 'latest' → 忽略 version 参数；显式清除 pinnedVersion（B4，同事务原子写）
  channel == 'pinned':
    version 缺失/格式非法（isValidVersion）→ version-invalid
    单版本端点存在性（200/404）→ version-not-found（离线 → registry-unreachable，B8）
  settings.set({ channel, ...(pinned ? { pinnedVersion: version } : { pinnedVersion: undefined }) })
  写失败 → 告警 + 错误语义（内存态丢弃，与磁盘一致；get() 恒读磁盘权威，B5）
```

### 4.3 解锁升级时序（D5）

```
check（pinned 锁定 X，发现新版 Y ≠ X）:
  confirm 弹窗「最新 Y，当前锁定 X」[保持锁定 / 解锁并升级]
  保持锁定 → 无动作（channel 不动）
  解锁并升级 → upgrade(Y)：
    成功 → channelService.set('latest')（Updater 完成回调）
    失败 → channel 不动（保持 pinned，§7 定稿）
```

### 4.4 settings.json 原子写（D2）

```
settings.set(partial):
  合并当前值 → 新 schema 对象（channel/pinnedVersion/closeToQuit/schemaVersion 全字段）
  temp+rename 原子写（S1 §5.1 原则）
  写失败 → logger.warn + 返回错误语义（调用方处理，不静默；**内存态丢弃（与磁盘一致），get() 恒读磁盘权威**，B5 定稿）
```

### 4.5 listVersions 排序截断（D4）

```
listVersions():
  manifest = registry 完整元数据（失败 → registry-unreachable）
  versions = Object.keys(manifest.versions).filter(isValidVersion)
             .sort(compareVersions 降序)      # semver 感知（S3 复用）
  dist-tags.latest 标注（列表头部）
  截取前 LIST_LIMIT = 100（W4 上限来源注记）
```

---

## 5. 工程基线

**判级**：复杂（与头部一致；无安全敏感面）。

| 项 | 现状 | S4 动作 |
|---|---|---|
| git | 已有 | 直接复用 |
| 脚手架 | S1/S2/S3 完成（TS + Electron 43 + tsc 构建） | 跟随；**零新依赖**（semver/registry 全复用 S3） |
| 测试框架 | node:test（152 用例） | 沿用；新增 ChannelService/SettingsProvider 写路径用例 + S3 Updater 集成回归 |

**S1/S2/S3 复用清单**：semver.compareVersions/isValidVersion（S3）、registry.checkLatestVersion + HULL_REGISTRY env（S3）、SettingsProvider 损坏回退语义（S1）、Updater 注入模式（S3）、temp+rename 原子写（S1 §5.1）。

---

## 6. 目录/工程结构（新增部分）

```
dsh-hull-desktop/
├── src/
│   ├── channel/
│   │   └── ChannelService.ts    # 通道 get/set/resolveTarget/listVersions（契约 #1~#4）
│   ├── settings/SettingsProvider.ts  # 扩展读写（schema + 原子写；只读路径兼容）
│   ├── updater/Updater.ts       # 集成：注入 channelService（resolveTarget + 解锁回写）
│   └── main/index.ts            # IPC 预留三通道（S6 启用）
```

---

## 7. 风险与对策

| 风险 | 影响 | 对策 | 归属 |
|---|---|---|---|
| settings schema 变更兼容（旧文件无 channel） | 旧用户配置读崩 | 缺失字段 → 默认 'latest'（兼容路径）；损坏 → S1 语义默认值不覆盖 | S4 |
| 写失败（磁盘满/权限） | 通道设置不落盘 | 原子写 + 错误语义（不静默）；**内存态丢弃（与磁盘一致）+ 告警 + get() 恒读磁盘权威**，下次 set 重试 | S4 |
| registry 版本列表超大 | 渲染压力/传输大 | LIST_LIMIT=100 截断（W4 上限来源注记；S4 不建分页） | S4 |
| pinned 版本被 registry 下架 | 升级目标不可用 | resolveTarget → version-not-found → 提示 + 回 latest 建议（UI 归 S6 文案） | S4 |
| 解锁升级中途失败 | channel 状态歧义 | **定稿：升级失败 channel 不动，成功才回写 latest**（D5） | S4 |
| S1/S2/S3 回归 | 扩展破坏既有 | SettingsProvider 只读语义保持（损坏回退/不覆盖）；Updater 注入默认 latest 行为不变；152 用例全量回归 | S4 |
| registry 通用（CON-R013） | 私有源兼容 | 沿袭 S2 偏离 3：HULL_REGISTRY env（settings.registry 字段不落地——S1 冻结面，忠实点注记） | S4 |

---

## 8. 契约/共识对照与偏离标注

| # | 偏离点 | 契约/共识原文 | 设计取值 | 理由 |
|---|---|---|---|---|
| 1 | UI 归 S6（设计保留标注） | 契约 #1/#2/#4 调用方 = 设置页 | S4 交付 main 侧 ChannelService 接口 + IPC 预留三通道（hull:getChannel/setChannel/listVersions）；设置页 UI 归 S6 接线 | 设置页内容归 S6（S1 非目标同款，S3 偏离 1 同族处置）；通道选择/手输/下拉 UI 在 S6 启用 |
| 2 | S1 settings schema 扩展 + 「写路径归 S6」修订（契约变更传播） | S1 设计 §5.1 schema（closeToQuit/schemaVersion，真实 schema 所在）；S1 设计 §5.1「写路径归 S6」 | SettingsProvider 扩展读写：schema 增 channel/pinnedVersion（默认 latest）；S4 承担首个写者，「写路径归 S6」修订为「S4 首个写者，S6 设置页 UI 接线」——S1 契约修订 + SettingsProvider 代码扩展（变更传播登记） | S4 契约要求 channel/pinnedVersion 持久化（契约 S4 §Schema）；只读实现无法承载，须扩展（S1 冻结面经变更传播修订） |

**非偏离的契约忠实点**：channel 枚举（latest/pinned，默认 latest）；pinned 守卫升级语义（检查恒 latest 照常、升级需解锁）；解锁升级后 channel 回 latest（成功才回写）；prerelease 感知比较（semver.compareVersions 承载 #5）；registry 通用（HULL_REGISTRY env——沿袭 S2 偏离 3，settings.registry 字段不落地注记）；检查与 pinned 解耦（用户选择检查就检查，pinned 只守卫升级目标）；CHANNEL_ERRORS 三码（version-invalid/version-not-found/registry-unreachable）。

**变更传播登记**（本设计触发的契约修订）：
- S1 契约：settings.json schema 声明扩展（channel/pinnedVersion）+ §5.1 写路径修订（S4 首个写者）
- S4 契约：版本指针 v1.4（适用版本升共识 v1.4）
- S3 契约：Updater 集成注记（check/upgrade 目标来源 resolveTarget + 解锁回写——S3 契约 #1/#2 行为注记，实现期 Updater 注入不改接口）

**T4 场景 → 设计落点**：T4-01 §4.1（latest 通道 resolveTarget → registry latest）+ S3 升级链路回归；T4-02 §4.3（pinned 守卫：检查恒 latest、升级目标 = pinnedVersion）；T4-03 §4.3（解锁升级 + 成功回写 latest——**接口级验收（B6）**：Updater.upgrade(target) 显式传参绕过经单测验证；S3 设计注记 dialog 按钮集扩展归 S6 接线）；T4-04 §4.2（isValidVersion 校验链）；T4-05 §4.5/semver（rc 序数比较，S3 semver 用例回归）；T4-06 §4.5（listVersions 失败 → registry-unreachable）。
