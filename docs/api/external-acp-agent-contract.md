# 外部 ACP Agent 对接契约

> 版本：v1.0（2026-11-28 冻结） · 适用：**独立项目 agent**（任意语言/框架，推荐 Spring AI + GraalVM）嵌入 dsh-hull-desktop
> 依据：Hull 对真实 dsh 0.2.2-rc.1 的 ACP 探测实录（见 `docs/research/2026-11-28-内嵌Agent形态分析.md` §六）+ Hull `src/exec/provider/ACPProvider.ts` 现行实现
> Hull 侧状态：`ProviderRegistry` 已预留第二平台插槽（U-002）；本契约冻结后 Hull 侧才开发「外部 Agent provider」

---

## 1. 传输与帧格式

- **子进程 stdio**：Hull spawn 你的可执行文件（命令由用户在设置页配置，如 `/path/agent` 或 `java -jar agent.jar`）
- **帧 = 换行分隔的 JSON-RPC 2.0**（NDJSON）。**不是** LSP 的 Content-Length 头
- 请求/响应/通知三种帧；`id` 由发起方分配，响应必须带回同 `id`
- **stdout 只许写协议帧**（每行一个完整 JSON，写完即 flush）；日志一律走 **stderr**
- 进程由 Hull 管生命周期：优雅关停 = `SIGTERM`（你应落盘可恢复状态后退出，参考 `sessionCapabilities.resume`）

## 2. 握手序列（顺序错误会收到 `-32601 Method not found`，实测）

```
Hull → agent: initialize
agent → Hull: result（能力声明）
Hull → agent: session/new
agent → Hull: result（sessionId + configOptions）
Hull → agent: session/set_config_option（可选，用户选了模型/reasoning 才发）
Hull → agent: session/prompt
agent → Hull: 0..N 个 session/update 通知（流式）
agent → Hull: prompt 的 result（stopReason）
```

## 3. 方法明细（真实样例，实测通过版）

### 3.1 `initialize`（request）

```json
{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":1,"clientCapabilities":{}}}
```

响应 result（最小要求 + 参考完整形状）：

```json
{
  "protocolVersion": 1,
  "agentInfo": { "name": "my-spring-ai-agent", "version": "0.1.0" },
  "agentCapabilities": {
    "mcpCapabilities": { "http": true },
    "promptCapabilities": { "image": false, "audio": false, "embeddedContext": false },
    "sessionCapabilities": { "close": {}, "list": {}, "resume": {} }
  },
  "authMethods": []
}
```

- `sessionCapabilities` 声明什么，Hull 的运行历史/恢复按钮就显示什么；M1 不想做 list/resume 就声明 `{}` 并省略
- `authMethods` 为空数组 = 无需登录流程

### 3.2 `session/new`（request）

```json
{"jsonrpc":"2.0","id":2,"method":"session/new","params":{"cwd":"/path/to/workdir","mcpServers":[]}}
```

响应 result：

```json
{
  "sessionId": "uuid-必须唯一",
  "configOptions": [
    {
      "id": "model", "name": "Model", "category": "model", "type": "select",
      "currentValue": "[\"my-route\",\"my-model-a\"]",
      "options": [
        { "group": "my-route", "name": "My Route", "options": [
          { "value": "[\"my-route\",\"my-model-a\"]", "name": "my-model-a" },
          { "value": "[\"my-route\",\"my-model-b\"]", "name": "my-model-b" }
        ]}
      ]
    },
    {
      "id": "reasoning_effort", "name": "Reasoning effort", "category": "thought_level", "type": "select",
      "currentValue": "high",
      "options": [
        { "value": "off", "name": "Off" }, { "value": "low", "name": "Low" },
        { "value": "high", "name": "High" }, { "value": "max", "name": "Max" }
      ]
    }
  ]
}
```

- `configOptions` **可为空数组**（Hull UI 会隐藏选择器）
- `currentValue` 是字符串；模型值格式 `"[\"route\",\"model\"]"`（JSON 数组的字符串）

### 3.3 `session/set_config_option`（request，可选）

```json
{"jsonrpc":"2.0","id":3,"method":"session/set_config_option",
 "params":{"sessionId":"…","configId":"model","value":"[\"my-route\",\"my-model-b\"]"}}
```

- ⚠️ 参数名是 **`configId`**（不是 optionId——实测传错返回 `-32602 Invalid params`）
- 响应 result 应回**更新后的** `configOptions`（currentValue 已变化）

### 3.4 `session/prompt`（request）

```json
{"jsonrpc":"2.0","id":4,"method":"session/prompt",
 "params":{"sessionId":"…","prompt":[{"type":"text","text":"用户输入或任务描述"}]}}
```

- 最终响应 result 最小形状：`{"stopReason":"end_turn"}`
- 其他合法 stopReason（ACP 标准）：`cancelled`、`refusal`、`max_tokens`、`max_turns`

### 3.5 `session/update`（agent → Hull 通知，流式）

```json
{"jsonrpc":"2.0","method":"session/update","params":{
  "sessionId":"…",
  "update":{"sessionUpdate":"agent_message_chunk","messageId":"uuid","content":{"type":"text","text":"增量文本"}}
}}
```

上下文用量（强烈建议实现，Hull 的用量条直接吃它）：

```json
{"update":{"sessionUpdate":"usage_update","used":19847,"size":1000000}}
```

工具调用（**Hull 侧尚未实测**，M1 不用工具可先不实现；实现时按 ACP 标准）：

```json
{"update":{"sessionUpdate":"tool_call","toolCallId":"…","title":"读取文件","kind":"create",
  "content":[{"type":"content_block","content":{"type":"status","status":"pending"}}]}}
```

### 3.6 `session/request_permission`（agent → Hull **REQUEST**，带 id 必须回帧）

```json
{"jsonrpc":"2.0","id":100,"method":"session/request_permission",
 "params":{"sessionId":"…","requestId":"…","options":[{"type":"allow_once","name":"允许一次"}],
           "message":{"role":"user","content":[{"type":"text","text":"agent 想执行 XX，是否允许？"}]}}}
```

Hull 回（用户在弹窗点允许/拒绝）：

```json
{"jsonrpc":"2.0","id":100,"result":{"requestId":"…","approved":true,"reason":""}}
```

- ⚠️ 这是 **REQUEST**（有 id），不回响应帧会导致 Hull 侧挂起 → 你的工具执行必须**阻塞等待**此响应再继续
- Spring AI 侧要求：所有有副作用的工具（写文件/执行命令/网络）执行前先走此流程

### 3.7 `session/cancel`（Hull → agent 通知）

```json
{"jsonrpc":"2.0","method":"session/cancel","params":{"sessionId":"…"}}
```

- 收到后停止当前 turn，prompt 请求最终回 `{"stopReason":"cancelled"}`

## 4. 错误码（实测样例）

| code | 场景 | 实测样例 |
|:---|:---|:---|
| -32601 | 方法顺序错/未知方法 | 握手前直接 `session/new` → `Method not found` |
| -32602 | 参数名/形状错 | `set_config_option` 缺 `configId` → `Invalid params` |
| -32603 | 内部失败（模型调用失败等） | `Internal error: turn failed: …` |

## 5. 进程与环境约定

- Hull spawn 时传入：`cwd`（任务目录）、`env`（含补全后的 PATH，见 `augmentPathEnv`）
- 你的 agent **自管模型凭证**（环境变量/配置文件/密钥库均可，与 dsh 的 credentials service 无关）
- 不许假设 TTY；不许往 stdout 打日志（污染帧流 = 壳解析报错）
- 崩溃（非零退出）= Hull 判定任务失败并回传退出码；M1 不要求可恢复，声明无 resume 即可

## 6. 验收探测（Hull 侧用这个脚本判你合格）

`/tmp/acp-probe.js` 同款序列（initialize → session/new → [set_config_option] → prompt），判定：

1. initialize ≤ 15s 返回，含 `agentInfo` + `sessionCapabilities`
2. `session/new` 返回非空 `sessionId`
3. `session/prompt` 收到 **≥1 条 `agent_message_chunk`**，最终 result 含合法 `stopReason`
4. （可选加分）`usage_update`、`session/request_permission` 往返
5. （可选加分）`configOptions` 非空 → Hull 显示模型/思考强度选择器

## 7. 性能与分发建议

- **GraalVM native image**：单二进制、毫秒级启动、内存几十 MB、用户无需 JRE——桌面体验的关键项
- 若坚持 JVM：常驻单实例 + 会话复用（声明 `resume`），避免每任务冷启动
- 首条响应（initialize）尽量 < 1s：不要在启动时做重初始化（懒加载模型连接）

## 8. 变更记录

| 日期 | 版本 | 说明 |
|:---|:---|:---|
| 2026-11-28 | v1.0 | 首次冻结：帧格式/握手/七方法/错误码/验收，基于 dsh 0.2.2-rc.1 实测 + ACP 标准（tool_call 段为标准参考，未实测） |
