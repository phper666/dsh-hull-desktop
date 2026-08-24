# pkgmgr 包管理器支持实现记录

> 关联：设计 docs/design/P1-包管理器-pkgmgr-design.md · 共识 v1.1（docs/spec/共识-Hull桌面壳-包管理器.md）
> 子需求：P1（执行器抽象）/ P2（spawn 跨平台改造）/ P3（settings+设置页+rebuild）

## 判级

- 复杂（跨模块：pkgMgr 执行器 + spawn 改造 + settings 契约变更 + 三端适配）→ 技术方案 + 完整实现纪律

## 实现清单

| 文件 | 变更 | 归属 |
|:-----|:-----|:-----|
| src/overlay/pkgMgr/types.ts（新） | PkgMgrRunner 接口 + PkgMgrResult/PkgMgrRunOptions/PkgMgrRunnerOptions | P1 |
| src/overlay/pkgMgr/npmRunner.ts（新） | BasePkgMgrRunner 基类（spawn/行缓冲错误解析/超时/SIGTERM→SIGKILL 取消）+ npm 实现（迁移旧逻辑）+ pnpm 实现 + yarn 实现 + NATIVE_DEP_PKGS + rebuild 钩子 | P1+P3 |
| src/overlay/pkgMgr/index.ts（新） | createPkgMgrRunner 工厂 + toRunNpmInstall 适配器 | P1 |
| src/overlay/pkgMgr/*.test.ts（新） | 三实现测试（命令/错误码映射/取消/超时/onLine/rebuild） | P1+P3 |
| src/overlay/npmRunner.ts（删） | 迁移至 pkgMgr/ | P1 |
| src/runtime/spawnArgs.ts | dshEntryPath（解析真实 JS 入口，兼容 pnpm symlink 布局）；buildSpawnArgv 改 entryPath | P2 |
| src/runtime/RuntimeManager.ts | spawn 用 dshEntryPath + ELECTRON_RUN_AS_NODE=1 + 剥离 NODE_OPTIONS/ELECTRON_* env | P2 |
| src/settings/SettingsProvider.ts | packageManager 字段（默认 pnpm，非法回退，不 bump schema） | P3 |
| src/renderer/shell.html | 设置页包管理器三选一（对齐 theme-seg） | P3 |
| src/main/index.ts | createPkgMgrRunner(settings.packageManager) 安装时按当前 settings 重建 | P3 |

## 实现 vs 方案偏离

| 方案 | 实现 | 处理 |
|:-----|:-----|:-----|
| §4.3 nodeBin 用 process.execPath + ELECTRON_RUN_AS_NODE=1 | 实现用 resolveNodePath（捆绑 node 优先，dev 走 PATH）+ ELECTRON_RUN_AS_NODE=1 + 剥离 env | **有意偏离**：保留现有捆绑 node 能力（打包分发场景），ELECTRON_RUN_AS_NODE+剥离 env 已解决跨平台核心；若要严格 process.execPath 仅 1 行改动 |
| §4.4 rebuild 位置（InstallFlow vs 实现内） | 实现放 pkgMgr 各实现的 install() 成功 path（BasePkgMgrRunner.rebuildCommand 钩子） | 实现选择，更内聚 |

## 验证

| 项 | 结果 |
|:---|:-----|
| unit | 644/644 绿（596 既有 + 48 新增） |
| integration | 8/8 绿（真实 spawn 经 lib/bin.js 入口就绪） |
| e2e | 27/27 绿（假 registry 场景显式 npm——P3 默认 pnpm 后假 registry 不兼容，e2e 适配） |
| typecheck | tsc --noEmit 无错 |
| Semgrep | 待跑 |

## 关键决策

- **默认 pnpm**（冷装 28s vs npm 28min，实测）+ 设置页三选一（npm/pnpm/yarn）
- **spawn 不依赖 .bin shim**（dshEntryPath 解析真实入口），三端 + 三包管理器兼容
- **pnpm 装完自动 rebuild 原生依赖**（koffi/node-pty/protobufjs/@google/genai/dsh-subprocess-local），失败告警不阻断；yarn/npm 默认 build 无需显式
- **e2e 假 registry 场景显式 npm**（假 registry 为 npm 设计）

## 遗留/待拍板

- **yarn rebuild**：当前未加显式 rebuild（yarn 默认跑 build scripts），若实际装机发现原生依赖未 build 需补 `yarn rebuild <pkgs>`
- **process.execPath vs resolveNodePath**：当前 resolveNodePath（捆绑 node 优先）；若需严格 process.execPath 可改 1 行
- **rebuild 清单固定**：NATIVE_DEP_PKGS 硬编码，dsh 未来加原生依赖需同步（可后续改为动态读）
- 手动 UI 确认（设置页包管理器三选一）未执行——逻辑按 theme-seg 同构，e2e 有主题先例
