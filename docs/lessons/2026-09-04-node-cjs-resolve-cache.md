# 2026-09-04 Node CJS 解析缓存：跨目录交换后返回 stale realpath

**引用编号**：LESSON-20260904-03

## 现象

dsh overlay 目录 swap（staging → live 原子替换）后，升级验证启动子进程报 `MODULE_NOT_FOUND`，路径指向**旧版本的 .pnpm realpath**（已被 rename 掉）→ 验证失败 → 自动回滚。

## 根因

`dshEntryPath` 用 `createRequire(overlayDir/package.json).resolve('@deepseek-ai/dsh/package.json')` 解析入口——**Node CJS 解析缓存（Module._pathCache）以「request + parent 路径」为键、进程内不随文件系统变更失效**。同进程首次解析缓存了旧版 realpath；swap 后同 base 再解析 → 命中缓存 → 返回已被移走的旧路径。

实证：同进程对照实验——swap 后 `createRequire.resolve` 返回 v1 旧 realpath，`fs.realpathSync` 返回 v2 ✓（2026-09-04，Node 24）。

## 规则沉淀

1. **目录会被替换/交换的路径，解析入口禁用 createRequire.resolve**——用 `fs.realpathSync` 直击文件系统（无缓存）；或每次以不同的 parent 路径调 createRequire
2. 凡「解析 → 文件系统被外部变更 → 再解析」的模式（热升级、swap、容器层替换）都要过一遍这个坑
3. 症状特征：报错路径是**旧版本的真实路径**（带 hash 的 .pnpm 目录）而非符号链接路径——看到这种路径先想缓存

## 引用

- 实现记录：`docs/lessons/2026-09-04-kanban-exec-q017-batch.md` #4
- 修复：`src/runtime/spawnArgs.ts` dshEntryPath（realpathSync）；回归测试 `Q-017-D`
