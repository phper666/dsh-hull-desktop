# N-笔记-notes 实现记录（N1~N4）

> 日期：2026-09-11 · 分支：feature/notes · 共识 v1.2 · 契约 N1 v1.1 / N2~N4 v1.0（冻结）· 方案：docs/design/N-笔记-notes-design.md（frozen）

## 实现范围

| 子需求 | 交付物 | 说明 |
|:-----|:-----|:-----|
| N1 | `src/notes/`（types/pathGuard/frontmatter/NotesStore/NotesScanner/NotesWatcher/NotesTrash/NotesService/NotesIpc）+ main 装配 + preload 桥 + ipc-channels + SettingsProvider notesDir/schemaVersion 4 | 原子写 + mtime 乐观锁冲突分流（改动三选/删除二选）；扫描跳过隐藏目录；chokidar watch（回声 1s 抑制 + 30s 降级）；回收站（restore 冲突不覆盖 + TTL≥30 天 + 500MB 循环删 + 启动/24h 检查）；路径安全域内校验；notes:mkdir |
| N2 | `src/renderer/notes.js/notes.css` + shell.html nav/section/状态机 | nav 第五入口；树/列表/编辑器三区；自动保存（debounce 2s + flush + Cmd/S）；全局搜索；新建/新建目录/移动/删除/回收站 UI；冲突分流 UI；就绪态占位；视图边界 |
| N3 | notes.js 交互层 + kanban.js 相关笔记行/📝 角标/跨模块入口 | 搜索型选择器；徽章双向跳转；零新 IPC（渲染层内部入口 `__kanbanOpenDetail`/`__notesOpenNote`/`__notesTaskRefs`/`__kanbanOnNotesChanged`） |
| N4 | shell.html 设置笔记卡 + SettingsProvider 校验 | 目录选择器/路径显示/复制（复用 pickDirectory + copyText）；换目录确认文案 + 前置脏处理；notes-dir-invalid 校验 |

## 验证记录

| 项 | 结果 |
|:--|:--|
| typecheck | ✅ clean（0 error） |
| unit | ✅ 1077/1077（notes 套件 61 用例；评审修复 +9；连续两轮全绿） |
| e2e | ✅ notes 6 场景 + kanban 8 + settings 3 = 17/17（主链路：新建→autosave 落盘→删除→回收站→恢复→新建目录→搜索→外部冲突分流） |
| semgrep | ✅ 0 findings（p/default + p/typescript + p/javascript，src/notes + notes.js） |
| code review | oracle：4🟠 + 6🟡 全部修复（win sep 归一/目录删除守卫/strategy 白名单/path 扩展字段/regex 转义/块边界统一/本地日期/restore 守卫/DSH_HOME resolve 双侧 + userData/dsh 禁区），每项配回归测试 |
| 交付核验 | ora-1 四层：①设计 PASS（1 有意偏离备案）②契约 PASS（2 处已回写）③PRD PASS（F1~F6 + 判级匹配）④UI 暂定 PASS（截图 /tmp/notes-view-fixed.png 待人工过目；docs/ui/UI规范.md 缺失记风险项） |

## 决策与踩坑（可复用）

1. **EasyMDE 分屏预览层是 `position:fixed`**——嵌入面板使用 `toggleSideBySide` 会盖住全窗右半屏（含模式切换控件），必须 `sideBySideFullscreen:false` + 容器 `position:relative` + 预览层改容器内 `absolute`（踩坑，代价=用户实测发现困死）
2. **shell.html 各视图 section 需在自己的 CSS 里写 `#x:not(.hidden)` 覆盖 + `#x-root` 撑满**——`.placeholder` 是居中样式，漏写则整个视图缩成团（踩坑，集成期发现）
3. **IPC 路径通道勿直传 resolve 后绝对路径**——store 再 join(root) 会双重拼接；守卫函数应返回相对路径（踩坑，e2e 期发现，单测直调 store 不暴露）
4. **飞书任务看板列移动**：`tasks patch` 的 tasklists+section_guid 语义不支持移列（field validation failed）；可用 `POST /tasks/{guid}/add_tasklist`（携 section_guid）实现（工具经验）

## 增补：目录删除（v1.3，2026-09-11）

- N1：notes:rmdir 通道（仅空目录——pathGuard + readdir 非空拒绝 notes-dir-not-empty；TDD 6 用例，先红后绿；契约 v1.2）
- N2：目录行 hover「×」+ 一次确认（文案注明不含回收站）+ 渲染层 subtreeCount 预检双保险 + 选中回退根；e2e 非空拒绝/空目录全链路/根行无入口 3 场景
- 验证：typecheck clean · unit 1094/1094 · notes e2e 9/9
