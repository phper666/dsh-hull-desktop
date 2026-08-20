# S5 经验沉淀：全占槽设计的放弃路径 与 GitHub Actions mutable tag 供应链风险

> 三硬标准：可复用 / 非显而易见 / 有代价（均通过）
> 来源-出生：S5 Hull 自更新（dsh-hull-desktop）· 来源 PRD：2026-08-14-m1-prd.md
> 来源-引用：实现与评审期

---

## Lesson 1：全占槽设计必须配套「放弃」路径——持有资源至终态要枚举所有终态

### 现象
S5 B2 全占槽：check() 发现新版 → confirm 分支**不释放互斥槽**（单次 acquire 连续持有至终态）。但 HullUpdater 只有 `cancel()`（仅限 Downloading 阶段）——**没有「稍后再说/放弃」方法**。main 的稍后再说分支只调 `dismissToday('hull')`（当日去重），phase 卡在 Confirm + queueHeld 永久残留 → **dsh 升级 queue-busy 被永久锁死**（T5-03 互斥语义被破坏成永久锁，直到重启）。

### 根因
「持有资源至终态」设计时只枚举了**成功终态**（done）与**失败终态**（idle via 失败路径），漏了**用户放弃**这个终态（稍后再说 = 用户主动放弃，不是失败）。资源持有方没有对应的释放入口。

### 对策
- **任何「持有资源至终态」的设计必须枚举所有终态**（成功/失败/取消/用户放弃），每个终态都要释放资源
- 补 `dismiss()`（confirm → idle + releaseQueue + error=null，幂等）——放弃路径与失败路径同等对待（S4 Lesson 1「失败路径状态迁移闭环」同族）
- **测试覆盖「放弃后其他通道可恢复」**：dismiss 后 `queue.acquire('dsh')` 成功（🔴-1 用例）——资源泄漏类缺陷必须用「其他消费者可恢复」断言，而非只看持有方自身状态

### 代价
- 一行方法 + 一用例；若流入 S6 才被发现，用户表现为「稍后再说后 dsh 升级按钮永远 queue-busy」——排查成本高得多

---

## Lesson 2：GitHub Actions mutable tag 供应链风险——CI 依赖一律 pin commit SHA

### 现象
release.yml 用 `actions/checkout@v4`、`actions/setup-node@v4` 等 mutable tag——tag 可被上游**静默重指**（trivy-action/kics 等真实供应链事件先例），工作流下次运行可能执行被篡改的 action 代码。Semgrep 自动规则抓到（CWE-1357），2 findings。

### 根因
mutable tag 是「引用会变的名字」——安全敏感判级（S5 判级含 CI 发布链）下，CI 依赖与 npm 依赖同等对待：不可变引用才可审计。

### 对策
- **pin 到完整 40 字符 commit SHA** + 版本注释（`actions/checkout@11d5960a... # v4`）——SHA 经 api.github.com 实取（tag 指向 commit），不凭记忆
- 升级动作 = 显式改 SHA + 人工核对（与依赖升级同纪律）
- Semgrep 自动规则是有效防线：安全敏感判级下自动扫描 CI 文件，mutable tag 属可机器检出项

### 代价
- 升级 action 时多一步 SHA 核对；若凭记忆写 SHA（错误值）→ workflow 直接失败可见（比 mutable tag 静默风险安全）
