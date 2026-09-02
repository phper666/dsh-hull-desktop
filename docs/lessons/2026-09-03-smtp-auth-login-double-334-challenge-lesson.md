# SMTP AUTH LOGIN 有两次 334 挑战——状态机少一段就卡死，且未被真实流量验证的分支永远测不到

| 项 | 内容 |
|:---|:-----|
| 背景 | connections v1 的 verifySmtp 实现了「AUTH LOGIN → 334 → 发用户名 → 等 235」三段状态机，漏了服务器在用户名之后发的**第二个 334（Password: 挑战）**——标准 AUTH LOGIN 是 334 Username → 用户名 → 334 Password → 密码 → 235。该分支因单元测试只覆盖签名构造、未起真实/假 socket，从未被执行过，带病上线 4 天。工作流 v2 用本地 `net.createServer` 假 SMTP 服务器做集成测，第一轮就暴露（客户端把 334 Password 当成 235 失败路径）。 |
| 决策或坑 | ①实现 SMTP 客户端（AUTH LOGIN）状态机必须有「用户名挑战段 → 密码挑战段 → 接受段」三段，少一段=与主流服务器（含中继）全部认证失败；②「从未被真实流量走过的分支」单测绿不等于对——协议状态机类代码要起本地假服务器做 socket 级集成测（net.createServer 脚本化逐段应答，断言信封与 DATA 内容，成本 ~60 行）；③v1 与 v2 是两个独立实现，同一坑连踩两次——协议交互层抽公共实现或至少让第二实现复用第一实现的状态机骨架。 |
| 影响 | 不这样做：认证路径上线即坏，用户侧表现为「验证失败」但握手无认证时一切正常，难定位；协议类 bug 在无 socket 集成测时只能靠真实服务器踩坑暴露。这样做：状态机分段与 RFC 对齐 + 本地假服务器集成测一次写对，后续平台动作（发信）直接复用。 |
| 适用范围 | 任何协议交互状态机（SMTP/FTP/POP3/自定义 TCP JSON-RPC）；「验证型」与「执行型」两个入口共享同一协议时尤其注意。 |
| 来源 | 出生：需求 workflows-v2（2026-09-03，Actions.ts sendSmtp 假服务器集成测暴露 v1 verifySmtp 同源 bug，commit 39e6f4c 修复）；引用 docs/design/工作流-workflows-design.md §7.2 · docs/records/工作流v2-workflows-v2-record.md |
| 引用 | 首次引用：本 lesson 出生（2026-09-03） |
