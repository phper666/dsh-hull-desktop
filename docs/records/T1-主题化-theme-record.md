# theme 主题切换实现记录

> 关联：设计 docs/design/T1-主题化-theme-design.md · 契约 docs/api/feishu-s6-m1-api-contract.md · 共识 v1.1
> 子需求：T1（CSS 变量化 + 亮色集）/ T2（settings.theme + 设置页）/ T3（编辑器亮色）

## 判级

- 复杂（契约变更 settings.theme + 跨模块：shell/kanban/skills/easymde/SettingsProvider）→ 出技术方案 + 完整实现纪律

## 实现清单

| 文件 | 变更 | 归属 |
|:-----|:-----|:-----|
| src/renderer/shell.html | CSS 变量两套集（:root dark + [data-theme=light]）；内嵌样式变量化；body data-theme；设置页主题 segmented 区块；applyTheme/renderThemeButtons/setTheme；首载 async IIFE 应用主题 | T1+T2 |
| src/renderer/kanban.css | 192 行硬编码色值 → var(--hull-*) | T1 |
| src/renderer/skills.css | 126 行硬编码色值 → var(--hull-*) | T1 |
| src/settings/SettingsProvider.ts | theme 字段（读防御解析 + set 校验非法回退 dark + migrate 兜底），不 bump schema | T2 |
| src/renderer/vendor/easymde-dark.css | 硬编码色值 → var(--hull-*)，scoped [data-theme=dark] | T3 |
| src/renderer/vendor/easymde-light.css | 新增亮色变体，scoped [data-theme=light] | T3 |
| tests/e2e/settings.spec.ts + helpers.ts | T2-UI 主题切换 e2e 用例 + waitForSettingsTheme 助手 | T2 |

## 实现 vs 方案偏离

| 方案 | 实现 | 处理 |
|:-----|:-----|:-----|
| §7 风险「设置页即时切换闪烁」 | 未出现，data-theme 单属性切换无重载 | 无偏离 |
| 变量命名 | 方案列 8 个核心 token，实现扩展到 30+ 语义 token（danger/success/warning/info/purple 等） | 有意偏离：现有 css 语义色多样，全量变量化所需；记于本记录 |
| 首载主题应用 | 方案未明示，实现用 async IIFE（因 shell 普通 script 非 module 不能顶层 await） | 实现补丁，已修复 |

## 验证

| 项 | 结果 |
|:---|:-----|
| unit | 595/595 绿（含 T2 theme 6 用例） |
| integration | 8/8 绿 |
| e2e | 27/27 绿（含新增 T2-UI 主题切换） |
| typecheck | tsc --noEmit 无错 |
| Semgrep | 无输出（干净） |
| Code Review (ocr) | **降级**：ocr LLM 端点 401（余额不足），theme 非安全敏感，改用自查 + 记录 |
| lint | 项目无 lint 脚本（工具缺失，降级记录） |

## 修复的问题

- **shell.html 顶层 await**：des-3 首载主题应用用顶层 `await`（非 module script → SyntaxError），壳页脚本解析失败 → settings e2e 挂；改 async IIFE 修复
- **vendor/ gitignore 吞源码**：`.gitignore vendor/`（fetch-node 产物）误吞 src/renderer/vendor/（E1 编辑器资源）→ 豁免 `!src/renderer/vendor/**` 补录 7 文件（LESSON L1 第二次复现）

## 遗留

- 无已知遗留。T1/T2/T3 全部验收标准对照核验通过（见交付核验）。
