# S1 Skills 扫描/列表/搜索 实现记录

> 判级：复杂+安全敏感（新 fs-management 子系统 + 读写用户 agent 配置目录，Q-037/Q-038）
> 事实源：契约 `docs/api/feishu-s1-skills-api-contract.md`、设计 `docs/design/S1-扫描搜索-skills-design.md`（D1~D7）
> 本记录覆盖：S1 全量实现（只读面：扫描/快照/状态计数/远程搜索）。S2 操作层见 `S2-skills-record.md`。

## 实现记录

### 变更清单

| 文件 | 变更 |
|---|---|
| src/skills/registry.ts | D1 六目录注册表（claude-code/opencode/codex/gemini-cli/cursor/shared）+ affectedPlatforms 数据驱动映射 + SHARED_DIR 常量，单点维护（CON-R-skills-001） |
| src/skills/frontmatter.ts | SKILL.md frontmatter 解析（name/description/metadata.source），防御性容错 |
| src/skills/sourceResolver.ts | D5 来源三级降级纯函数：metadataSource → skills-lock.json → null（CON-R-skills-005）；lock 防御性解析归一 name→entry map |
| src/skills/hash.ts | 内容哈希 + HashCache（D4 §4.3）：内存 Map + JSON 持久化 `<userData>/skills/hash-cache.json`，mtime 一致命中否则重算回写，temp+rename 原子写；walk lstat 不跟随 symlink |
| src/skills/pathGuard.ts | D7 路径安全校验：目录名白名单正则（拒 `..`/前导点/分隔符/控制字符）+ basename(realpath) 白名单域断言；S1/S2 共用（Q-038） |
| src/skills/SkillFsOps.ts | D3 fs 抽象接口 + 生产/测试工厂：只读面 readdir/stat/readFile/realpath/join + 根目录注入（Q-037 可测性） |
| src/skills/errors.ts | 错误类型族（SkillValidationError 等，错误码契约化） |
| src/skills/types.ts | SkillEntry/PathInfo/ScanSnapshot/StatusCounts/RemoteSkillEntry 等共享类型 |
| src/skills/SkillsScanner.ts | D2/D4 扫描管线：七步聚合（注册表遍历 → realpath 解析去重 → frontmatter 解析 → 来源三级降级 → 本地哈希 mtime 缓存 → 远端哈希 → 按 name 聚合）；后台任务 + 快照原子替换语义 |
| src/skills/ipc/SkillsIpc.ts | IPC 注册门面（4 只读通道接线 handlers map） |
| src/skills/ipc/skillsHandlers.ts | handler 实现：scan/getSnapshot/getStatus/searchRemote，入参类型收敛（query 非 string 归 ''） |
| src/shared/ipc-channels.ts | +SKILLS_IPC_CHANNELS 5 通道（hull:showSkills + skills:scan/getSnapshot/searchRemote/getStatus），并入 ALL_IPC_CHANNELS 白名单共面 |
| src/preload/index.ts | window.skills 桥 4 方法 + hull.showSkills；白名单固定不透传任意通道 |
| src/window/WindowManager.ts | showSkills()：main 切 view → placeholder:skills → section#skills 显示 |
| src/main/index.ts | hull:showSkills handler + openExternal 协议白名单收紧（见偏差 1） |
| src/renderer/shell.html | nav-skills 导航按钮 + placeholder 映射 + skills.css/skills.js 引入 |
| src/renderer/skills.js | 双 tab 视图（本地/远程）：本地 frontend-only 内存过滤（名称/描述/来源 + 平台筛选）；远程 Enter 触发 searchRemote；结果渲染 esc 全量；来源跳转渲染侧 ^https:// 强制 |
| src/renderer/skills.css | skills 视图样式 |

### 技术方案对照（D1~D7 全落地）

- **D1 目录注册表**：REGISTRY 硬编码常量集中维护，opencode 多目录读取以 affectedPlatforms 数据驱动表达（无 if 分支散落）
- **D2 全局/scoped 判定与聚合去重**：目录位置 + realpath 判定；scope 判定基准目录同样 realpath 规范化（macOS /var→/private/var symlink 陷阱已处理）
- **D3 SkillFsOps 抽象层**：接口 DI，测试注入 fake fs，不触真实用户目录
- **D4 扫描异步形态**：主进程后台任务 + renderer 轮询快照；scanning 时返回上次 ready 快照或 []（原子替换语义）
- **D5 来源三级降级**：独立纯函数解析器 sourceResolver.ts
- **D6 搜索双轨**：本地 frontend-only 内存过滤（零 IPC）；远程 main 侧 npx 子进程
- **D7 路径安全校验**：basename(realpath) + 白名单域断言（非正则黑名单）

### 关键实现

1. **SkillsScanner 七步管线 + 同源去重**：六目录遍历后逐条 realpath 解析——同一 skill 经 symlink 出现在多目录时按 realpath 去重只保留一条；realpath 失败（循环/悬空）warn 跳过；basename(realpath) 与目录名不一致跳过（穿越防御纵深）。最终按 name 聚合。
2. **哈希缓存 mtime 命中**：HashCache 键=path，st.mtimeMs 一致直接命中缓存哈希，否则 computeDirHash 重算回写；持久化走 temp+rename 原子替换，避免半写损坏。
3. **来源三级降级**：frontmatter metadata.source 优先 → skills-lock.json 兜底 → 均 null（状态栏显示「无法检测版本」语义上游）。
4. **搜索双 tab 永不混合**（Q-036）：本地 = snapshot.entries 内存 filter；远程 = spawn('npx', args) 参数数组传递不经 shell（防注入）、AbortController 30s 超时 kill、退出码非 0 抛 RemoteSearchFailedError（remote-search-failed，不影响本地列表）。默认 local tab。

### 偏差记录（3 项，均有依据）

1. **openExternal 未一刀切 ^https://**：http 仅回环放行——正则 `/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?([/?#]|$)/`。依据：dsh web 地址（http://127.0.0.1:port）依赖此通道打开浏览器，一刀切会砍掉核心链路；file:/javascript:/data:/任意 host http 全拒不变。skill 来源跳转在渲染侧额外强制 ^https://（双层防御，Q-038）。建议契约复核时将「http 仅回环」口径写进 CON-R-skills-007。
2. **远端哈希仅落地一级（skills-lock.json）**：平台 lock/cc-switch/git clone 三口径暂缓——对比口径未验证前，缺省 unknown（「无法检测」）比错误对比更保守正确；接入点已在 SkillsScanner ⑥ 注释标明，后续按契约「远端哈希口径」决议逐级接入。
3. **筛选下拉无「未安装」标注**：StatusCounts 仅 total/upgradable/disabled/global，无目录存在性字段，下拉无从过滤；缺目录条目扫描侧已正确跳过不出现在列表。建议 S2/契约修订时给 StatusCounts 补 notInstalled 计数后加筛选项。

### 测试

- 单元：src/skills/*.test.ts 七件套（registry/frontmatter/hash/sourceResolver/pathGuard/searchRemote/SkillsScanner）+ ipc/skillsHandlers.test.ts
- 全量：`npm run test:unit` **573/573 pass**

### 安全

- 路径穿越守卫：pathGuard basename(realpath) + 白名单域断言，拒 `..` 序列/前导点/分隔符；扫描侧 realpath 失败与 basename 不一致双重跳过
- openExternal 白名单：^https:// 或 http 回环（localhost/127.0.0.1），其余全拒；skill 来源跳转渲染侧再强制 ^https://
- npx 子进程：参数数组传递不经 shell，30s 超时 abort kill
- Semgrep：0 findings

## 核验记录

（留空待核验）
