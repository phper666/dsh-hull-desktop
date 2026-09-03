# 新手写源文件被 src/**/*.js 忽略反排除遗漏——commit「8 files」里少的那 1 个就是断链源头（第 3 次同族事故）

| 项 | 内容 |
|:---|:-----|
| 背景 | .gitignore 用 `src/**/*.js`（+曾用 `*.ts`）忽略 tsc 就地产物，手写源靠**逐文件反排除**（`!src/renderer/workflows.js` 等）。新建通知中心 notifs.js 时忘了加 `!src/renderer/notifs.js`：`git add src/` 静默跳过（无任何警告），commit 显示「8 files changed」（预期 9）没引起注意，worktree 删除时未跟踪的唯一副本一并销毁。合并进 main 后 shell.html `<script src="notifs.js">` 404 → IIFE 永不执行 → 铃铛无监听、角标恒空 → 用户侧「通知中心点击无反应」。**开发 worktree 里文件在所以一切正常，main/别人机器上必挂**——与 09-02 `void loadList` 同构的「跑过的环境 ≠ 交付的环境」。 |
| 决策或坑 | ①根因是机制而非手误：反排除制下「新建手写源」隐含两个动作（写文件 + 改 .gitignore），第二个动作没有任何强制点；②三层防线（按有效性排序）：**commit 后必跑 `git status --short`——untracked 里出现源码文件 = 有东西没进版本库**（本可用 `git status --ignored src/` 直接看到被吞文件）；commit 输出的「N files changed」与预期文件数核对（这次 8≠9 就是信号）；shell.html 引用的 renderer 资源全部 git 追踪的可脚本化检查（可加进 verify-acceptance，一行 glob diff，根治型）。③同族事故：v0.1.4 `*.ts` 宽泛忽略（S skills 断链）→ tokens/connections 补提 → 本次 notifs.js，每下一次的成本都比上一次高（这次烧到用户侧）。 |
| 影响 | 不这样做：每次新增手写 JS/TS 都在赌记忆；坏文件在开发机一切正常、合并/他人/CI 侧断链，且 worktree 清理会销毁证据。这样做：commit 前后各一眼 `git status --short`（untracked 源码 = 红灯）；.gitignore 反排除与文件创建同 commit；结构性根治 = verify 脚本校验「shell.html 静态引用 ⊆ git ls-files」。 |
| 适用范围 | 任何「ignore 产物 + 反排除源码」的仓库约定（tsc/esbuild/babel 就地输出；monorepo partial-tracking）；远程工作（worktree/临时目录）里 untracked 文件生命周期与目录绑定尤其致命。 |
| 来源 | 出生：需求 notify-center V1（2026-09-03，commit ebbcc7e 漏文件 → 4c3f9d7 紧急补提 + .gitignore 反排除）；引用 docs/design/工作流-workflows-design.md §9 |
| 引用 | 首次引用：本 lesson 出生（2026-09-03）；关联：docs/lessons/2026-09-02-workflows-void-loadlist-referenceerror-lesson.md（同「开发环境正常/交付断链」家族） |
