# UI P1：令牌化 + 主题跟随系统 技术方案

> 判级：常规偏复杂（新依赖引入 + 渲染层架构调整 + 主题共识 v1.1 变更）→ 出本文档
> 来源：UI 调研报告 docs/research/2026-08-30-ui视觉调研.md 第四/五章（P1 提案）+ 用户需求「设置主题加跟随系统」
> 关联共识：CON-R-theme-001~005（本次扩展 006，共识 v1.0 → v1.1）

## 一、目标与范围

1. **主题跟随系统**：settings.theme 枚举扩展 `dark | light | system`；`system` = 跟随 OS 亮暗（含运行时实时切换）
2. **令牌化（第一增量）**：新增几何/字体/动效令牌层（radius/shadow/motion/mono），三渲染文件值替换
3. **Web Awesome 引入**：vendor Free 版 + 行为组件渐进迁移（本增量完成 vendor + CSP + 首个组件验证；全面迁移见 §6 排期）

不在本范围：spacing 栅格 token（替换面过大，随 P1.2 增量）、P2 品牌个性、dsh 官方 UI（CON-R001）。

## 二、主题跟随系统设计

### 2.1 数据与规则

- `ThemeName = 'dark' | 'light' | 'system'`（SettingsProvider 唯一事实源）
- 归一化：非法值/旧数据 → 回退 `dark`（CON-R-theme-004 不变，默认仍 dark 不改）
- 持久化：settings.json `theme` 字段，字段级扩展 **不 bump schemaVersion**（CON-R-theme-003 先例）

### 2.2 解析链（关键设计）

```
main 启动/set(changed) → nativeTheme.themeSource = settings.theme（'system' 原生透传）
renderer → theme === 'system' ? matchMedia('(prefers-color-scheme: dark)') : theme
         + system 态监听 matchMedia 'change' → 实时跟随 OS 切换
```

- 选 `nativeTheme.themeSource` 而非 main 手动解析广播：**Electron 会把 themeSource 注入整棵渲染树的 prefers-color-scheme**——renderer 的 matchMedia 自动跟随（OS 切换与用户改设置两条路径统一，零推送协议）

### 2.3 UI

- 主题 segmented 三选：暗色 / 亮色 / 跟随系统；aria-pressed 反映设置值；sub 文案「跟随系统亮暗设置」

## 三、令牌化设计（值保持替换，不做视觉变更）

`:root` 新增（颜色仍走 `--hull-*` 主题变量）：

- 圆角：`--radius-xs 4 / --radius-sm 6 / --radius-md 8 / --radius-lg 10 / --radius-xl 12 / --radius-pill 999`（值保持现状五档+药丸；**归并三档推迟**——值保持优先，归并随 P2 视觉走查一起做）
- 阴影：`--shadow-1`（卡片）/ `--shadow-2`（悬浮）
- 动效：`--dur-fast 120ms / --dur-med 200ms / --ease-out`
- 字体：`--font-mono`（消除 5 处内联重复）

替换范围：`border-radius: Npx;` 单值声明（多值简写保留原样并注记）；已知 box-shadow 两处；动效时长 6 处；mono 栈 5 处。`prefers-reduced-motion` 守卫沿用。

## 四、Web Awesome 引入设计

- vendor：`@awesome.me/webawesome@3.0.0` dist-cdn（styles + loader + chunks）→ `src/renderer/vendor/webawesome/`；CSP self 同源可用（CON-R-editor-001 先例）
- 渐进迁移第一增量：**toast（shell）**——手写 toast div → `wa-alert` 动态创建；dialog/switch/select 后续增量（每类一个 PR，可回退）
- 主题：WA 令牌（`--wa-color-brand-*` 等）由 `--hull-*` 映射（演示原型已验证）
- 体积：vendor 约 +100~200KB（懒加载 chunk 按需取），相对 app 452M 可忽略

## 五、风险与回退

| 风险 | 缓解 |
|:-----|:-----|
| system 态下 renderer matchMedia 与 Electron themeSource 时序 | matchMedia 是被动读取（非事件竞态），切设置即重算 |
| token 替换漏改/错改 | 值保持替换（不视觉变更）+ 走查清单 |
| WA autoloader 在 CSP 下加载失败 | 本地 vendor 同源；首个组件（toast）落地即验证，失败可整体回退（vendor 目录隔离） |
| 旧 settings.json 无 system 值 | 归一化回退 dark，零迁移 |

## 六、排期

1. 本 PR：主题跟随系统 + 共识 v1.1 + 令牌层第一增量
2. 下增量：WA vendor + toast/dialog 迁移（需 dev 运行验证循环）
3. 后续：spacing token、组件类合并、P2 品牌个性
