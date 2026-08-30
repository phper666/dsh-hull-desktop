# 工作台连接（Connections）技术方案

> 判级：**复杂**（凭据存储属安全敏感 + 多平台适配器架构 + 新导航视图）→ 本文档
> 需求（用户 2026-08-30）：新增「工作台连接」菜单（设置之前），连接多平台：v1 = Salesforce（external app ak/as + 实例地址）、阿里云短信、腾讯云短信、SMTP 邮件；后续拓展小红书/抖音/飞书等。v1 只做平台授权连接与连通验证；授权后可调用平台能力（能力调用为后续业务，本期留扩展点）。

## 一、目标与非目标

- 目标：连接的创建/编辑/验证/删除；凭据安全存储；状态可视（未验证/已连接/失败+原因）；适配器注册表（数据驱动表单，加平台 = 加一个适配器定义）
- 非目标（v1）：不实现业务调用封装（发短信/发邮件/查 SF 数据——v2 按业务需要基于已存凭据封装）；不做代理/多账号组；不做自动重连轮询

## 二、架构

```
src/connections/
  types.ts               # PlatformId / FieldSchema / StoredConnection / ConnectResult
  PlatformRegistry.ts    # 四平台适配器：字段 schema + verify(fields) 网络验证器
  ConnectionsStore.ts    # CRUD + safeStorage 加密持久化 + 脱敏视图（DI 可测）
  ConnectionsIpc.ts      # IPC 原语（list/platforms/save/test/delete）
```

- **适配器注册表（数据驱动）**：每个平台 = `{ id, name, description, fields: FieldSchema[], verify(fields) }`。FieldSchema 驱动渲染层表单（key/label/required/secret/placeholder）。**新增平台 = 新增一个适配器对象并注册**，渲染层零改动
- 渲染层：`connections.js` schema 驱动表单 + 列表卡片；导航「工作台连接」在设置之前

## 三、安全设计（核心）

1. **加密存储**：敏感字段经 Electron `safeStorage`（OS 钥匙串/DPAPI 背书）加密后 base64，以 `enc:` 前缀落 `<userData>/connections/connections.json`；`isEncryptionAvailable()=false` → 拒绝保存并提示（安全优先，不做明文降级）
2. **渲染层零明文**：list 返回脱敏视图（secret 字段 → `****` + 尾 4 位）；编辑不回传明文（留空=保留原值）；解密只发生在 main 侧验证器内
3. **删除即清除**：delete 从磁盘移除（无回收站——凭据不是用户内容）
4. **红线**：不写 DSH_HOME；网络验证超时 10s；错误信息不含 secret

## 四、平台适配器 v1（验证语义）

| 平台 | 字段 | 验证方式（成功=凭据有效） |
|:-----|:-----|:--------------------------|
| salesforce | instanceUrl、ak(client id)、as(client secret) | OAuth2 client_credentials POST `/services/oauth2/token` → access_token → GET `/services/data/v59.0/limits` |
| aliyun-sms | accessKeyId、accessKeySecret | RPC V1 签名 GET `dysmsapi.aliyuncs.com` QuerySmsTemplateList（Page 1）；`Code=OK` → 成功；签名失败码 → 凭据无效 |
| tencent-sms | secretId、secretKey | TC3-HMAC-SHA256 签名 POST `sms.tencentcloudapi.com` DescribeSmsTemplateList；无 Error 或非 `AuthFailure.*` → 凭据有效（参数类错误发生在鉴权之后） |
| smtp | host、port、secure、username、password | TLS/NET 连接 → 220 banner → EHLO → （有凭据则 AUTH LOGIN）→ 2xx → QUIT；10s 超时 |

- 签名实现：阿里云 HMAC-SHA1 RPC 经典签名（%~百分号编码 RFC3986）；腾讯云 TC3-HMAC-SHA256 标准链（Date→Service→Signing）。签名函数注入 nonce/timestamp → 确定性可单测
- 状态机：保存（含同步验证）→ connected / failed(lastError)；编辑重存 → 重新验证

## 五、IPC 与渲染层

- `connections:list`（脱敏）/ `connections:platforms`（适配器元数据）/ `connections:save {platform,name,fields}`（保存+验证）/ `connections:test {id}` / `connections:delete {id}`
- preload：`window.connections` 桥；导航「工作台连接」在 Token 消耗之后、设置之前（五处视图接线镜像 tokens 先例）

## 六、风险与回退

| 风险 | 缓解 |
|:-----|:-----|
| safeStorage 不可用（部分 Linux） | 拒存 + 提示；不影响其余功能 |
| 平台 API 变化/网络不通 | 验证器超时 10s + 错误信息分类（网络/凭据/参数）；状态置 failed 可重试 |
| 签名算法细节错 | 确定性函数单测（固定入参向量）+ 用户真实凭据验证兜底 |
| 内部格式耦合 | 适配器隔离：平台坏只坏该平台 |

## 七、排期

1. 本 PR：四平台适配器 + 加密存储 + IPC + 渲染层 + 单测
2. 后续：业务能力封装（发短信/发邮件/SF 查询）按业务需要基于 `ConnectionsStore.getCredentials(id)`（main 侧解密接口）开发；新平台按注册表扩展
