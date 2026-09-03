# 2026-09-04 壳导航 / Token 性能 / 设置页 UI 批量修复（散任务·常规级）

## 判级

**常规**——4 个用户报告 bug + 1 个排查中发现 bug，无新架构、无资金/安全路径，轻量实现管道。

## 实现记录

| # | 问题 | 根因 | 修复 | 文件 |
|---|------|------|------|------|
| 1 | 点进 Token 消耗卡顿 | `tokens:getUsage` 同步跑在主进程：缓存命中 ~300ms，活跃会话期全量重扫实测 11s | loadOrScan+summarize 挪 worker_threads，main 只参数校验 | `src/tokens/usage-worker.ts`（新）、`TokenUsageIpc.ts` |
| 2 | dsh web 加载完成抢焦点 | `onStatus` Ready/Failed/starting 三分支无条件强切视图 | `webIntent` 意图位：点 web/装完 dsh 置 true，点其他菜单清 false；三分支加守卫；Ready 补 `officialDirty`（保 D6 升级重载） | `WindowManager.ts`、`main/index.ts` |
| 3 | 设置页运行中/地址徽标错位 8px | 地址徽标变体类 `muted` 撞全局工具类 `.muted`（含 `margin-top:16px`），flex 按 margin-box 居中 | `.muted` → `p.muted` 限域（1 行）；顺带根治 notifs/workflows 徽标同 bug | `shell.html` |
| 4 | 复制地址按钮永远消失（排查 #3 时发现） | `renderDsh` 每 tick `innerHTML` 重建不含按钮 | ready 分支 statusHtml 补按钮 HTML | `shell.html` |
| 5 | 悬停复制按钮闪烁 | #4 同根：250ms 轮询无条件重建 DOM → hover 每秒丢 4 次 | renderDsh 加内容比对守卫（statusWrap+versionWrap），onclick 绑定入守卫 | `shell.html` |
| 6 | 全局 toast 观感差 | `wa-alert` 大卡样式 + 多条重叠 | 反色 pill（`--hull-text`/`--hull-bg` 互反 token，双主题自动高对比）+ 图标区分成功/错误 + `#toast-root` 堆叠 + 进出场（reduced-motion 降级）+ role=status/alert；15 处调用点零改动 | `shell.html` |

## 验证记录

- `npm run typecheck`：干净（多轮复核）
- `npm run build`：通过，`dist/tokens/usage-worker.js` 产出确认
- `npm run test:unit`：926 pass / 0 fail
- `npm run test:e2e`：全绿（cold-start / settings / install / upgrade / notifs；cold-start 托盘用例有计时型 flaky，复跑通过，非本改动引入）
- 真实 app probe（e2e helper 起 Electron）：徽标 top 761.59/761.59 对齐；toast 双主题+堆叠截图自查通过
- Token 扫描独立测量（tsx）：指纹 16ms / 冷扫 10.9s / 缓存命中 61ms / summarize 238ms → worker 化后主进程零阻塞

## Code Review

- `ocr review` 两次超时（5min/10min 无输出）→ 降级为人工全量 diff review：无高/中问题（守卫逻辑闭环、worker message/error/exit 三路 settled 防重、toast 错误判定启发式带 `ponytail:` 注记）
- `semgrep scan --config auto`：**改动文件 0 命中**。存量风险项（非本次改动，留档待后续处理）：
  - `src/connections/PlatformRegistry.ts:236/252` `rejectUnauthorized: false`（Blocking）
  - `src/renderer/depgraph.js:164` `replace('%','')` 单次替换（Blocking）
- eslint：未安装且无 lint script → 跳过，typecheck 代偿

## 交付核验

- 4 个用户报告问题全部修复并经用户验收（#2 徽标对齐经截图 + observer 二次确认根因）
- 判级匹配：实现复杂度 = 常规（无判级文档要求）✓
- 验证链完整：typecheck + 单测 + e2e + 真实 app probe 四层 ✓

## 沉淀（三硬通过）

见同目录 `2026-09-04-utility-class-collision.md` 与 `2026-09-04-polling-innerhtml-rebuild.md`。
