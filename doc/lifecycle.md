# 生命周期与取消语义

当前版本只暴露同步型子代理操作。MCP tool call 不会在子代理仍运行时返回“后台任务 ID”；主 agent 收到结果时，子代理进程已经完成或被清理。

## 同步生命周期

```text
主 agent
  -> MCP tool call: subagent_run / subagent_run_many / subagent_revise / subagent_revise_many
MCP Server
  -> 校验输入、工作区、安全策略、并发冲突
  -> 启动一个或多个 ACP 子代理进程
  -> 对每个子代理创建 ACP session 并发送 prompt
  -> 等待所有相关子代理完成、失败、超时或取消
  -> 写入 .subagents/runs 日志和 result.json
  -> 关闭 ACP client，清理本地进程树，释放并发锁
主 agent
  <- 收到完整 JSON 结果
```

`subagent_run_many` 和 `subagent_revise_many` 是“同步 fan-out/fan-in”：MCP Server 内部并行运行多个子代理，但工具结果只在所有任务进入终态后返回。

## 工具取消

每个同步工具都会绑定当前 MCP request 的 `AbortSignal`。当 Host 把用户“停止当前响应”传播成 request cancellation 时，本服务会：

1. 标记相关子代理任务为 cancelling。
2. 尝试发送 ACP `session/cancel`。
3. 在 `acp_cancel_grace_ms` 后继续本地清理，不无限等待 adapter 响应。
4. 清理 root pid、process group、PPID 后代，并用 `ACP_SUBAGENT_TASK_ID` 环境标记兜底查找脱离原进程树的孙进程。
5. 释放并发锁，写入取消结果。

默认相关配置：

| 配置 | 默认 | 说明 |
|---|---:|---|
| `mcp_request_heartbeat_ms` | `1000` | 长请求期间向支持 progress 的 Host 发送 heartbeat；发送失败会触发本地 abort。 |
| `acp_cancel_grace_ms` | `500` | ACP cancel 的正常退出等待窗口。 |
| `process_kill_grace_ms` | `500` | SIGTERM 后进入 SIGKILL 的等待窗口。 |
| `inactivity_timeout_secs` | `15` | 无 ACP 协议层活动时的兜底超时。 |

## 它能否规避手动停止后子代理残留

可以规避旧模型最主要的残留来源：工具已经返回但仍有 pending 子代理在服务端继续运行。同步模型下，工具不会在 pending 状态返回；主 agent 等待结果时，所有相关子代理都仍被当前 request 覆盖，因此 request cancellation 可以级联清理。

需要保留的边界是：如果 Host 既不发送 request cancellation，也不关闭 stdio transport，MCP Server 无法在用户点击停止的瞬间收到信号。这不是工具接口能完全解决的问题，所以仍保留无活动超时、任务总超时、transport close 和 Node 进程退出钩子。

## 打回重写生命周期

打回重写不是复用旧 ACP session。旧结果完成后，旧子代理进程已经清理。重写时会启动一个新的子代理进程，并把这些内容显式放入 prompt：

- 原始任务；
- 上一轮结果；
- 主 agent 的打回原因；
- 期望修正点；
- 可选新增文件或额外指令。

这样可以保留“让同类子代理重写”的产品语义，同时避免为了多轮修正长期保留后台 ACP session。

## 结果和日志

每个运行结果都会带 `artifacts`：

```json
{
  "run_dir": ".subagents/runs/run_...",
  "event_log": ".subagents/runs/run_.../events.jsonl",
  "stderr_log": ".subagents/runs/run_.../stderr.log",
  "result_json": ".subagents/runs/run_.../result.json"
}
```

当前版本不再提供日志读取工具。需要调试时，在本地工作区直接查看这些 artifact 路径。
