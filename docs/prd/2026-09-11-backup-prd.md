# PRD：数据备份与恢复（backup）

> 状态：待办（未启动，实现时讨论细节）
> 创建：2026-09-11
> 需求标识：backup

## 背景

Hull 的全部数据在 `<userData>/`（settings/kanban/notes/skills 状态/通知/Token 缓存等）。换电脑时目前无迁移路径——用户需要手动找目录拷贝，且不知道哪些该带、哪些不该带。

## 目标

提供一个备份/恢复功能：导出 Hull 数据 → 新机器恢复，换机不丢数据。

## 待实现时讨论（不定案）

- **保存哪些数据**：settings.json / kanban（boards.json + executions）/ notes（用户自定义目录是否包含？）/ skills 状态（disabled/trash/哈希缓存）/ 通知与偏好 / Token 缓存（可弃 vs 保留）——逐项定
- **形式**：导出 zip 包 / 选择目录拷贝 / 双端都做
- **继承语义**：恢复时路径迁移（notes.dir 指向的绝对路径在新机器可能不存在）
- **边界**：不含 dsh 本体（npm overlay 可重装，CON-R003 通道独立）；不碰 DSH_HOME（CON-R002 红线）
- **触发**：设置页区块入口（备份/恢复/打开数据目录）

## 下一步

实现启动时：判级 → 建共识（如需）→ 契约 → 实现。
