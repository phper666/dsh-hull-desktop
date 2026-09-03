# UI 视觉优化 P1/P2 剩余项 技术方案

> 判级：**复杂**（6 渲染文件跨页 UI 体系重构）→ 本文档
> 来源：飞书 ticket t100109（UI 视觉调研 P0 落地后的剩余项，2026-09-02 启动）
> 调研：docs/research/2026-08-30-ui视觉调研.md · designer 盘点（2026-09-02，六文件全量扫描核实）
> 范围：shell.html + skills.css + kanban.css + connections.css + workflows.css + tokens.css（Electron 渲染层无构建，CSS `<link>` 直引）

## 一、剩余项核实（designer 盘点 2026-09-02）

| # | 项 | 现状 | 结论 |
|:--|:---|:-----|:-----|
| P1-e | 组件系统 | **6 套平行**：按钮 .sbtn/.sk-btn/.kb-btn/.cn-btn/.wf-btn/.tk-btn；输入 5 套；弹窗 .sk-modal/.kb-modal-box；徽标 5 套；switch 4 套。值已全走 --hull-* token，差异仅 padding/font-size 微差——纯重复定义 | 收敛 |
| P1-f | 间距/字阶 | `--space-1..6` 已定义（shell:79）**零使用**；字阶无 --text-*，font-size 硬编码 7-9 档（9-30px） | 迁移 |
| P1-g | mono 内联 | 已解决（--font-mono 单点定义） | ✅ |
| P1-h | surface ladder | tokens/skills/kanban 已达 hull-card+shadow；**connections/workflows 0 处、shell 设置页纯边框** | 推广 |
| P2-i | 品牌锚点 | 仅 tokens 有（tk-mark + tk-empty-ico）；nav 纯文字、4 页空态纯文字 | 补齐 |
| P2-j | 亮色一等公民 | 基本解决（hex 硬编码 0 处）；**残余 3 处 switch knob rgba**（shell:231/connections:63/workflows:32）+ --hull-primary 别名残留 2 处使用 | 清理 |

额外：WA（webawesome）已接好但仅 toast 在用；modal/switch/select 换 wa-* 真组件列**可选大项暂缓**（动 JS/HTML 风险高）。

## 二、方案

### A. 共享组件基类（P1-e）——别名收敛，只动 CSS 不动 JS/HTML
- 基类放 shell.html 全局 `<style>`（六页已 link shell，天然共享；不新建 css 文件）
- 基类一份定义：
  - `.btn`：padding 6px 12px / radius-md / bg hull-border / hover hull-hover / focus-visible / disabled / transition 120ms
  - `.input`：padding 7px 10px / radius-md / focus border-accent（含 select/textarea 同基）
  - `.badge` + 语义修饰 `.badge--ok/--warn/--err/--info/--muted`
  - `.switch`：4 套收 1，knob 阴影走主题化 token（顺带修 3 处 rgba）
  - `.modal-wrap`（fixed overlay）+ `.modal-box`（radius-xl + shadow-2 替代纯边框）
- 页面类变别名：`.sk-btn,.kb-btn,.cn-btn,.wf-btn,.tk-btn { /* 继承基类，仅留页面特有差异 */ }`；页面 css 删重复定义
- 防冲突：用显式组合选择器/前缀，避免裸类名抢占（先例：.card 冲突 skills.css:103）

### B. 间距/字阶 token（P1-f）
- 间距：沿用已定义 `--space-1..6`（4/8/12/16/20/24），六文件 padding/margin/gap 硬编码 px 归并到档位
- 字阶：shell 加 `--text-2xs:10px / --text-xs:11px / --text-sm:12px / --text-md:13px / --text-lg:15px / --text-xl:17px / --text-2xl:20px`，六文件 font-size → var(--text-*)；tokens 图表 9px 标签留特例注记

### C. surface ladder 推广（P1-h）
- connections（cn-card 等）+ workflows（wf-card/wf-step/wf-run）：panel+border → hull-card + shadow-1 + hover 微上浮
- shell 设置页 scard/升级卡：同上
- 层级约定：bg < panel < card < overlay；shadow-1 卡片、shadow-2 浮层/hover
- skills/kanban/tokens 已达标不动

### D. 品牌锚点（P2-i）
- nav-title logo：accent 渐变 12px 圆角方块（同 tk-mark 模式，纯 CSS）
- nav-item 图标：7 个 14-16px inline SVG stroke（不引图标库）——**可选大项**（动 shell.html 结构）
- 空态锚点：tk-empty-ico 模式（64px accent-soft 圆角容器 + SVG）推广到 skills/kanban/connections/workflows（4 页 JS 空态模板 + 共用 .empty-ico 基类）

### E. 亮色一等公民（P2-j）
- 3 处 switch knob rgba → var(--hull-shadow) 主题化（随 switch 基类收敛一并做）
- --hull-primary 别名：值已 aliasing accent，留注释不删（避免动静）

## 三、分批实施（先结构后视觉，每批独立合入可回滚）

| 批 | 内容 | 观感 | 验证 |
|:---|:-----|:-----|:-----|
| **1 基类地基** | A 全部（基类+6文件收敛+switch+rgba）+ D 的 nav-title logo | 零变化 | node --check 各 js（不动）+ css 语法 + 用户亮/暗走查 6 页 |
| **2 令牌机械迁移** | B 全部（--text-* 定义 + 六文件 font/spacing → var） | 零变化（值不变） | 截图对照应完全一致 |
| **3 观感增量** | C 全部（connections/workflows/shell surface ladder）+ D 空态锚点（4 页）+ nav 图标（可选） | 变化 | 亮/暗 + 空态/弹窗/开关逐页走查 |

## 四、风险

| 风险 | 缓解 |
|:-----|:-----|
| CSS 大范围改动破坏页面 | 分批 + 每批独立 commit 可回滚；类名收敛用别名不删页面类（JS 引用不受影响） |
| 无自动化视觉测试 | 每批用户亮/暗两主题逐页走查后才合下一批 |
| 裸类名冲突 | 显式组合选择器/前缀 |
| 空态改 JS 模板 | 单独放批 3 重点验证 |
