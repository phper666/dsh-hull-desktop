# S2 实现记录与核验记录

> 判级：复杂+安全敏感（跨模块协作（OverlayManager/InstallFlow↔S1 RuntimeManager）+ npm registry 外部系统集成 + 安装状态机 + 原子替换 + 安装软件安全面）
> 事实源：契约 `docs/api/feishu-s2-api-contract.md` v0.2（冻结 2026-08-17）、设计 `docs/design/S2-dsh运行时-design.md` 0.2（冻结 2026-08-17）

## 实现记录

### 文件清单
- `src/overlay/OverlayManager.ts` + 测试 — 安装状态机（TRANSITIONS 迁移表 + progress/success/cancelled/failed 事件）+ install（仅 staging，重复忽略、清 stale、pre-swap 门禁）+ swap（原子替换 ①~⑥ + 回滚序列 + bin symlink 重试降级）+ cancelInstall（仅 installing、swapping 拦截）+ installStatus/currentVersion/ensure 三态 + INSTALL_ERRORS 六码 + fs/npm/sleep DI
- `src/overlay/npmRunner.ts` + 测试 — npm-cli spawn（nodePath 推导路径、--prefix、--fetch-timeout=30000）+ HULL_REGISTRY env 透传 + 非 detached + 内联 kill（SIGTERM→5s→SIGKILL）+ 120s 总超时（now/sleep seam）+ 输出行缓冲（仅提取 `npm error code` 分类）+ cancelled 标志 + toRunNpmInstall 适配器
- `src/overlay/InstallFlow.ts` + 测试 — 编排：node 解压落位（版本文件完整性；prod→runtime-unavailable / dev→PATH 兜底）→ 磁盘预检（1GB 阈值）→ install → swap → success；on(progress) 转发；swap 后 phase 校验（cancelled 语义）
- `src/main/index.ts` — ensure 三态启动分支 + 首装自动触发 + IPC 三通道（hull:install/cancelInstall/installStatus）+ runInstallFlow（B7 start 失败不触发回滚）+ quitting 守卫（install 中退出先取消）
- `src/preload/index.ts` — 桥扩展 3 方法（install/cancelInstall/installStatus，无事件订阅）
- `src/renderer/placeholder.html` — installing 视图（250ms installStatus 轮询进度条 + 取消按钮）+ not-installed 引导态错误提示区
- `src/shared/types.ts` — InstallPhase/InstallProgress/InstallSnapshot + ChildLike 迁入（RuntimeManager 共用）
- `scripts/fetch-node.mjs` — 构建期 node 24 LTS 锁定小版本下载（darwin-arm64，SHA256 校验 SHASUMS256.txt，幂等复用，NODE_MIRROR env）
- `.gitignore` — 补 `vendor/`

### TDD：37 新用例（OverlayManager 23 / npmRunner 9 / InstallFlow 5），S1 60 回归 → 97 全绿

> 注：骨架预估 24/9/4，实测 23/9/5（OverlayManager 17 + 评审修复 6；InstallFlow 4 + 评审修复 1），总数 37 一致。

核心路径全测：状态机迁移/事件序列、swap 原子序列 + 失败回滚（fs rename 注入）、首装无 previous cancelled 语义、post-swap symlink（含失败重试降级 + swapping 复位）、pre-swap 门禁、版本校验、取消窗口（installing 中/swap 后忽略/门禁通过后取消）、ensure 三态（续替/回滚/rename 失败）、npm 参数串/registry 透传/错误分类（ECONNREFUSED 等五码）/120s 超时/kill 序列/cancelled 标志、InstallFlow 全流程/进度序列/解压失败 prod-dev 分支/磁盘预检、fetch-node 语法检查（构建脚本无单测，不真跑下载）

### 质量
- `npm run typecheck`（tsc --noEmit）：干净
- `npm test`：97 pass / 0 fail，~0.7s
- `npm run build`：dist/ 全量产出

## 核验记录

### Code Review
- 双席 AI review（oracle 有条件通过 C1~C3 / gamma 通过+文案级）→ 修复 7 项（🟡-1 swap 缺 cancelled 检查 + InstallFlow phase 校验 / 🟡-2 首装回滚 throw 码 / 🟡-3 swap try/finally + symlink 重试降级 / 🟡-4 ensure 态3 rename 保护 / Y-1 态2 文案 / Y-2 kill 注释 / 🟢-1 install catch 防双事件）→ ora-1 复评「通过」
- 修复全程 TDD：先补 7 测试（6 红于 OverlayManager + 1 红于 InstallFlow）再修实现

### Semgrep
- 1.172.0 自动配置 227 规则、28 文件扫描：0 findings

### 契约符合性（T2 场景对照）

| 场景 | 契约要求 | 单元级证据 | 状态 |
|---|---|---|---|
| T2-01 全新机器首装 | 自动安装进入官方 UI | ensure 首装分支（⑰）+ 自动触发（main D9）+ InstallFlow 全流程（⑪）+ 状态机（①） | 单元级 ✓，集成待 electron + 真实包 |
| T2-02 取消安装 | 取消→引导态→重装 | cancelInstall（⑨）+ 取消后 swap cancelled 语义（🟡-1）+ npmRunner cancelled 标志（⑥）+ InstallFlow cancelled（🟡-1） | 单元级 ✓，集成待 electron |
| T2-03 数据复用 | ~/.dsh 零改动 | 全程 DSH_HOME 零引用（main/overlay 代码审查项）+ 环境变量只透传 | 单元级 ✓（审查），集成待 electron |
| T2-04 registry 不可达 | 失败提示 + 配置入口 + 重试 | HULL_REGISTRY 透传（npmRunner ②）+ ECONNREFUSED 等五码分类（④⑥⑧）→ registry-unreachable | 单元级 ✓，集成待真实 registry |
| T2-05 断网启动（已有 overlay） | 正常使用不检查更新 | ensure 态1（⑬）+ S1 就位路径回归（90 回归含 S1 60） | 单元级 ✓，集成待 electron |
| T2-06 Node 版本验证 | 捆绑 Node = 24 LTS 锁定版本 | fetch-node.mjs（锁定常量 + SHA256 + 幂等）；默认版本常量待交付核对 | 构建脚本级 ✓，产物检查待构建期 |

### 环境阻塞
- electron 二进制未下载（github.com 不可达，`TypeError: fetch failed`）；恢复命令：`ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ node node_modules/electron/install.js`
- 真实 `@deepseek-ai/dsh` 包首装端到端重验（2026-08-18 网络恢复后：npm dist-tag latest = **0.1.0-rc.7**，包存在 ✓；npm install 因网络慢触发 --fetch-timeout=30000 超时 exit 1 → S2 超时路径真实生效 ✓，换 registry 源可解）
- fetch-node.mjs 下载验证待网络恢复（构建期执行）

### 风险登记
- **变更传播登记（2026-08-17 S3 评审波）**：S2 契约升 v0.3 补 **#10 `swapBack()`**（回滚反向原语：rename dsh→staging 保留现场 + previous→dsh；调用方 S3 Updater.rollback；幂等，无 previous → 错误语义）——与既有 🟢-A 登记关联澄清：S2 内部 `rollbackSwap` 为「替换失败即时回滚 + 清 staging」，语义与 swapBack（保留现场、供手动/自动回滚多次操作）相反，**swapBack 为独立新原语，不复用既有实现**；S2 代码零改动（仅契约/设计文档登记）
- **变更传播登记（2026-08-17 S5 评审波）**：**C3 关闭**——「打包专项取消，承载并入 S5」（extractNode 打包接线 + electron-builder.yml 由 S5 定案 a 落地，S5 设计 D8）；S2 契约零改动
- **C3 打包分期**：~~extractNode 接线归打包专项~~（已关闭：并入 S5，见上）；T2-06 验收口径随 S5 打包产物验收一并落地
- **P2 npm 孙进程残留**：非 detached spawn 下 npm install 派生孙进程（tar/postinstall），取消/超时后 child.kill() 只杀主进程——实现期验证三选一：`--ignore-scripts` / 验证 @deepseek-ai/dsh 无 install scripts / 保持 detached（危害有限，临时文件泄漏 + inode 占用）
- **🟢-A**：rollbackSwap ⑤ 注释与行为不符（注释写「如 ⑤ 回滚后存在」——实际 symlink 失败回滚时新版退回 staging 后被清理），待改注释
- **🟢-B**：回滚成功但 UI 报 failed 语义（旧版可用 + failed 事件并存）——归 S3 编排处理（升级场景统一提示语义）
- **S3 侧 P3 对齐项**：SwapManager.swap() 承接方式（薄封装/更名）、swap 错误码域跨契约映射（npm-install-failed vs install-failed/swap-broken）、Updater.rollback() 承载声明、态 2 续替后无 verify/rollback 段（S3 契约空白）
