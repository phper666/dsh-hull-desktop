# 变更摘要-Skills检查器（L2 模块详情）

> Skills 检查器模块（壳内独立视图：统一扫描/全局 vs 平台判定/来源跳转/升级检测/搜索/禁用/移除）变更详情。每条 ≤200 字，delta-only、编号驱动、取代链、反哺 Q-items。最新在前。
> L1 索引：docs/spec/变更摘要.md · 共识：docs/spec/共识-Hull桌面壳-Skills检查器.md · 规则索引：docs/spec/规则索引.md

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
