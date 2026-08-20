# AGENTS.md

<!-- team-workflow:begin -->
## AI 研发工作流（已接入）

- 流程定义见全局 AGENTS.md `team-workflow` 段（ai-workflow-skills 模板，含工作流导航 + 实现阶段管道 + 需求分类路由）；未加载全局模板 → 跑 workflow-setup 或按 README 加载
- 文档地图：docs/spec/（共识、规则索引、团队配置、变更摘要、变更摘要-<模块>.md）、docs/api/（契约）、docs/design/（技术方案）、docs/prd/（需求）、docs/prototype/（原型）、docs/lessons/（经验）
- 载体：Q-items 见 docs/spec/团队配置.md（飞书任务双清单）
<!-- team-workflow:end -->

## 项目红线

1. 永不 fork/patch/替换 dsh 及官方 Web UI（CON-R001）
2. 永不重写 DSH_HOME 用户数据（CON-R002）
3. dsh 升级与壳自更新两条独立通道（CON-R003）
4. 壳内功能必须走官方扩展点（CON-R004）
5. 升级原子性：staging → 替换 → 验证 → 回滚（CON-R005）
