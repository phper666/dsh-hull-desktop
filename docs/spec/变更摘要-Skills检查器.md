# 变更摘要-Skills检查器（L2 模块详情）

> Skills 检查器模块（壳内独立视图：统一扫描/全局 vs 平台判定/来源跳转/升级检测/搜索/禁用/移除）变更详情。每条 ≤200 字，delta-only、编号驱动、取代链、反哺 Q-items。最新在前。
> L1 索引：docs/spec/变更摘要.md · 共识：docs/spec/共识-Hull桌面壳-Skills检查器.md · 规则索引：docs/spec/规则索引.md

## 2026-08-24 平台扩展续（v1.6）——注册表新增 4 平台（dsh/harness/qoder/reasonix）

- 类型：规则描述扩展（CON-R-skills-001/002，向后兼容），升共识 v1.6
- 内容：**注册表新增 4 平台**（lib-2 调研官方目录约定）：dsh=`~/.dsh/skills/`（`$DSH_HOME/skills`，本机 `~/.dsh` 存在）、harness=`~/.harness/skills/`、qoder=`~/.qoder/skills/`+`~/.qoder-cn/skills/`（CN 归并，本机 `~/.qoder` 有 28 skills）、reasonix=`~/.reasonix/skills/`；平台清单 13→16；扫描目录同步；均为 scoped 单平台
- 影响：registry.ts REGISTRY/ALL_AGENT_PLATFORMS + skills.js PLATFORMS/install 列表同步；registry.test/SkillsScanner.test 断言更新；另修复 skills 工具条操作按钮 wrap 拆散（.sk-ops 分组）
- 状态：已发布（2026-08-24，PM）；实现已完成（unit 596 + int 8 + e2e 27 绿）

## 2026-08-24 平台扩展（v1.5）——注册表新增 7 平台（windsurf/warp/trae/cline/roo/continue/devin）

- 类型：规则描述扩展（CON-R-skills-001/002，向后兼容），升共识 v1.5
- 内容：**注册表新增 7 平台**（librarian 调研官方目录约定）：windsurf=`~/.codeium/windsurf/skills/`、warp=`~/.warp/skills/`、trae=`~/.trae/skills/`+`~/.trae-cn/skills/`（CN 版归并同平台）、cline=`~/.cline/skills/`、roo=`~/.roo/skills/`、continue=`~/.continue/skills/`、devin=`~/.config/devin/skills/`；平台清单 6→13（+shared 全局）；扫描目录清单同步；**明确不纳入**：Amazon Q（CLI 已弃用）、Aider（无 skills 体系，社区约定非官方）
- 影响：registry.ts REGISTRY/ALL_AGENT_PLATFORMS + skills.js 前端 PLATFORMS/install 列表同步；registry.test 断言更新；均为 scoped 单平台（无多目录读取特殊处理）
- 状态：共识已发布（2026-08-24，PM）；实现待接

## 2026-08-24 T-5 跨 agent 重叠展示定案关闭（v1.4）

- 类型：未决项定案关闭（确认定案，无新规则变化），升共识 v1.4
- 内容：**T-5 由 open→已关闭**——跨 agent 重叠展示方案定案：跨目录同名 skill 按 name 聚合、realpath 同源去重（macOS `/var→/private/var` symlink 规范化）、平台徽标合并显示全部生效平台、全局路径优先展示（§5.3）；**实现已覆盖**（SkillsScanner 七步管线 + 前端平台筛选/多平台徽标），无代码缺口
- 影响：共识 §11.1 T-5 关闭、§5.1 褶皱处理确认定案、§15.3 后续规划同步；无规则编号变化；T-1~T-6 至此全部关闭
- 状态：已发布（2026-08-24，PM 定案回写）

## 2026-08-24 Q-034 v1.3 变更——skills-lock.json 移除，升级检测只依赖标准位置（实现）

- 类型：规则变更（CON-R-skills-004/005 + Q-034），升共识 v1.3
- 内容：**skills-lock.json 读取逻辑移除**（`~/AI/skills-lock.json` 历史静态快照 8-18，无持续生成者，个人目录硬编码不可移植）——远端哈希来源降为：① 各平台 lock（`.arkcli-managed-skills.json` 等，标准位置）→ ② frontmatter metadata.source 推断 → ③④ 待办；来源解析从三级降级改为一级（只认 metadata.source）；磁盘文件不删，仅代码不再读
- 影响：SkillsScanner loadLock 生产分支删除（lockProvider 注入保留供测试）；sourceResolver resolveSource 去 lock 参数、parseSkillsLock 删除；SkillsScanner.test/sourceResolver.test 同步更新；第三方无 .arkcli 记录的 skill → remoteHash=null → unknown「无法检测版本」不误报可升级；升级 npx 轨不依赖 source 仍可用
- 状态：已实现（2026-08-24，单测 589 绿 + e2e 12/12 绿）

## 2026-08-23 待拍板项推进——Q-034 二级哈希 + O-2 npx 接线（实现）

- 类型：待拍板项落地（实现，不升共识版本——结论语义未变，只补实现覆盖）
- 内容：① **Q-034 远端哈希二级来源接入**——一级 skills-lock.json 已有，新增二级 `.arkcli-managed-skills.json`（opencode 平台 lock，name→hash 映射，防御解析+进程内缓存，level-1 优先）；③ cc-switch（本机 skills 表空无价值）/④ git remote clone（网络成本）保持待办注记；② **O-2 npx 升级接线**——`npx skills update` 单路径语义实测通过（`skills update <name> [-g]`），生产 `defaultNpxUpdate` runner 接入（数组参数防注入 + 120s 超时，失败/无效果自动降级 git-staging，分支逻辑既有）
- 影响：SkillsScanner 远端哈希解析补二级来源；SkillsOps 生产装配 PRODUCTION_RUNNERS.npxUpdate；S2 record 低危#3（无生产 npx runner）标记已解决；新增 5 测试（spawnChecked 4 + arkcli 1），全量 579/579 绿 + tsc 0
- 状态：已实现（2026-08-23，commit cb908f7）

## 2026-08-22 扫描待确认项定案回写 v1.2（Q-031~Q-038 全关闭）

- 类型：扫描结论回写（确认/细化，向后兼容，v1.1→v1.2）
- 内容：BE/FE/QA 扫描产出 8 项待确认（Q-031~Q-038），PM solo 决策全部定案并织入共识业务事实章节。**要点**：① Q-031（BLOCKER）禁用按物理路径粒度——共享目录 skill 整体移出=全平台禁，平台专属副本单独禁；② Q-032 symlink 来源移除 symlink（源保留 SSOT）、实目录 rename 到 disabled、userData 记录路径映射；③ Q-033 无 source+无 lock → 升级禁用「无法检测版本」；metadata.source 非 git 用 URL 重取；git clone 不原位 pull，clone 到 staging 原子替换；④ Q-034 远端哈希四级优先级 skills-lock → 平台 lock → cc-switch content_hash → git remote 临时 clone，按 name 匹配 skills-lock 优先覆盖；⑤ Q-035 回收站 TTL 30 天+500MB 上限+恢复冲突提示；⑥ Q-036 搜索两 tab 默认本地，远程结果仅浏览标注「未安装」；⑦ Q-037 SkillFsOps 接口+临时目录注入 e2e，真实目录留冒烟；⑧ Q-038 basename(realpath) 路径校验 + openExternal 仅 ^https://
- 影响：CON-R-skills-003/004/007/008/010 描述细化（规则索引同步）；T-1/T-2/T-3/T-4/T-6 结论标注 v1.2 细化来源；T-5 保持 open
- 状态：已发布（2026-08-22，PM 定案回写）

## 2026-08-22 Skills 检查器共识发布 v1.1（用户定案 T-1~T-4/T-6）

- 类型：共识基线发布（新模块首次建立）+ 用户决策定案
- 内容：Skills 检查器独立视图共识发布。**用户定案**：① **T-4 禁用/启用 = agent 平台真禁用**——移目录（禁用移出 agent 读取目录到 `<userData>/skills/disabled/<skill-name>/`，启用移回），否决壳内白名单方案；② **T-2 搜索分本地/远程两场景且分开**——本地过滤已扫描列表，远程检索 marketplace（`npx skills find`/skills.sh API），两入口分开、远程仅浏览不安装；③ **T-3 升级执行** npx skills update 优先 / git pull 次选 / 不重 clone，原子替换+回滚兜底；④ **T-1 远端哈希** skills-lock.json 优先 / git remote tree SHA 次选 / 无则「无法检测」；⑤ **T-6 移除前备份** userData 回收站（`<userData>/skills/trash/`，可恢复）
- 影响：登记 CON-R-skills-001~010（008 由「变更中」→「生效」定案移目录；新增 010 本地/远程搜索分开）；PRD 升 v0.2；T-5 跨 agent 重叠展示保持 open
- 状态：已发布（2026-08-22，用户确认内容 + 决策定案）
