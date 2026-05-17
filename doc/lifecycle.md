# 生命周期、同步/异步与取消语义

本文回答几个最容易误解的问题：单个子代理是否同步、多个子代理是否同步、主 agent 被用户手动停止时子代理是否会自动停止，以及异步任务如何把结果交回主 agent。

## 关键结论

| 场景 | 当前工具调用是否等待任务完成 | 用户手动停止当前主 agent/tool call 时是否级联取消子代理 | 结果如何回到主 agent |
|---|---:|---:|---|
| `subagent_run` | 是。等待第一轮 prompt 结束后返回结果。 | 有条件。Host 必须把用户停止映射为当前 MCP request cancellation；本服务会继续做本地强制清理。 | 直接作为 `subagent_run` 结果返回。 |
| `subagent_start` | 否。只等初始化、创建 session、启动第一轮 prompt 后返回 `task_id`。 | 仅在启动 tool call 尚未返回前会级联取消；返回后不再绑定当前 request。 | 后续用 `subagent_wait` / `subagent_result` / `subagent_logs` 查询。 |
| `subagent_start_many` | 否。它会逐个完成启动阶段并返回所有已启动的 `task_id`，不会等任务完成。 | 仅在 `start_many` tool call 尚未返回前会取消已启动项；返回后不再绑定当前 request。 | 后续用 `subagent_wait` / `subagent_result` / `subagent_logs` 查询。 |
| `subagent_run_many` | 是。先批量启动，再在同一个 tool call 内等待。 | 有条件。Host 取消当前 tool call 时，本服务会取消本次启动的所有仍在运行任务，并强制清理进程树。 | 返回 `started/rejected/completed/failed/pending_task_ids`。 |
| `subagent_wait` | 是。按 `return_when` 等待指定任务完成或产生更新。 | 有条件。Host 取消当前 wait 时，wait 覆盖的仍在运行任务会被取消。 | `wait` 返回已完成、失败、仍在运行的任务列表。 |
| `subagent_continue` | 否。向保留的 session 发起下一轮 prompt 后返回 `turn_id`。 | 当前 continue 请求尚未返回前可取消本轮；返回后建议立刻用 `wait` 绑定取消。 | 后续用 `subagent_wait` / `subagent_result` 查询该任务最新轮次结果。 |
| `subagent_cancel` | 是。发出取消请求后返回取消结果。 | 不适用。 | 返回取消成功、已终态和失败列表。 |
| `subagent_close` | 是。关闭任务和保留 session。 | 不适用。 | 返回关闭结果。 |

## 重要前提：手动停止不是跨 Host 的绝对保证

“用户手动停止主 agent 后子代理自动停止”有一个协议前提：**当前 MCP Host 必须向正在执行的 MCP tool call 发送 cancellation，或者关闭 MCP stdio transport / 结束 MCP Server 进程**。本服务只能响应已经到达 MCP Server 的信号，不能凭空感知某个 Host UI 中的“停止生成”按钮。

收到真实 cancellation / transport close / `SIGINT` / `SIGTERM` 时，默认策略是快速清理：服务端立即进入 `forceCancelActiveTask()`，ACP `session/cancel` 只等 `500ms`，本地进程树收到 `SIGTERM` 后也只等 `500ms`，随后发 `SIGKILL`。长 tool call 还会在 Host 提供 `progressToken` 时每 `1000ms` 发送一次 MCP progress heartbeat，帮助 Host 持续感知请求仍在运行，并在 transport 断开时更早触发本地 abort。如果 Host 没有发 cancellation，也没有关闭 transport，则默认 `inactivity_timeout_secs=15` 作为兜底；这时结果会是 `timeout / inactivity_timeout`，不是 `cancelled`。

尤其要区分两种测试方式：

- 真实 MCP 调用：主 agent 调用 `subagent_run`、`subagent_run_many` 或 `subagent_wait`，Host 把停止动作映射为 MCP request cancellation，此时本服务会级联取消并强制清理进程树。
- 临时 shell / Node harness：主 agent 在终端里执行 `node tmp/run-xxx.mjs`。即使这个脚本通过 stdio 再调用本 MCP Server，它本身也只是一个普通 shell 子进程；除非 Codex/终端真的杀掉该脚本进程，或脚本自己安装 `SIGINT/SIGTERM/exit` 清理钩子，否则它仍会继续持有 MCP request，MCP Server 看到的就是“请求还在运行”，不会触发 request cancellation。

因此，如果看到 `node tmp/run-xxx.mjs`、`claude-agent-acp`、`claude` 仍在系统进程中，通常有三类原因：

1. 使用了临时 harness 或后台 shell 进程；停止主 agent 文本输出并没有杀掉这个 harness。
2. 当前 Host 没有把“停止当前回答”转成 MCP cancellation，只是停止了模型继续生成文本。
3. ACP adapter 又启动了孙进程，且孙进程没有留在 adapter 的 process group 中；只杀 adapter 进程组可能漏掉孙进程。

排查时先看是否仍有 `node tmp/run-xxx.mjs`。如果它还活着，说明当前测试脚本还在继续持有请求；应该先停止这个 launcher，再清理 adapter / Claude 进程。真正的 MCP tool 取消测试不应该通过 shell launcher 完成，而应该把本 MCP Server 配到 Codex/Claude Desktop 等 Host，让主 agent 直接调用 `subagent_run_many` 这个 MCP tool。

本版本的取消流程是“ACP cancel best-effort + 本地强制清理”：即使 ACP adapter 不响应 `session/cancel`，本服务也不会一直等它，而会继续关闭 stdio，并在 Unix 下同时扫描 adapter 进程树、adapter process group 以及孙进程自己的 process group，先发 `SIGTERM`，默认 500ms 宽限后再 `SIGKILL`。新增的 progress heartbeat 是 MCP request 级机制，不是子代理存活检测；`inactivity_timeout_secs` 仍是在 Host 没有传来取消信号时的安全兜底。

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
  -> forceCancelActiveTask()
  -> 当前 prompt 的 timeout/abort controller 进入 cancelled
  -> best-effort ACP session/cancel
  -> 不等待 ACP adapter 响应，turn 立即进入 finally
  -> cleanupActiveTask() 清理进程树
  -> terminateProcessTree(SIGTERM, grace 后 SIGKILL)
```

如果用户停止的是已经返回后的 `subagent_start`，不会因为之前那个已经结束的 request 自动停止。此时任务已经变成后台任务，必须依赖以下方式之一停止：

- 立刻调用 `subagent_wait` 覆盖该 `task_id`，用户停止 wait 时会取消该任务。
- 主 agent 显式调用 `subagent_cancel`。
- 主 agent 显式调用 `subagent_close` 且 `force=true`。
- MCP transport 关闭、MCP Server 进程收到 `SIGINT` / `SIGTERM` 或 Node 进程退出时，服务端兜底关闭所有活跃任务。

因此，想让“用户手动停止主 agent”也停止异步子代理，有两种选择：

```text
最强绑定：subagent_run_many(...)
  # 一个 MCP tool call 内启动并等待，取消窗口最小。

兼容旧组合：subagent_start -> subagent_wait(task_ids=[...], return_when=..., timeout_secs=足够长, on_timeout=cancel_pending 或 keep_running)
  # start 返回后必须立刻进入 wait。
```

主 agent 应该尽量让用户可能点击停止的时间落在 `subagent_run`、`subagent_run_many` 或覆盖目标任务的 `subagent_wait` 上。这样 Host 发送 cancellation 时，本服务才有当前 request 可以绑定并级联取消。

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

想要“拉起多个子代理，且主 agent 被用户手动停止时子代理一起停止”，优先用一个 tool call 完成启动和等待：

```text
subagent_run_many(
  tasks=[...],
  return_when="all_completed" 或其他策略,
  wait_timeout_secs=足够长,
  on_timeout="cancel_pending"
)
```

`subagent_run_many` 内部等价于 `start_many -> wait`，但它把两步放进同一个 MCP request，减少了 `start_many` 已经返回、`wait` 尚未开始这段无法绑定取消的窗口。

如果需要兼容旧组合，也可以：

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

当 MCP Host 将“用户停止主 agent 当前响应”转换为当前 `subagent_run_many` 或 `subagent_wait` request cancellation 时，本服务会把覆盖的仍在运行子代理全部取消。反过来，如果 Host 没有发送 MCP cancellation，或者主 agent 实际是在 shell 里运行自定义 harness，服务端就无法自动得知用户停止。

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
| request cancellation | 用户停止当前 tool call / MCP SDK abort signal | 对绑定任务调用 `forceCancelActiveTask()`，不等待 ACP cancel 自然完成 | 让用户手动停止主 agent 时同步停止子代理。 |
| MCP request heartbeat | 长 tool call 且 Host 提供 `progressToken` | 每隔 `mcp_request_heartbeat_ms` 发送一次 progress；发送失败则本地 abort | 帮助 Host 更快处理长请求取消和 transport 断开。 |
| `subagent_cancel` | 主 agent 显式调用 | ACP `session/cancel`，任务进入取消流程 | 主动取消后台任务。 |
| `subagent_close(force=false)` | 主 agent 显式调用 | 只允许关闭已完成任务/session | 释放 `keep_alive` session。 |
| `subagent_close(force=true)` | 主 agent 显式调用 | 先取消运行中任务，再关闭并清理 | 强制释放资源。 |
| `timeout_secs` | wall-clock 到期 | ACP cancel + 清理 | 防止单个任务无限运行。 |
| `inactivity_timeout_secs` | 长时间无 ACP 协议层活动，默认 15 秒 | ACP cancel + 清理 | 防止 agent 卡死；也作为 Host 未传 cancellation 时的快速兜底。 |
| MCP Server shutdown | stdio 关闭 / SIGINT / SIGTERM / beforeExit | `shutdownAllActiveTasks()` 关闭全部活跃任务 | 进程级兜底清理。 |

## 推荐选择

- 只有一个任务，必须等结果：用 `subagent_run`。
- 一个或多个任务，希望用户手动停止时一起停止：优先 `subagent_run_many`；需要显式后台队列时再使用 `subagent_start` / `subagent_start_many` 后立刻 `subagent_wait`，把所有需要级联取消的 `task_id` 都放进 wait。
- 多个任务，想先处理先完成者：`subagent_start_many` 后循环 `subagent_wait(return_when="first_completed")`。
- 多个任务，想后台继续跑，不受当前主 agent 停止影响：短轮询 `subagent_wait(return_when="timeout_partial", timeout_secs=几秒, on_timeout="keep_running")`，或者直接后续用 `subagent_result` 查询。
- 需要多轮对话：初始 `subagent_start(keep_alive=true)`，每轮完成后用 `subagent_continue`，再用 `subagent_wait` 等该轮结果，最后 `subagent_close`。
