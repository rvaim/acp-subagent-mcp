# 生命周期、同步/异步与取消语义

本文回答几个最容易误解的问题：单个子代理是否同步、多个子代理是否同步、主 agent 被用户手动停止时子代理是否会自动停止，以及异步任务如何把结果交回主 agent。

## 关键结论

| 场景 | 当前工具调用是否等待任务完成 | 用户手动停止当前主 agent/tool call 时是否级联取消子代理 | 结果如何回到主 agent |
|---|---:|---:|---|
| `subagent_run` | 是。等待第一轮 prompt 结束后返回结果。 | 是。当前 request 的 `AbortSignal` 会触发 ACP `session/cancel`，随后清理子进程树。 | 直接作为 `subagent_run` 结果返回。 |
| `subagent_start` | 否。只等初始化、创建 session、启动第一轮 prompt 后返回 `task_id`。 | 仅在启动 tool call 尚未返回前会级联取消；返回后不再绑定当前 request。 | 后续用 `subagent_wait` / `subagent_result` / `subagent_logs` 查询。 |
| `subagent_start_many` | 否。它会逐个完成启动阶段并返回所有已启动的 `task_id`，不会等任务完成。 | 仅在 `start_many` tool call 尚未返回前会取消已启动项；返回后不再绑定当前 request。 | 后续用 `subagent_wait` / `subagent_result` / `subagent_logs` 查询。 |
| `subagent_wait` | 是。按 `return_when` 等待指定任务完成或产生更新。 | 是。用户停止当前 wait 时，wait 覆盖的仍在运行任务会被取消。 | `wait` 返回已完成、失败、仍在运行的任务列表。 |
| `subagent_continue` | 否。向保留的 session 发起下一轮 prompt 后返回 `turn_id`。 | 当前 continue 请求尚未返回前可取消本轮；返回后建议立刻用 `wait` 绑定取消。 | 后续用 `subagent_wait` / `subagent_result` 查询该任务最新轮次结果。 |
| `subagent_cancel` | 是。发出取消请求后返回取消结果。 | 不适用。 | 返回取消成功、已终态和失败列表。 |
| `subagent_close` | 是。关闭任务和保留 session。 | 不适用。 | 返回关闭结果。 |

## 单个子代理启动是同步的吗？

取决于使用哪个工具。

`subagent_run` 是同步语义：MCP tool call 会一直等待子代理第一轮 prompt 结束，然后返回最终状态、摘要、结果、日志路径和错误列表。它适合“主 agent 必须拿到结果才能继续推理”的场景。

`subagent_start` 是异步语义：MCP tool call 只负责完成这些启动步骤：

1. 校验 `agent_type`、`cwd`、文件路径、prompt 大小和并发冲突。
2. 准备执行工作区，必要时准备 git worktree。
3. 启动 ACP agent 子进程。
4. ACP `initialize`。
5. ACP `session/new`。
6. 启动第一轮 `session/prompt`。
7. 立即返回 `task_id`、`session_id` 和当前 `task_status`。

`subagent_start` 返回后，子代理仍在 MCP Server 进程内部继续运行。主 agent 后续需要调用 `subagent_wait`、`subagent_result` 或 `subagent_logs` 获取进度和结果。

## 手动停止主 agent 后，单个子代理会自动停止吗？

也取决于“停止发生在哪个 MCP tool call 上”。

如果用户停止的是正在执行的 `subagent_run`，会自动停止。实现上，MCP SDK 会把当前 tool call 的取消传给 `extra.signal`，运行时会把该 signal 绑定到任务。取消链路是：

```text
用户停止主 agent 当前响应
  -> MCP request AbortSignal abort
  -> cancelActiveTask()
  -> ACP session/cancel
  -> 当前 prompt 的 timeout/abort controller 进入 cancelled
  -> turn finally 中 cleanupActiveTask()
  -> terminateProcessTree(SIGTERM, grace 后 SIGKILL)
```

如果用户停止的是已经返回后的 `subagent_start`，不会因为之前那个已经结束的 request 自动停止。此时任务已经变成后台任务，必须依赖以下方式之一停止：

- 立刻调用 `subagent_wait` 覆盖该 `task_id`，用户停止 wait 时会取消该任务。
- 主 agent 显式调用 `subagent_cancel`。
- 主 agent 显式调用 `subagent_close` 且 `force=true`。
- MCP transport 关闭、MCP Server 进程收到 `SIGINT` / `SIGTERM` 或 Node 进程退出时，服务端兜底关闭所有活跃任务。

因此，想让“用户手动停止主 agent”也停止异步子代理，推荐组合是：

```text
subagent_start -> subagent_wait(task_ids=[...], return_when=..., timeout_secs=足够长, on_timeout=cancel_pending 或 keep_running)
```

主 agent 应该在拿到 `task_id` 后马上进入 `subagent_wait`。这样用户停止主 agent 当前响应时，停止发生在 `wait` tool call 上，`wait` 会取消自己覆盖的任务。

## 多个子代理启动是同步的吗？

`subagent_start_many` 是“批量异步启动”。它不是 `Promise.all` 式一次性并发初始化；当前实现会按输入顺序逐个启动每个任务，等每个任务完成初始化并进入后台 prompt 后，把它加入 `started` 列表。所有成功启动的任务会在后台并发运行。

因此它的语义可以拆成两段：

```text
启动阶段：按 tasks 顺序逐个初始化和创建 session
运行阶段：已启动的 prompt turn 在后台并发运行
```

`subagent_start_many` 返回时，代表“启动结果已经确定”，不代表“任务结果已经完成”。要拿结果必须继续调用 `subagent_wait` 或 `subagent_result`。

## 手动停止主 agent 后，多个子代理会自动停止吗？

有三种情况：

1. 用户在 `subagent_start_many` 尚未返回时停止：服务端会取消已经启动成功的任务，并抛出可恢复的取消错误。
2. 用户在 `subagent_start_many` 已返回后、但主 agent 还没有进入 `subagent_wait` 前停止：这些后台任务不会因为已结束的 `start_many` request 自动取消；它们会继续运行，除非 MCP Server transport 被关闭或主 agent 显式取消。
3. 用户在覆盖这些任务的 `subagent_wait` 期间停止：`wait` 会取消 `task_ids` 中仍在运行的任务，避免后台残留。

想要“拉起多个子代理，且主 agent 被用户手动停止时子代理一起停止”，推荐组合如下：

```text
subagent_start_many
  -> 取 started[].task_id
  -> 立即 subagent_wait(
       task_ids=所有 task_id,
       return_when="all_completed" 或其他策略,
       timeout_secs=足够长,
       on_timeout="cancel_pending" 或按需 keep_running
     )
```

当 MCP Host 将“用户停止主 agent 当前响应”转换为当前 `subagent_wait` request cancellation 时，本服务会把该 wait 的 `task_ids` 中仍在运行的子代理全部取消。

如果你不希望用户停止 wait 时取消后台任务，就不要让主 agent 长时间停留在 `subagent_wait` 上，可以选择短 timeout 轮询：

```text
subagent_start_many
  -> subagent_wait(return_when="timeout_partial", timeout_secs=5, on_timeout="keep_running")
  -> 根据 pending_task_ids 再次 wait 或 result
```

这种模式更像后台队列：主 agent 中断后任务可能继续运行，需要后续显式 `subagent_cancel` 或等待 session TTL/进程关闭清理。

## 如果多个子代理是异步的，MCP 服务不是停止了吗？子代理怎么和主 agent 通信？

异步并不等于 MCP 服务停止。

`subagent_start` / `subagent_start_many` 返回后，MCP Server 进程仍然存在，后台子代理进程也仍然由 MCP Server 管理。子代理不会直接和主 agent 通信。通信链路是：

```text
子代理进程
  <-> ACP stdio / JSON-RPC
MCP Server 内部 GenericAcpClient
  -> TaskRegistry 内存状态 + .subagents/runs 日志文件
主 agent
  <-> MCP tools: subagent_wait / subagent_result / subagent_logs
```

也就是说，子代理只和 MCP Server 通信；主 agent 通过后续 MCP tool call 从 MCP Server 查询结果。

如果 MCP Server 真的停止了，例如 MCP Host 关闭 stdio transport、重启 MCP Server、进程收到 `SIGINT` / `SIGTERM`，服务端的 shutdown hook 会调用 `shutdownAllActiveTasks()`，对所有活跃任务执行 force close，最后清理子进程树。此时不存在“子代理继续和主 agent 通信”的通道。

## 多个子代理是全部完成才通知主 agent，还是先完成的先处理？

由 `subagent_wait.return_when` 决定。

| `return_when` | 返回时机 | 适合场景 |
|---|---|---|
| `all_completed` | 所有任务进入终态后返回。 | fan-out/fan-in，总结多个子代理结论。 |
| `first_completed` | 任意任务进入终态后返回，成功、失败、超时、取消都算。 | 只关心最快结束者。 |
| `first_success` | 任意任务成功或部分成功后返回。 | 多路尝试，先拿可用答案。 |
| `first_failure` | 任意任务失败、超时或取消后返回。 | 早失败监控，尽快介入。 |
| `any_update` | 任意任务产生新事件后返回。 | 需要流式/轮询进度，但不想等终态。 |
| `timeout_partial` | 全部完成或等待超时后返回已有结果。 | 批量任务仪表盘、分批收割。 |

`subagent_wait` 返回结构中会分开给出：

- `completed`：已经成功或部分成功的任务结果。
- `failed`：失败、超时或取消的任务结果。
- `pending_task_ids`：仍在运行的任务。
- `cancelled_task_ids`：已取消任务。

因此，想“先完成先处理”，使用：

```json
{
  "task_ids": ["task_a", "task_b", "task_c"],
  "return_when": "first_completed",
  "timeout_secs": 300,
  "on_timeout": "keep_running"
}
```

处理完返回的第一个结果后，再对 `pending_task_ids` 继续调用 `subagent_wait`。

想“全部完成再合并”，使用：

```json
{
  "task_ids": ["task_a", "task_b", "task_c"],
  "return_when": "all_completed",
  "timeout_secs": 600,
  "on_timeout": "cancel_pending"
}
```

## 取消、关闭、超时的区别

| 机制 | 触发方式 | 对子代理做什么 | 适合场景 |
|---|---|---|---|
| request cancellation | 用户停止当前 tool call / MCP SDK abort signal | 对绑定任务调用 `cancelActiveTask()` | 让用户手动停止主 agent 时同步停止子代理。 |
| `subagent_cancel` | 主 agent 显式调用 | ACP `session/cancel`，任务进入取消流程 | 主动取消后台任务。 |
| `subagent_close(force=false)` | 主 agent 显式调用 | 只允许关闭已完成任务/session | 释放 `keep_alive` session。 |
| `subagent_close(force=true)` | 主 agent 显式调用 | 先取消运行中任务，再关闭并清理 | 强制释放资源。 |
| `timeout_secs` | wall-clock 到期 | ACP cancel + 清理 | 防止单个任务无限运行。 |
| `inactivity_timeout_secs` | 长时间无活动 | ACP cancel + 清理 | 防止 agent 卡死或无输出。 |
| MCP Server shutdown | stdio 关闭 / SIGINT / SIGTERM / beforeExit | `shutdownAllActiveTasks()` 关闭全部活跃任务 | 进程级兜底清理。 |

## 推荐选择

- 只有一个任务，必须等结果：用 `subagent_run`。
- 一个或多个后台任务，但希望用户手动停止时一起停止：`subagent_start` / `subagent_start_many` 后立刻 `subagent_wait`，把所有需要级联取消的 `task_id` 都放进 wait。
- 多个任务，想先处理先完成者：`subagent_start_many` 后循环 `subagent_wait(return_when="first_completed")`。
- 多个任务，想后台继续跑，不受当前主 agent 停止影响：短轮询 `subagent_wait(return_when="timeout_partial", timeout_secs=几秒, on_timeout="keep_running")`，或者直接后续用 `subagent_result` 查询。
- 需要多轮对话：初始 `subagent_start(keep_alive=true)`，每轮完成后用 `subagent_continue`，再用 `subagent_wait` 等该轮结果，最后 `subagent_close`。
