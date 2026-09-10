# N4 笔记设置集成契约

## 契约信息

- 工作项：N4 设置集成——目录选择器 / 路径显示与复制 / schema bump（飞书 dsh-hull-desktop 清单 Todo 列，guid `3335efd6-0049-49d3-be25-eab1aa28ca01`）
- 契约状态：已冻结（2026-09-11 复核通过）
- 版本：v1.0
- 适用共识：`docs/spec/共识-Hull桌面壳-笔记.md` v1.1
- 最后更新：2026-09-11
- 说明：壳内部模块契约（无 HTTP API 面）；本契约为接线契约——不新造 IPC 通道，全部复用现存通道与模式（证据见各节）
- 依赖：N1（存储与索引服务——重扫索引 / `notes:indexChanged` 事件由 N1 提供，本契约只定义触发接线）；N2（编辑器——切换前置脏处理由 N2 配合）

## 需求与共识追踪

| 能力 | 共识规则/章节 | 验收标准 | 接口 | 状态 |
|---|---|---|---|---|
| 设置页「笔记」区块：默认存储目录显示 | CON-R-notes-001 + 共识 §4（路径显示与复制按钮，v1.1 Q-075） | 显示当前生效目录路径（默认 `<userData>/notes/`） | UI：`section#settings` 新增 `.scard` 区块 | 已定义 |
| 目录选择器 | CON-R-notes-001 | 复用壳既有 directory picker 通道 | `dialog:pickDirectory`（现存通道，见接口详情 1） | 已定义 |
| 路径复制按钮 | 共识 §4（agent 协同用户故事，PRD §2-3） | 点复制 → notes.dir 生效路径进剪贴板 | `hull:copyText`（现存通道，见接口详情 2） | 已定义 |
| settings.json 扩展 `notes.dir` + schema bump | CON-R-notes-001（§7 字段表「schema bump」） | schemaVersion 3→4 + 迁移补齐 | SettingsProvider 扩展（见接口详情 3） | 已定义 |
| notes.dir 变更流程（不迁移 / 前置脏处理 / 重扫 / 打开失效） | CON-R-notes-010 | 提示「新目录将被扫描，旧目录文件不动」；切换后重扫 + 打开笔记清空提示「存储目录已更改」 | settings 变更传播接线（见接口详情 4） | 已定义 |
| 路径校验（相对/非法拒绝） | CON-R-notes-013 精神延伸 | 相对路径/非法值 → 校验拒绝不落盘 | `notes-dir-invalid` 错误码（见错误与异常） | 已定义 |
| 目录不存在行为 | 共识未定 | — | `TBD（待确认）`（见开放问题 W1） | TBD |

## 范围与非目标

### 范围

- 设置页「笔记」区块 UI（shell.html `section#settings` 内新增 `.scard`，markup 沿用既有 `.srow`/`.info`/`.control` 模式——先例 shell.html:555-609「通用设置」区块）
- SettingsProvider 扩展 `notes.dir` 字段 + SCHEMA_VERSION 3→4 + migrate() 补齐
- notes.dir 变更接线：主进程感知 → 通知 N1 重扫 → `notes:indexChanged` 推送（事件本体属 N1 契约）
- 变更前置脏处理交互约定（与 N2 的配合面）

### 非目标

- 旧目录文件迁移/搬运（CON-R-notes-010 定案：不迁移，用户自行处理）
- 回收站目录跟随（CON-R-notes-007：`.trash/` 固定 `<userData>/notes/.trash/`，改 notes.dir 不跟随）
- 设置页之外修改 notes.dir 的入口（无手输路径框——路径仅经原生目录选择器产生，从源头规避非法输入面）
- notes 索引/扫描/IPC 通道本体（N1）

## 业务流程与状态

### notes.dir 变更流程（文本流程）

```
用户在设置页「笔记」区块点「更改目录」
→ hull.pickDirectory()（dialog:pickDirectory，原生选择器，createDirectory 已开启）
→ 用户选定新目录（取消 → 流程终止，无改动）
→ 渲染侧确认弹窗：文案「新目录将被扫描，旧目录文件不动」（CON-R-notes-010 定案文案）
   （确认弹窗前，若 N2 编辑器有脏笔记 → 先走 N2 保存/放弃分流（CON-R-notes-002），放弃或保存完成后才进入下一步；拒绝处理 → 流程终止）
→ hull.setSettings({ notesDir: <绝对路径> })
→ 主进程 SettingsProvider.set()：校验（绝对路径）→ 原子写 settings.json → emit('changed')
→ 主进程 notes 接线层感知 notesDir 变化 → 调 N1 重扫索引（新目录全量扫描，不迁移旧目录文件）
→ N1 推 `notes:indexChanged` → N2 渲染层：打开中的笔记失效清空回列表 + 提示「存储目录已更改」（CON-R-notes-010）
```

### 状态转换（notes.dir 生效值）

| 当前值 | 动作 | 目标值 | 前置条件 | 冲突行为 | 依据 |
|---|---|---|---|---|---|
| null（默认 `<userData>/notes/`） | 用户选定新目录 + 确认 | 新绝对路径 | 脏笔记已保存/放弃 | 校验失败拒绝（notes-dir-invalid） | CON-R-notes-001/010 |
| 新绝对路径 | 再次更改 | 另一新绝对路径 | 同上 | 同上 | 同上 |
| 任意 | 选择器取消 / 确认弹窗取消 / 脏处理被拒 | 不变（无写入） | — | 幂等 | CON-R-notes-010 |

## 接口清单

| # | 状态 | 接口 | 用途 | 调用方 | 幂等 |
|---|---|---|---|---|---|
| 1 | 复用（现存） | `hull.pickDirectory()` → IPC `dialog:pickDirectory` | 原生目录选择器 | 设置页笔记区块 | 是（取消无副作用） |
| 2 | 复用（现存） | `hull.copyText(text)` → IPC `hull:copyText` | 路径复制到剪贴板 | 设置页笔记区块 | 是 |
| 3 | 复用（现存） | `hull.getSettings()` / `hull.setSettings(patch)` → IPC `hull:getSettings`/`hull:setSettings` | notes.dir 读写 | 设置页笔记区块 | set 非幂等（值变触发重扫） |
| 4 | NEW（主进程内部，无新 IPC 通道） | SettingsProvider 扩展 `notesDir` 字段 + SCHEMA_VERSION 3→4 + migrate() | settings.json 持久化 | main 装配 | 迁移幂等 |

> 通道白名单：`dialog:pickDirectory` 已在 `src/shared/ipc-channels.ts:59`（DIALOG_IPC_CHANNELS）；`hull:getSettings`/`hull:setSettings`/`hull:copyText` 走 hull 域桥（src/preload/index.ts:64/66/94）。本契约零新增通道；N1 的 `notes:*` 通道集见 CON-R-notes-009（N1 契约）。

## Schema 与枚举

### HullSettings 扩展字段 `notesDir`

| 字段 | 类型 | 必填 | 可空 | 约束 | 说明 |
|---|---|---|---|---|---|
| notesDir | string \| null | 是（读路径恒归一） | 是 | null 或绝对路径（resolve 后 path.isAbsolute） | null/缺省 = 默认 `<userData>/notes/`（动态解析，不持久化默认绝对路径——与 `pinnedVersion: string \| null` 同款可空语义，src/settings/SettingsProvider.ts:33 先例）；非空 = 用户选定的本地绝对路径 |

- 对应共识 §7 字段 `notes.dir`：默认 `<userData>/notes/`；可改任意本地文件夹；改路径不迁移旧文件。
- 生效路径计算：`notesDir ?? join(userDataPath, 'notes')`——设置页显示与复制按钮均用生效路径（含默认解析结果）。

### schemaVersion 迁移表

| 版本 | 变更 | 迁移行为 | 依据 |
|---|---|---|---|
| 1→2 | S4 channel/pinnedVersion | 字段补默认（既有） | SettingsProvider B7 策略 |
| 2→3 | S5 autoCheckDsh/autoCheckHull | 字段补默认（既有） | 同上 |
| 3→4 | **N4 notesDir** | 字段补默认 null（= 生效 `<userData>/notes/`，不落盘绝对路径）；其余字段原样保留 | SCHEMA_VERSION_CURRENT 3→4（当前值 3，src/settings/SettingsProvider.ts:49）；migrate() 模式不变（src/settings/SettingsProvider.ts:200-246） |

## 接口详情

### 1. `hull.pickDirectory()` → IPC `dialog:pickDirectory`（复用，零改动）

- 使用场景：笔记区块「更改目录」按钮
- 现存证据：main handler `src/main/index.ts:514-521`（`properties: ['openDirectory', 'createDirectory']`，title「选择工作目录」）；preload 桥 `src/preload/index.ts:27`；通道白名单 `src/shared/ipc-channels.ts:59`
- 行为：原生目录选择器；取消 → `{ ok: true, path: null }`（渲染侧不改动）
- 注记：title 恒为「选择工作目录」（既有实现不参数化）——笔记复用时标题文案复用现状，不为本需求改 main 侧签名；如需独立标题 → TBD（待确认，见 W3）
- 返回：`Promise<{ ok: boolean; path: string | null }>`

### 2. `hull.copyText(text)` → IPC `hull:copyText`（复用，零改动）

- 使用场景：笔记区块路径行「复制」按钮——复制生效路径，供用户粘贴给 dsh agent 当上下文（PRD §2-3 agent 协同故事）
- 现存证据：main handler `src/main/index.ts:894-899`（渲染侧 file:// 无 clipboard 权限，统一走主进程 clipboard.writeText；≤4096 字符）；preload `src/preload/index.ts:94`
- 行为：`clipboard.writeText(生效路径)` → `{ ok: true }`；渲染侧复制成功后 toast（复用 shell.html setSetting 的 toast 惯例，shell.html:969）

### 3. `hull.getSettings()` / `hull.setSettings({ notesDir })` → IPC `hull:getSettings` / `hull:setSettings`（复用）

- 使用场景：区块渲染时读当前 notesDir（渲染初值走 getSettings，同区块内 registry/theme 先例 shell.html:890 state.settings）；变更提交走 setSettings
- 现存证据：main handler `src/main/index.ts:750-763`；preload `src/preload/index.ts:64-66`；SettingsProvider.set() 原子写 + `emit('changed')` 广播（src/settings/SettingsProvider.ts:163-193）
- 输入 patch：`{ notesDir: string | null }`（null = 恢复默认 `<userData>/notes/`；是否提供「恢复默认」按钮 → TBD（待确认，见 W2））
- 行为（set 路径新增校验，插在 SettingsProvider.set() 校验链，先例 registry-invalid src/settings/SettingsProvider.ts:174-176）：
  - 非空值必须为绝对路径（path.isAbsolute）且经 resolve 归一 → 否则 `HullError('notes-dir-invalid')`（对齐 CON-R-notes-013 拒绝相对/非法路径精神）
  - 写盘成功后 emit('changed') 全量广播（既有机制，main 侧 notes 接线层订阅消费——见 4）
- 输出：`{ ok: true, settings: HullSettings }`（全量，既有语义）

### 4. notes.dir 变更传播（主进程内部接线，无新通道）

- 使用场景：notesDir 值变化后触发 N1 重扫
- 机制（按现有 settings 变更传播实际模式确定）：SettingsProvider 继承 EventEmitter，`set()` 成功后 `emit('changed', 全量)`（src/settings/SettingsProvider.ts:105-109/192）——**当前无订阅者**（同文件 :105 注记「当前无订阅者——消费方走动态读」）。N4 在 main 装配时新增订阅：比较前后 notesDir 生效值，变化 → 通知 N1 全量重扫新目录（不迁移，CON-R-notes-010）
- 与 N1 接口面：重扫入口 = N1 扫描服务内部触发（notes.dir 变更经 settings 变更传播，主进程直调，**无新增通道**）；重扫完成后 N1 推 `notes:indexChanged`（CON-R-notes-009 已闭合的推送事件，N4 零新增事件）
- 与 N2 接口面（切换前置脏处理）：渲染侧在提交 setSettings **之前**，若 N2 编辑器存在脏笔记 → 触发 N2 的保存/放弃分流（CON-R-notes-002/010）；处理完成才提交。切换提交成功后，N2 收到 `notes:indexChanged` 清空打开中的笔记回列表 + 提示「存储目录已更改」
- 视图边界（共识 §12 Q-076）：默认视图仍为任务看板，notes.dir 变更不影响 view 机制；win 路径统一 `/` 显示

## 错误与异常

| 错误码 | 触发 | 行为 | 依据 |
|---|---|---|---|
| notes-dir-invalid | setSettings 传相对路径/非法值（非 string、resolve 失败） | 拒绝写盘，渲染侧显示错误不 toast「已保存」 | CON-R-notes-013 精神；registry-invalid 先例（SettingsProvider.ts:174-176 抛 HullError → main 返回 `{ok:false, code, message}` main/index.ts:756-761） |
| persist-failed | settings.json 写盘失败 | 既有语义（≡ settings-write-failed），无内存态 | SettingsProvider.ts:189-190 |
| —（无新码） | 选定目录不存在 | TBD（待确认，见 W1）；现状参照：dialog:pickDirectory 已开 `createDirectory`（main/index.ts:517），且既有惯例「前端不校验目录存在性」（main/index.ts:515 注记） | 共识未定标 |

## 联调与测试场景

| # | 场景 | 步骤 | 预期 |
|---|---|---|---|
| T4-01 | 默认路径显示 | 全新 settings.json（无 notesDir）→ 打开设置页笔记区块 | 显示 `<userData>/notes/` 生效路径 |
| T4-02 | 复制按钮 | 点「复制」→ 读剪贴板 | 剪贴板 = 生效路径（T4-01 同值） |
| T4-03 | 更改目录全流程 | 选新目录 → 确认弹窗（文案含「新目录将被扫描，旧目录文件不动」）→ 确认 | settings.json 落新绝对路径 + schemaVersion=4；旧目录文件未动；N1 重扫新目录；notes:indexChanged 推送 |
| T4-04 | 脏笔记前置 | 编辑笔记不保存（2s debounce 内）→ 立即更改目录 | 先弹 N2 保存/放弃分流；处理后流程才继续（CON-R-notes-010） |
| T4-05 | 打开笔记失效 | 打开笔记 A → 更改目录 → 重扫完成 | 笔记 A 编辑器清空回列表 + 提示「存储目录已更改」 |
| T4-06 | 取消选择器 | 选目录时点取消 | settings.json 无改动，索引无重扫（幂等） |
| T4-07 | 非法路径拒绝 | 直调 setSettings 传相对路径（绕过 UI） | `{ok:false, code:'notes-dir-invalid'}`，磁盘无写入 |
| T4-08 | schema 迁移 | 旧 schemaVersion=3 的 settings.json → 启动 migrate() | notesDir 补 null，其余字段保留，schemaVersion=4 |
| T4-09 | 回收站不跟随 | 更改目录后检查 `<userData>/notes/.trash/` | 回收站仍在 userData 原位（CON-R-notes-007） |

## 开放问题

- W1（P2，共识未定标）：notesDir 指向不存在目录 → 自动创建 or 提示？现状惯例：选择器已开 `createDirectory`（main/index.ts:517），且看板先例「前端不校验目录存在性，执行时校验」（main/index.ts:515）——**倾向自动创建**（对齐 N1 扫描前置 mkdir 亦可）。TBD（待确认），冻结前回写共识。
- W2（P3）：是否提供「恢复默认目录」按钮（patch 传 null 即可实现，成本低）。TBD（待确认）。
- W3（P3）：dialog:pickDirectory title 恒「选择工作目录」，笔记场景复用是否接受现文案（或为通道加可选 title 参数——改现存签名，需评审）。TBD（待确认）。

## 变更记录

- 2026-09-11：新建契约（v0.1 草稿，待复核冻结）。零新增 IPC 通道：目录选择器复用 `dialog:pickDirectory`（src/main/index.ts:516）、复制复用 `hull:copyText`（src/main/index.ts:895）、设置读写复用 `hull:getSettings/setSettings`（src/main/index.ts:750-751）；settings 变更传播按 SettingsProvider.emit('changed') 现存模式接线（src/settings/SettingsProvider.ts:192）
