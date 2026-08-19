# S2 经验沉淀：npm --prefix 布局 与 跨契约接口粒度

> 三硬标准：可复用 / 非显而易见 / 有代价（均通过）
> 来源：S2 dsh 运行时管理（dsh-hull-desktop）实现与评审期

---

## Lesson 1：`npm install --prefix` 安装布局与 spawn 入口路径 seam

### 现象
`npm install --prefix <staging> @deepseek-ai/dsh` 的产物布局与直觉不同：
- **staging 根目录不产 package.json**（npm --prefix 只维护 node_modules + package-lock）
- 包入口在 `node_modules/.bin/<bin>`（npm 生成的 bin symlink），包元数据在 `node_modules/@deepseek-ai/dsh/package.json`

而 S1 的 `spawnArgs.dshBinPath(<overlayDir>)` 假设入口在 `<overlayDir>/bin/dsh`——S1↔S2 的路径假设直到**评审波**才被抓住（🔴-1 bin symlink 修复），代价是一轮评审往返。

### 对策
- **pre-swap 门禁校验实际布局**：swap 前验 `staging/node_modules/.bin/dsh` 存在 + 包 package.json `bin` 字段合法（不验不存在的 staging 根 package.json）
- **post-swap 建 symlink 对齐**：`<dsh>/bin/dsh → <dsh>/node_modules/.bin/dsh`（相对目标）——下游 S1 的 `dshBinPath` 现成路径零改动，跨 S 契约接口冻结不被破坏
- 失败降级：symlink 创建告警 + 重试一次 → 仍败走回滚序列（swap 的 ⑤ 步）

### 代价
- 多一个 symlink 维护点（升级/回滚都要重建/清理）；路径假设应在契约冻结前逐段对齐，而非评审波

---

## Lesson 2：跨契约接口粒度对齐（install/swap 拆分）

### 现象
S2 契约 v0.1 的 `OverlayManager.install(targetVersion)` 语义是「npm install 到 staging → 原子替换」一体的；而 S3 契约已定义独立接口 `#6 SwapManager.swap()`（升级替换步骤）。若 S2 的 install 含替换，S3 复用时会**重复替换**（S2 install 替换一次 + S3 swap 再替换一次）。

### 根因
上游（S2）起草接口时只从自身流程出发（首装 = install 到底），未对照下游（S3）契约的接口粒度；评审波才抓到 → 契约 v0.2 拆分为 `install()`（仅 staging）+ `swap()`（原子替换），对齐 S3 #6，升级流程直接复用。

### 对策
- 接口粒度在设计**起草时**就逐段对照下游契约核对（谁负责哪一段、边界在哪），不等到评审波
- 拆分后各自语义单一：install = 产物准备（staging 校验归它），swap = 提交（原子性 + 回滚 + 版本记录归它）；取消窗口以 swap 起始为界
- 同族教训：S1↔S2 的路径假设（Lesson 1）与 S2↔S3 的接口粒度，都是「跨 S 契约逐段对齐」缺失的不同表现

### 代价
- 晚发现 = 一轮契约修订波（v0.1→v0.2）+ 设计同步修订 + 变更摘要登记；若起草期对齐，成本近零
