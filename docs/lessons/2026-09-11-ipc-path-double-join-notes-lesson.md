# IPC 路径通道双重拼接：守卫函数返回绝对路径被下游再 join

| 项 | 内容 |
|:---|:-----|
| 背景 | 笔记主进程 4 条路径类通道（get/save/move/delete）在集成 e2e 时全部失败（ENOENT）；单元测试全绿（直调 store） |
| 决策或坑 | `resolveSafeNotePath`（路径守卫）返回 **resolve 后的绝对路径**，IPC 层把它直传 store/service，后者再 `join(notes.dir, path)` → 双重拼接 `notes.dir/notes.dir/...`。修复：守卫新增 `validatePathParam` 变体——安全校验后**回传相对路径**；路径类通道统一走它。教训：守卫函数的返回值契约要与下游（root + rel 拼接模型）对齐——「校验」与「规范化」是两件事，别在一个函数里悄悄做 |
| 影响 | 4 条 IPC 通道全坏但单测全绿（测试直调 store 绕过 IPC 层）——只有端到端 e2e 能抓到这类「层间契约不一致」 |
| 适用范围 | 所有 main/renderer 之间有路径、ID、资源引用传递的 IPC 设计；单测「直调下层绕过中间层」的测试结构需补集成层用例 |
| 来源 | 出生：来源子需求 N1 + 来源 PRD `2026-09-07-notes-prd.md`；引用：代码 `src/notes/NotesIpc.ts`（validatePathParam）+ `NotesService.ts`；提交 `e53c599`（N1 实现）、e2e 期修复（`tests/e2e/notes.spec.ts`） |
| 引用 | 首次引用：N1/N2 联合集成（2026-09-11）；后续复用 +1 |
