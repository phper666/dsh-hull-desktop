# S2 dsh 运行时管理 技术方案

> 工作项：S2 dsh 运行时管理（飞书 dsh-hull-desktop 清单）
> 状态：已冻结（多方复评通过，2026-08-17）
> 版本：0.2 · 2026-08-17
> 事实源：契约 `docs/api/feishu-s2-m1-api-contract.md` v0.2（已冻结）；共识 `docs/spec/共识-Hull桌面壳-M1.md` v1.4（CON-R002/007/008/010/014/016、Q-004/Q-011）；PRD `docs/prd/2026-08-14-m1-prd.md`；原型 `docs/prototype/index.html`（引导态/安装进度视图）
> 判级：复杂+安全敏感。理由：跨模块协作（OverlayManager/InstallFlow↔S1 RuntimeManager）+ 外部系统集成（npm registry）+ 安装状态机 + 原子替换 + 安装软件安全面（DSH_HOME 零接触）
> 偏离契约/共识处统一标注：⛔️ 见 §8 对照表

---

## 1. 背景与范围

**定位**：S2 交付 dsh 运行时管理——捆绑 Node 落位、overlay 管理（dsh/staging/previous 布局，CON-R008）、首次安装（npm install → staging → 原子替换 → S1 启动）、取消 → 未安装引导态（Q-011 / CON-R016）、DSH_HOME 零接触（CON-R002）。

**规则绑定**：CON-R002（DSH_HOME 壳零读写）、CON-R007（捆绑独立 Node，不依赖用户环境）、CON-R008（overlay 布局 + 版本策略）、CON-R010（升级/回滚/卸载不触碰 DSH_HOME）、CON-R016（首装取消 → 引导态 + 安装按钮）。

**范围**（契约 §范围，冻结）：
- 捆绑 Node 24 LTS（构建时下载，锁定小版本，跟随官方 engines ^22.19 || >=24）
- overlay 目录布局：`userData/dsh`（当前）、`userData/dsh-staging`（安装中）、`userData/dsh-previous`（上一版）
- 首次安装流程：npm install `@deepseek-ai/dsh@目标版本` 到 staging → 原子替换 → 启动
- 取消安装 → 未安装引导态（主窗口显示安装按钮）
- DSH_HOME 默认 ~/.dsh（环境变量透传，壳零读写）

**非目标**（契约 §非目标）：升级编排（S3，复用 overlay 与安装逻辑）、版本通道选择（S4；S2 安装时用默认 latest）、多 profile / 多实例数据管理。

**交付验收**：契约测试场景 T2-01（全新机器首装）、T2-02（取消安装→引导态→重装）、T2-03（数据复用，~/.dsh 零改动）、T2-04（registry 不可达 → 失败提示 + 配置入口 + 重试成功）、T2-05（断网启动已有 overlay 正常使用）、T2-06（捆绑 Node = 24 LTS 锁定版本）。

**范围剪裁说明（YAGNI）**：安装进度不做 npm 输出精确解析（D4）；磁盘预检阈值固定 1GB 粗估（D7，W2 精化来源）；版本列表/指定版本入口归 S4（S2 只用 latest）；升级编排归 S3。

---

## 2. 架构决策（含备选）

### D1 模块位置

- **A**：`src/main/overlay/` 内嵌 main 树
- **B**：`src/overlay/` 与 `src/runtime`、`src/settings` 平级 → **选 B**

理由：S1 已确立平级结构（runtime/settings/log/window/tray/preload 均独立于 main 入口树）；OverlayManager 被 `main/index.ts`（首装编排）与 S3（升级编排）复用，独立模块边界清晰，与 electron 无强耦合（npm 执行/目录操作纯 Node 能力，可单测）。

### D2 npm 执行方式

- **A**：shell 调全局 npm
- **B**：捆绑 node 的 npm-cli.js spawn → **选 B**

选 B 理由：CON-R007 要求捆绑 npm，不依赖用户环境；不 shell 执行防注入（参数串直接进 argv，无 shell 展开）。形态：

```
spawn(nodePath, [npmCliPath, 'install', '@deepseek-ai/dsh@<version>', '--prefix', stagingDir,
                 '--fetch-timeout=30000'],
      { cwd: stagingDir, stdio: ['ignore', 'pipe', 'pipe'] })
```

- `npmCliPath` = 捆绑 node 发行版自带 npm：`<nodeDir>/lib/node_modules/npm/bin/npm-cli.js`（官方 node tarball 布局）
- registry 配置（⛔️ 偏离 3 + S6 变更传播修订）：**settings.registry 字段优先 + `HULL_REGISTRY` env 兜底**（S6 契约 v0.2 落地 settings.json 字段后，env 降为兜底）→ 以 `npm_config_registry` env 透传给 npm 子进程；T2-04 验收口径 = 设置页 registry 输入（S6）+ env 兜底；UI 配置入口归 S6（已兑现）
- **非 detached**（B10）：child.kill() 即可终止（无进程组语义）；崩溃残留由 ensure() 态 1 幂等清理兜底（见 D9）——S1 零改动双保险
- 超时（B5）：install() 总上限 **600s 常量**（到期 → npm-install-failed）+ npm `--fetch-timeout=30000`（fetch 挂起防呆 → 归 registry-unreachable 判定）；均常量不入配置面（注记 2026-08-18 M1 验收实测：冷装 dsh 实测 234s〔254 包/301MB〕，120s 不足，调至 600s〔2.5x 余量〕）
- spawn DI 注入复用 S1 模式（spawnFn 构造注入，测试不真装）

### D3 原子替换（CON-R008/005 风格）

staging 校验完整后按序执行（伪码见 §4.1）。**版本校验改 pre-swap 门禁**（B2）：验 `staging/node_modules/.bin/dsh` 存在 + `node_modules/@deepseek-ai/dsh/package.json` bin 字段合法——注意 npm `--prefix` 不产 staging 根 package.json，校验须落在 node_modules 内。

**post-swap bin symlink**（🔴-1 主修复）：替换完成后建 `symlink <dsh>/bin/dsh → <dsh>/node_modules/.bin/dsh`——S1 `spawnArgs.dshBinPath(<overlayDir>)` = `<overlayDir>/bin/dsh` 为现成路径，symlink 使其指向真实 npm 入口，**S1 spawnArgs 零改动**。

macOS 同卷 rename 原子性有保证（CON-R006 平台前提）；**窗口期**（②~③ 之间 dsh 目录缺失）由安装状态机锁定——install 进行中 RuntimeManager.start() 不可并发（S1 集成点，见 D9）。

### D4 进度模型

- **A**：解析 npm stdout 精确进度
- **B**：阶段粒度 + 粗估算，UI spinner + 阶段文字 → **选 B**

理由：npm 输出格式非契约面，解析脆弱（D4 的 YAGNI 论证与 S1 就绪行解析不同——就绪行是 dsh 契约，npm 输出不是）。粒度：`download`（node 解压 + 预检）10%；`npm-install`（npm 子进程执行期）固定 50% + 结束 90%；`swap`（原子替换）100%。载荷 `{ phase, pct }` 照契约安装事件表。

### D5 取消语义（Q-011，B3 定稿）

**取消窗口：仅 installing 阶段可取消**。`cancelInstall()`：
- `phase !== installing` → 幂等返回（swap 起始后/ready 后收到取消 → 忽略——cancel 入口 phase 边界检查即拦截，竞态以替换完成态为准）
- `cancelled` 标志置位（防 npm 非零退出误映射为 npm-install-failed）
- npmRunner **内联 kill**（B10 简化，~20 行）：`child.kill('SIGTERM')` → 5s 宽限 → `child.kill('SIGKILL')`——spawn 非 detached，无进程组；崩溃残留由 ensure() 态 1 幂等清理兜底
- `rm -rf staging` → 状态回 not-installed，emit cancelled
- 首装回滚失败（无 previous）→ 回 not-installed，**cancelled 语义**（非 npm-install-failed）

⚠️ B10 简化落稿：**processGroup 抽离删除**——npmRunner 内联 kill 即可（非 detached 场景），S1 RuntimeManager 保持私有实现不动（S1 零改动双保险）。

### D6 Node 捆绑落位

- 构建期：`scripts/fetch-node.mjs` 下载 Node 24 LTS 锁定小版本（nodejs.org 或镜像，`HULL_NODE_MIRROR` env 可配；契约 T2-06 检查点），产出版本文件 + 内嵌资源供壳打包（S2 打包交付）。**完整性校验（Tier 2）**：拉取官方 `SHASUMS256.txt` 校验 tarball SHA256（构建期，防篡改/损坏）
- 运行时：InstallFlow 步骤① 从内嵌资源解压到 `<userData>/node/`（若不存在）——S1 偏离 3 已定解析顺序 `HULL_NODE_PATH → <userData>/node/bin/node → PATH`，S2 落位后自动生效，RuntimeManager 零改动
- dev 模式无内嵌资源 → 跳过解压，走 PATH 兜底（S1 现状不变）
- 解压完整性校验：版本号文件存在且内容匹配；**prod 装配失败（解压失败/缺失）→ `runtime-unavailable`**（错误集六码，可重试：修复后）

### D7 磁盘预检（W2 实现时处理）

安装前 `statfs` 检查可用空间 ≥ **1GB 固定阈值**（node 解压 ~100MB + dsh 包几十 MB + 余量；原型注记「约几十 MB」）。阈值估算来源待 S3/S4 精化（W2 承接，注释标注估算依据）。不足 → `disk-insufficient`。

### D8 状态机

- **A**：xstate 等状态机库
- **B**：EventEmitter 子类 + TRANSITIONS 迁移表（复用 S1 D7 模式）→ **选 B**

三态（not-installed / installing / ready）+ 迁移表照契约 §状态转换（见 §4.3）+ 安装事件照契约事件表（progress/success/cancelled/failed）+ `snapshot()` 深拷贝。`ready → installing` 预留在表内（S3 升级复用 install() 的承载点，S2 无路径触发）。

### D9 S1 集成（B1/B4/B6/B7）

`main/index.ts` 启动流程改造：

```
app ready →
  OverlayManager.ensure() 三态（B4，Q-004/CON-R014 对齐）：
    态1 dsh 存在 → 清 stale staging（幂等）→ 原流程 RuntimeManager.start()
    态2 dsh 缺 + staging 在 → 续替（InstallFlow 续跑 swap 段；T3-03 升级中断恢复验收对齐）
    态3 dsh 缺 + previous 在 → 回滚（rename previous → dsh）→ RuntimeManager.start()
    首装（无 previous）→ not-installed → 自动触发 InstallFlow 安装（进度视图，可取消）
      → success → RuntimeManager.start() → 官方 UI
      → cancelled → 引导态（安装按钮，手动重装）
```

- **B7 start() 失败语义**：install success 即提交（swap 后版本校验通过即 ready）；后续 `RuntimeManager.start()` 失败归运行时失败域（S1 failed 态占位页 + retry），**不触发安装回滚**
- preload 桥扩展（B6）：`hull.install()` / `hull.cancelInstall()` / `hull.installStatus()`——**invoke 轮询 250ms**（main 侧 InstallFlow.on(progress) 事件由 OverlayManager.installStatus() 承载），替代事件订阅推送；「不透传回调」不变式成立；IPC 通道收敛为三个 invoke。⛔️ 偏离 1 见 §8（已合入契约 v0.2）
- **S1→S2 集成注记（Tier 2）**：RuntimeManager 经 `buildSpawnArgv(nodePath, dshBinPath(overlayDir))` 启动——`dshBinPath` 落点 `<overlayDir>/bin/dsh` 即 swap 后 symlink 目标，S1 侧零改动（依赖链完整：overlay 就绪 → start() → bin/dsh symlink → node_modules 真实入口）

**并发约束**：installing 期间 RuntimeManager.start() 被启动流程锁定（首装路径天然串行：start() 只在 install success 后调用）；S3 升级路径（ready 中 install）由 S3 编排 stop→install→start，S2 不实现。

### D10 测试策略

- **单测必选**（node:test，S1 模式）：安装状态机迁移/冲突行为、目录操作（临时目录）、错误映射、取消路径（fake npm 子进程 + kill 记录）、原子替换顺序与回滚（临时目录模拟 rename 失败）、版本校验
- **集成测试**：真实 npm install 到临时目录（registry 可达时跑；包名注入便于测试；`@deepseek-ai/dsh` 包存在性已核：契约 v0.2 引用共识 §8 实测 latest = 0.1.0-rc.6（2026-08-14 实测），实现期需重验）——正式集成归 S7
- npm 执行经 spawnFn DI，单测不真跑 npm

---

## 3. 模块划分

| 模块 | 职责 | 依赖 | 契约接口 |
|---|---|---|---|
| `overlay/OverlayManager.ts` | 安装状态机 + 原子替换（swap）+ pre-swap 门禁 + post-swap bin symlink + swapBack 回滚原语（契约 #10，S3 rollback 承载）+ ensure/install/cancelInstall/installStatus/currentVersion；staging/previous 目录管理 | npmRunner、Logger | #1~#3 #5 #6 #9 #10 |
| `overlay/InstallFlow.ts` | 安装编排：node 解压 → 磁盘预检 → install()（staging）→ swap() → success；on(progress) 事件 | OverlayManager、npmRunner | #4 |
| `overlay/npmRunner.ts` | npm-cli spawn（参数串/registry env/cwd/600s 超时/--fetch-timeout）+ 输出行缓冲（落 dsh 日志）+ 退出码 → 错误映射 + 内联 kill（取消，~20 行） | spawnArgs 风格单点收敛 | — |
| `scripts/fetch-node.mjs` | 构建期 node 24 LTS 下载（锁定小版本，镜像 env 可配，SHASUMS256.txt 校验，版本文件产出）——构建脚本，不进 src | — | — |
| `main/index.ts` | 启动集成改造：ensure() 三态分支 + 自动触发安装 + hull:install/cancelInstall/installStatus IPC（轮询） | OverlayManager、InstallFlow、RuntimeManager、WindowManager | #1~#4 #6~#9 |
| `preload/index.ts` | 桥扩展：install / cancelInstall / installStatus（三个 invoke，不透传回调） | — | — |
| `renderer/placeholder.html` | 引导态视图（未安装：安装按钮 + footnote）+ 安装进度视图（进度条 + 阶段文字 + 取消按钮，照原型；installStatus 轮询 250ms） | — | — |

**依赖方向**（单向，无环）：`main/index → {OverlayManager, InstallFlow, RuntimeManager, WindowManager}`；`InstallFlow → OverlayManager → npmRunner`；均依赖 SettingsProvider/Logger（S1 已有）。

**S2→S3/S4 承载点**（接口冻结）：`OverlayManager.swap()` 即 S3 SwapManager.swap() 复用入口（契约 #9 对齐）；`OverlayManager.swapBack()` 即 S3 Updater.rollback 回滚反向原语（契约 #10，rename dsh→staging 保留现场 + previous→dsh）；`OverlayManager.install(targetVersion)` 即 S3 升级 staging 段复用；`currentVersion()` 即 S4 版本展示数据源；`npmRunner` registry env 透传即 S4 通道配置落点（S4 走变更传播扩展 settings 面）。

---

## 4. 关键机制实现形态

### 4.1 原子替换序列（D3，B2 修订）

```
install(targetVersion):                     # 仅 staging（契约 #2）
  npm install @deepseek-ai/dsh@<version> --prefix staging --fetch-timeout=30000（600s 总上限）
  pre-swap 门禁：staging/node_modules/.bin/dsh 存在
    + node_modules/@deepseek-ai/dsh/package.json bin 字段合法（npm --prefix 不产 staging 根 package.json）
    不通过 → version-invalid（不进入替换）

swap():                                     # 原子替换（契约 #9，对齐 S3 #6）
  ① rm -rf dsh-previous                      # 旧备份清场
  ② rename dsh → dsh-previous                # 当前版退为备份（首次安装 dsh 不存在 → 跳过）
  ③ rename staging → dsh                     # 新版本位（同卷原子）
  ④ ③ 失败 → 回滚：rename dsh-previous → dsh
     首装回滚失败（无 previous）→ 回 not-installed，cancelled 语义（非 npm-install-failed）
  ⑤ post-swap：symlink <dsh>/bin/dsh → <dsh>/node_modules/.bin/dsh（S1 spawnArgs 零改动）
  ⑥ 版本记录：targetVersion 显式 → pre-swap 门禁已验；latest → 记录实际版本（currentVersion 数据源）
```

### 4.2 取消路径（D5 / Q-011，B3 定稿）

```
cancelInstall():
  phase !== installing → 幂等返回（swap 起始后/ready 后取消忽略——入口 phase 边界检查拦截）
  cancelled 标志置位（防 npm 非零退出误映射为 npm-install-failed）
  npmRunner 内联 kill：child.kill('SIGTERM') → 5s 宽限 → child.kill('SIGKILL')（非 detached）
  rm -rf staging
  状态 → not-installed，emit cancelled
竞态：swap 起始后收到取消 → 忽略（以替换完成态为准，事件序 success 先发）
```

### 4.2b swapBack 回滚原语（契约 #10，S3 评审波补）

```
swapBack():                      # S3 Updater.rollback 承载；非复用 swap() 内部 rollbackSwap（语义相反）
  previous 不存在 → 错误语义（rollback-unavailable 域）
  rename dsh → dsh-staging       # 当前（新）版退回 staging，保留现场
  rename dsh-previous → dsh      # 原版恢复
```

### 4.3 安装状态机（D8，契约 §状态转换）

```
TRANSITIONS:
  not-installed → [installing]
  installing     → [ready, not-installed]
  ready          → [installing]（S3 升级承载点预留，S2 无路径触发）
冲突行为：installing 中重复 install 忽略（幂等）；取消/失败 → not-installed（清理 staging）；
         引导态重装 = not-installed → installing。
事件（契约安装事件表）：progress{phase,pct} / success{version} / cancelled / failed{code,message}
```

### 4.4 错误映射表（契约 INSTALL_ERRORS 六码）

| 错误码 | 触发条件 | 状态/事件 | UI 提示 | 可重试 |
|---|---|---|---|---|
| registry-unreachable | registry 不可达/超时（npm 错误码 ECONNREFUSED/EAI_AGAIN/ETIMEDOUT/ENOTFOUND/ECONNRESET，或 --fetch-timeout=30000 触发） | failed | 提示 + registry 配置入口（T2-04） | 是 |
| npm-install-failed | npm install 非零退出（非网络类）或 600s 总超时 | failed | 按钮下方失败提示 | 是 |
| disk-insufficient | 磁盘预检不足（D7） | failed | 明确提示（清磁盘后重试） | 否（清磁盘后是） |
| cancelled | 用户取消（D5，cancelled 标志） | cancelled → not-installed | 引导态 + 安装按钮 | 是 |
| version-invalid | 目标版本号非法 / staging pre-swap 门禁不通过 | failed | 校验拦截（S4 提供列表） | 否 |
| runtime-unavailable | 捆绑 node 解压失败/缺失（prod 装配失败） | failed | 提示（修复后重试） | 是 |

### 4.5 进度事件载荷（D4）

```
{ phase: 'download' | 'npm-install' | 'swap', pct: number }
download: 10%   （node 解压 + 磁盘预检）
npm-install: 50%（子进程执行中，spinner + 阶段文字承载观感）→ 90%（退出成功）
swap: 100%      （原子替换完成）
```

### 4.6 node 解压落位（D6）

```
InstallFlow 步骤①：
  内嵌资源存在（打包产物）→ 解压到 <userData>/node/（不存在时）
    完整性校验：版本号文件存在且内容匹配 → 通过；失败/缺失（prod）→ runtime-unavailable（可重试：修复后）
  dev 模式无内嵌 → 跳过（PATH 兜底，S1 现状）
  npmCliPath 解析：<userData>/node/lib/node_modules/npm/bin/npm-cli.js（捆绑存在时）
```

---

## 5. 工程基线

**判级**：复杂+安全敏感（与头部一致）。

| 项 | 现状 | S2 动作 |
|---|---|---|
| git | 已有 | 直接复用 |
| 脚手架 | S1 完成（TS + Electron 43 + tsc 构建） | 跟随，不引入新依赖——npm 执行用捆绑 node 自身（D2），测试用 node:test（S1 模式） |
| 测试框架 | node:test（沿用 S1 模式） | 沿用；新增 overlay 单测 + 可选集成测试（D10） |
| 脚本 | build/typecheck/test/dev | 新增 `scripts/fetch-node.mjs`（构建期手动/CI 调用，不进 package.json scripts 也行，S2 交付时定） |

**S1 复用清单**：spawnFn DI 模式（D2）、TRANSITIONS 迁移表模式（D8）、RuntimeLogger/NOOP_LOGGER（shared）、Logger dshLog（npm 输出落盘）。killProcessGroup **不抽离**（B10：npmRunner 内联 kill，S1 保持私有实现不动）。

---

## 6. 目录/工程结构（新增部分）

```
dsh-hull-desktop/
├── scripts/
│   └── fetch-node.mjs              # 构建期 node 24 LTS 下载（锁定小版本 + SHASUMS256 校验 + 版本文件）
├── src/
│   ├── overlay/
│   │   ├── OverlayManager.ts       # 安装状态机 + swap 原子替换 + 门禁 + bin symlink + swapBack（契约 #1~#3 #5 #6 #9 #10）
│   │   ├── InstallFlow.ts          # 安装编排 + progress 事件（契约 #4）
│   │   └── npmRunner.ts            # npm-cli spawn 单点收敛（参数/registry env/超时/输出/错误映射/内联 kill）
│   ├── main/index.ts               # 启动集成改造（ensure 三态分支 + 自动触发 + 安装 IPC 轮询）
│   ├── preload/index.ts            # 桥扩展（install/cancelInstall/installStatus 三个 invoke）
│   └── renderer/placeholder.html   # 引导态视图 + 安装进度视图（照原型，installStatus 轮询 250ms）
```

overlay 布局（`<userData>/`，壳可写）：`dsh/`（常驻运行时）、`dsh-staging/`（安装中）、`dsh-previous/`（上一版回滚素材）、`node/`（捆绑 Node，S2 落位）。

---

## 7. 风险与对策

| 风险 | 影响 | 对策 | 归属 |
|---|---|---|---|
| registry 不可达/慢（T2-04） | 安装失败/超时 | 超时 + registry-unreachable 错误映射 + 配置入口；重试可 | S2 |
| npm 输出与进度耦合 | 进度误判/解析脆弱 | D4 阶段粒度 + 粗估算，UI spinner 兜底 | S2 |
| 原子替换失败 | 目录损坏/不可启动 | D3 回滚序列（dsh-previous → dsh）+ 安装后版本校验 | S2 |
| 磁盘不足 | 安装失败 | D7 预检（1GB 阈值）→ disk-insufficient 明确提示 | S2 |
| 取消竞态（完成瞬间） | 状态不一致 | D5：swap 完成后取消被忽略，以替换完成态为准 | S2 |
| node 内嵌资源缺失（dev） | 捆绑失效 | D6：跳过解压走 PATH 兜底 + 告警 | S2 |
| 包版本校验失败 | 装错版本 | D3 ⑤ 校验 + 回滚 + version-invalid | S2 |
| DSH_HOME 零接触防呆 | 用户数据被误改（红线） | 安装流程全程不 touch ~/.dsh；环境变量只透传（CON-R002/010）；代码评审 checklist 加「安装路径出现 DSH_HOME 引用 = 阻断」 | S2 起持续 |
| npm 子进程残留（取消后/崩溃） | 孤儿进程 | B10：spawn 非 detached，child.kill() 内联终止；崩溃残留由 ensure() 态 1 幂等清理兜底 | S2 |

**红线逐条处置（B9）**：
- CON-R002 / CON-R005：维持 ✓——安装流程全程不 touch ~/.dsh（环境变量只透传）；swap 回滚序列保证原子性
- CON-R007：捆绑 node 装配失败（解压失败/缺失）→ `runtime-unavailable`（错误集六码，可重试）
- CON-R008：overlay 布局对齐——dsh/staging/previous 三目录 + post-swap `bin/dsh` symlink 入口
- CON-R016：自动首装（进度可观察、可取消）；取消 → 引导态（安装按钮重装）；不提供永久跳过

**实现前注记**（评审补充，冻结时记录）：

- **P2 注记（实现期处理）**：非 detached spawn 下 npm install 执行期会派生孙进程（tar/postinstall），取消/超时后 `child.kill()` 只杀主进程——残留孙进程继续写 staging。闭合路径三选一（实现期验证定）：`--ignore-scripts`（若 dsh 无需 scripts）/ 验证 @deepseek-ai/dsh 无 install scripts 后接受 / 保持 detached 进程组。危害有限（临时文件泄漏 + inode 占用），**不得阻塞实现**
- **P3 注记（S3 评审时处理）**：
  ① S3 契约 #6 `SwapManager.swap()` 与 S2 #9 `OverlayManager.swap()` 承接方式（薄封装或更名）
  ② swap 失败错误码域跨契约映射（S2 npm-install-failed vs S3 install-failed/swap-broken）
  ③ S3 `Updater.rollback()` 无 S2 承载声明
  ④ 态 2 续替后无 verify/rollback 段（S3 契约空白）

---

## 8. 契约/共识对照与偏离标注

| # | 偏离点 | 契约/共识原文 | 设计取值 | 理由 |
|---|---|---|---|---|
| 1 | preload 桥扩展（**已合入契约 v0.2**） | S1 契约 #7 桥仅 `hull.retry()` / `hull.openLogs()` | 扩展 3 通道：`hull.install()` / `hull.cancelInstall()` / `hull.installStatus()`（**invoke 轮询 250ms**，非事件订阅推送） | 契约 v0.2 A1 已列 #7/#8 IPC 通道 + installStatus 轮询注记；「不透传回调」不变式成立；与 S1 偏离 4 同族（壳内部实现细节） |
| 2 | 首装自动触发（**已合入契约 v0.2**） | 原稿：无 overlay → 引导态 → 用户手动点安装 | 自动触发 InstallFlow（进度视图可取消）→ 取消后才进引导态（手动重装） | 契约 v0.2 A2 已封口：全新机器首开自动装 dsh（验收 T2-01）；取消 → 引导态保留手动重装路径（Q-011） |
| 3 | registry env 化（设计保留标注 + S6 变更传播修订） | 原稿：settings.json `registry` 字段（共识 §6 有该字段） | **settings.registry 字段优先 + `HULL_REGISTRY` env 兜底**（S6 契约 v0.2 落地 settings.json 字段后修订）；npm 透传 | S6 契约 schema 明确 registry 字段 + T6-05 验收要求持久化；S6 打开写面后 env 降为兜底（变更传播） |

**非偏离的契约忠实点**：安装状态机三态与冲突行为照契约 v0.2 §状态转换（自动触发 + 手动重装均可 / installing 重复 install 忽略 / 取消清理 staging）；INSTALL_ERRORS **六码**（registry-unreachable / npm-install-failed / disk-insufficient / cancelled / version-invalid / runtime-unavailable）；overlay 目录布局（dsh/staging/previous + bin symlink）；取消语义（仅 installing 可取消、cancelled 标志防误映射、引导态不提供永久跳过）；install/swap 拆分（契约 #2/#9，对齐 S3 #6）；install 总上限 600s + --fetch-timeout=30000；Node 24 LTS 锁定小版本（T2-06）；DSH_HOME 零读写（CON-R002/010）。

**开放问题承接**：W2（磁盘预检估算来源）→ D7 固定 1GB 阈值 + 注释标注，S3/S4 精化。

**T2 场景 → 设计落点**：T2-01 §4.1+D9（自动触发首装）；T2-02 §4.2+D5（取消 → 引导态 → 手动重装）；T2-03 全程 DSH_HOME 零接触（§7 红线）；T2-04 D2 env registry + §4.4 映射（env 入口 + README）；T2-05 D9 ensure() 态 1（有 overlay 不检查更新）；T2-06 D6 fetch-node 锁定版本 + SHASUMS256 校验。
