# 2026-09-04 单飞调度循环内的同步 settle 回调丢失唤醒

**引用编号**：LESSON-20260904-04

## 现象

看板任务执行在 provider 立即失败（如子进程秒退）时永久卡「排队中」：内存里 running、store 里 queued、无任何状态事件，重启也救不回。

## 根因

单飞 drain 循环（`settleAll → findStartable → startBatch → waitForChange`）中，`startBatch` 调 `provider.execute` 时 **provider 在同一同步栈内回调** `onStatus('failed')` → 结算入 pendingSettlements + `notifyChanged()`——此刻 drain 还没走到 `waitForChange`，**waiters 为空，notify 是空操作** → drain 随后挂起，pending 结算永远无人处理。

## 规则沉淀

1. **「回调可能同步触发」的异步循环，唤醒必须延迟到微任务**：`queueMicrotask(() => notify())`——同步栈走完（waiter 已注册）后微任务恰好唤醒
2. 竞态特征自查：回调链路里任何 `notify/wake` 若在「注册等待者」之前执行，必丢唤醒；典型场景 = 资源获取函数在返回前同步调用了回调
3. 事件时序回放是定位利器：把 timeline 事件与状态机阶段对齐（本例：enqueue 2ms 内 failed、无 startedAt 事件 → 失败发生在 startBatch 内部）

## 引用

- 实现记录：`docs/lessons/2026-09-04-kanban-exec-q017-batch.md` #2
- 修复：`src/exec/scheduler/Scheduler.ts` wakeSoon()；回归测试 SyncFailOnceProvider
