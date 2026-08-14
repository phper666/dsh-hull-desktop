# AGENTS.md

## AI 研发工作流（已接入）

- 建立/更新共识文档 → consensus-doc
- 扫描共识 / 处理待确认项 → consensus-scan
- 生成/更新/复核契约 → story-to-contract
- 共识规则变更传播 → change-propagation
- 文档地图：docs/spec/（共识、规则索引、团队配置）、docs/api/（契约）、docs/lessons/（经验）
- 载体：Q-items 见 docs/spec/团队配置.md（飞书任务双清单）

## 项目红线

1. 永不 fork/patch/替换 dsh 及官方 Web UI（CON-R001）
2. 永不重写 DSH_HOME 用户数据（CON-R002）
3. dsh 升级与壳自更新两条独立通道（CON-R003）
4. 壳内功能必须走官方扩展点（CON-R004）
5. 升级原子性：staging → 替换 → 验证 → 回滚（CON-R005）
