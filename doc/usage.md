# 使用文档：常见编排方式

本项目提供的是 MCP tool 层面的子代理编排 API。主 agent 不需要直接管理子进程，也不需要直接读 ACP 协议；只需要选择合适的工具组合。

取消语义只对“真实 MCP tool call”成立：MCP Host 必须把用户停止当前响应转换成正在执行的 tool request cancellation。收到 cancellation 或 stdio transport 关闭后，本服务会立即进入强制清理路径：ACP `session/cancel` 只是 best-effort，默认最多等 `500ms`，随后清理本地进程树，`SIGTERM` 默认也只宽限 `500ms`，再用 `SIGKILL` 兜底。

不要用主 agent 的 shell / exec 临时写一个 Node harness 来测试“停止对话自动杀子代理”；即使该 harness 通过 stdio 调用本 MCP Server，只要 `node tmp/run-xxx.mjs` 还在进程表里，它就仍然持有 MCP request，服务端看到的是“请求仍在运行”。这种 harness 必须自己处理 `SIGINT` / `SIGTERM`，并在退出时关闭 MCP transport 或显式杀掉进程树。

如果 Host 只停止模型文本输出、没有发送 MCP cancellation，也没有关闭 stdio transport，本服务无法立刻感知用户点击了停止。为了避免这种场景下继续运行很久，默认 `inactivity_timeout_secs` 是 `15` 秒；超过该时间没有 ACP 协议层活动时，会按 `inactivity_timeout` 取消并清理子代理。

## 工具选择速查

| 目标 | 推荐组合 |
|---|---|
| 单个任务，等待结果 | `subagent_run` |
| 单个后台任务，稍后查询 | `subagent_start` -> `subagent_result` / `subagent_wait` |
| 多个任务并发运行，全部完成后合并 | 优先 `subagent_run_many(return_when="all_completed")`；需要后台队列时用 `subagent_start_many` -> `subagent_wait` |
| 多个任务并发运行，先完成先处理 | `subagent_run_many(return_when="first_completed")` 或 `subagent_start_many` -> 循环 `subagent_wait(return_when="first_completed")` |
| 多个任务并发运行，用户手动停止主 agent 时一起停止 | 优先 `subagent_run_many(wait_timeout_secs=足够长, on_timeout="cancel_pending")` |
| 多轮任务 | `subagent_start(keep_alive=true)` -> `subagent_wait` -> `subagent_continue` -> `subagent_wait` -> `subagent_close` |
| 后台任务主动取消 | `subagent_cancel` |
| 释放保留 session | `subagent_close` |
| 读取调试日志 | `subagent_logs` |
| 查看可用子代理和 Skill 桥接状态 | `subagent_list` / `subagent_skills` |

## 故障排查：停止后 Claude 进程还在

如果 `ps aux | grep -i '[c]laude'` 里同时看到：

```text
node tmp/run-claude-articles-run-many.mjs
node /opt/homebrew/bin/claude-agent-acp
.../claude --output-format stream-json ... --session-id ...
```

优先判断为测试方式问题：`node tmp/run-...mjs` 这个 launcher 没有被停止，所以它仍然在持有 `subagent_run_many` 请求。此时手动停止 Codex 当前回答只停止了模型输出，不等价于杀掉 shell 里已经启动的进程。

清理顺序建议：

1. 先杀 launcher 和 MCP Server 进程。
2. 再杀每个 `claude-agent-acp` 的 process group。
3. 最后按 Claude CLI 的 `--session-id` 或精确 PID 做兜底清理。

新的实现已经在 MCP Server 收到 cancellation / stdio 关闭 / `SIGINT` / `SIGTERM` 时执行强制进程树清理；但如果 launcher 本身没有收到任何信号，并继续保持 stdio request，本服务无法凭空知道用户在 Host UI 中点了停止。此时默认 15 秒无活动超时会作为兜底，`result.json` 会显示 `status=timeout`、`code=inactivity_timeout`。如果是正常 request cancellation，`result.json` 应显示 `status=cancelled`。

## 场景一：同步运行一个子代理

适合审查、分析、小型修复等主 agent 必须立即得到结果的场景。

调用 `subagent_run`：

```json
{
  "cwd": "/Users/you/workspace/app",
  "mode": "review",
  "timeout_secs": 300,
  "inactivity_timeout_secs": 60,
  "task": {
    "title": "审查登录模块",
    "goal": "找出阻塞上线的问题",
    "files": [
      { "path": "src/auth/login.ts", "role": "primary", "action": "review" },
      { "path": "tests/auth.test.ts", "role": "test", "action": "review" }
    ],
    "constraints": ["不要修改文件", "只返回高风险问题"],
    "expected_output": {
      "format": "structured",
      "include_files_changed": true,
      "include_risks": true,
      "include_next_steps": true
    }
  },
  "output": {
    "mode": "compact",
    "max_result_chars": 4000,
    "max_findings": 8
  }
}
```

行为：

- 当前 MCP tool call 会等待任务结束。
- 如果 MCP Host 把用户手动停止当前响应传播为 MCP request cancellation，子代理会被取消并清理进程树。
- 返回值直接包含 `status`、`summary`、`result`、`findings`、`files_changed`、`artifacts` 和 `errors`。

## 场景二：启动一个后台任务并等待

适合耗时较长、但仍希望在当前回答里等待结果的任务。先用 `subagent_start` 拿到 `task_id`，再用 `subagent_wait` 绑定等待与取消。

第一步，调用 `subagent_start`：

```json
{
  "cwd": "/Users/you/workspace/app",
  "keep_alive": false,
  "mode": "implement",
  "timeout_secs": 900,
  "task": {
    "title": "修复 refresh token 过期时间",
    "goal": "修复逻辑并补充测试",
    "files": [
      { "path": "src/auth/session.ts", "role": "primary", "action": "edit" },
      { "path": "tests/auth.test.ts", "role": "test", "action": "edit" }
    ],
    "success_criteria": ["相关测试通过", "同时覆盖 access token 与 refresh token"]
  }
}
```

返回示例：

```json
{
  "schema_version": 1,
  "status": "started",
  "task_id": "task_abc123",
  "agent_type": "claude",
  "session_id": "...",
  "created_at": "2026-05-17T00:00:00.000Z",
  "task_status": "running",
  "summary": "已启动子代理任务：task_abc123"
}
```

第二步，立刻调用 `subagent_wait`：

```json
{
  "task_ids": ["task_abc123"],
  "return_when": "all_completed",
  "timeout_secs": 900,
  "on_timeout": "cancel_pending"
}
```

这个组合的好处是：如果 MCP Host 在用户停止当前主 agent 响应时取消正在执行的 `wait` request，本服务会取消 `task_abc123`。如果你是直接在 shell 中运行测试脚本，则必须显式传入 `requestSignal`，否则 `wait` 无法感知停止。

## 场景三：拉起多个子代理，用户停止主 agent 时一起停止

这是最推荐的“批量并发 + 可取消”模式。优先使用 `subagent_run_many`，因为它在同一个 MCP tool call 内完成“启动多个任务 + 等待结果”。用户停止当前 tool call 时，本服务可以直接取消本次启动的全部仍在运行任务。

调用 `subagent_run_many`：

```json
{
  "conflict_policy": "allow_readonly_parallel",
  "on_task_failure": "cancel_all",
  "return_when": "all_completed",
  "wait_timeout_secs": 900,
  "on_timeout": "cancel_pending",
  "tasks": [
    {
      "cwd": "/Users/you/workspace/app",
      "mode": "review",
      "task": {
        "title": "架构风险审查",
        "goal": "从整体设计角度找风险",
        "constraints": ["不要修改文件"]
      }
    },
    {
      "cwd": "/Users/you/workspace/app",
      "mode": "review",
      "task": {
        "title": "实现缺陷审查",
        "goal": "检查代码实现缺陷和边界条件",
        "files": [
          { "path": "src/auth/session.ts", "role": "primary", "action": "review" }
        ],
        "constraints": ["不要修改文件"]
      }
    },
    {
      "cwd": "/Users/you/workspace/app",
      "mode": "review",
      "task": {
        "title": "测试缺口审查",
        "goal": "检查测试覆盖缺口",
        "files": [
          { "path": "tests/auth.test.ts", "role": "test", "action": "review" }
        ],
        "constraints": ["不要修改文件"]
      }
    }
  ]
}
```

返回值会同时包含：

- `started`：已经启动成功的任务。
- `rejected`：启动阶段被拒绝或失败的任务。
- `completed` / `failed`：等待阶段已经进入终态的结果。
- `pending_task_ids`：还在运行的任务。如果 `on_timeout="cancel_pending"`，超时后这些任务会被取消。

如果必须使用两步异步 API，也可以先 `subagent_start_many`，再把返回的 `started[].task_id` 全部放入 `subagent_wait`：

```json
{
  "task_ids": ["task_a", "task_b", "task_c"],
  "return_when": "all_completed",
  "timeout_secs": 900,
  "on_timeout": "cancel_pending"
}
```

为什么两步模式弱一些：`subagent_start_many` 返回后，启动请求已经结束，后台任务不再绑定这个已结束请求的取消信号。`subagent_wait` 会重新把这些任务绑定到当前主 agent 正在等待的 request 上；但在 `start_many` 返回和 `wait` 开始之间存在一个短暂窗口。`subagent_run_many` 没有这个窗口。这里的“绑定”不是靠 prompt 约定完成的，而是靠 MCP SDK 传入的 `requestSignal`；自定义 harness 需要自己提供这个 signal。

## 场景四：多个子代理先完成先处理

适合多个子代理给同一问题提供不同路线时，主 agent 想先处理最早返回的答案。

```json
{
  "task_ids": ["task_a", "task_b", "task_c"],
  "return_when": "first_completed",
  "timeout_secs": 300,
  "on_timeout": "keep_running"
}
```

返回后：

- 读取 `completed` 或 `failed` 里的结果。
- 对 `pending_task_ids` 再次调用 `subagent_wait`。
- 如果已经不需要剩余任务，调用 `subagent_cancel`：

```json
{
  "task_ids": ["task_b", "task_c"],
  "reason": "已有足够结果，取消剩余候选"
}
```

典型循环：

```text
remaining = started task ids
while remaining 非空:
  wait(return_when="first_completed", task_ids=remaining)
  处理 completed/failed
  remaining = wait.pending_task_ids
```

## 场景五：后台继续跑，不随当前主 agent 停止而取消

有些任务不希望被当前主 agent 的等待中断影响，例如长时间分析、批量审计或低优先级任务。可以使用短轮询，不让主 agent 长时间卡在一个 wait 上。

```json
{
  "task_ids": ["task_a", "task_b", "task_c"],
  "return_when": "timeout_partial",
  "timeout_secs": 5,
  "on_timeout": "keep_running"
}
```

这会在 5 秒后返回已有结果和 `pending_task_ids`，未完成任务继续运行。稍后可以继续调用 `subagent_result` 或 `subagent_wait`。

注意：这种模式下，如果用户停止主 agent 当前响应，已经脱离当前 wait 的后台任务可能继续运行。需要主动停止时调用 `subagent_cancel`。

## 场景六：多轮任务

多轮任务必须在初始启动时设置 `keep_alive=true`。任务完成后 session 会保留一段时间，供 `subagent_continue` 复用。

第一轮：

```json
{
  "cwd": "/Users/you/workspace/app",
  "keep_alive": true,
  "mode": "implement",
  "task": {
    "title": "实现登录限流",
    "goal": "实现登录失败限流并补充测试",
    "files": [
      { "path": "src/auth/rateLimit.ts", "role": "primary", "action": "edit" },
      { "path": "tests/rateLimit.test.ts", "role": "test", "action": "edit" }
    ]
  }
}
```

等待第一轮：

```json
{
  "task_ids": ["task_abc123"],
  "return_when": "all_completed",
  "timeout_secs": 600,
  "on_timeout": "cancel_pending"
}
```

如果主 agent 判断结果需要修正，调用 `subagent_continue`：

```json
{
  "task_id": "task_abc123",
  "mode": "fix",
  "message": "你刚才只处理了内存计数，没有说明多实例部署下的共享存储方案。请改成可插拔存储并补充测试。",
  "correction": {
    "reason": "上一轮方案不满足多实例部署",
    "expected_change": "提供可插拔存储接口，并给内存实现和测试。"
  },
  "timeout_secs": 600
}
```

随后再次 `subagent_wait` 同一个 `task_id`。所有轮次结束后释放 session：

```json
{
  "task_id": "task_abc123",
  "force": false
}
```

如果任务还在运行但必须释放，使用：

```json
{
  "task_id": "task_abc123",
  "force": true
}
```

## 场景七：带 Skill 桥接的任务

默认配置会扫描项目级 `.claude/skills` 和用户级 `~/.claude/skills`，并只把 Skill 名称和描述注入给子代理。

查看可用 Skill：

```json
{}
```

如果工具是 `subagent_skills`，可以传入过滤选项：

```json
{
  "cwd": "/Users/you/workspace/app",
  "include_project": true,
  "include_user": true,
  "limit": 20
}
```

默认只列清单：

```json
{
  "cwd": "/Users/you/workspace/app",
  "mode": "review",
  "task": {
    "title": "审查登录模块",
    "goal": "找出阻塞上线的问题"
  }
}
```

如需内联指定 Skill：

```json
{
  "cwd": "/Users/you/workspace/app",
  "skills": {
    "mode": "inline",
    "names": ["code-review"],
    "max_skill_chars": 8000
  },
  "task": {
    "title": "按 code-review Skill 审查登录模块",
    "goal": "输出阻塞问题和修复建议"
  }
}
```

关闭 Skill 注入：

```json
{
  "skills": { "mode": "off" },
  "task": { "title": "普通分析", "goal": "不使用 Skill 上下文" }
}
```

## 场景八：使用受信 MCP server profile

本项目默认禁止在 tool input 中动态传入 MCP server command。要让子代理使用额外 MCP server，需要先在配置或环境变量中定义 profile，再在任务中引用 profile 名称。

环境变量示例：

```bash
ACP_SUBAGENT_MCP_SERVERS_JSON='{
  "filesystem": {
    "enabled": true,
    "transport": "stdio",
    "command": "/absolute/path/to/filesystem-mcp",
    "args": ["--stdio"],
    "allowed_agents": ["claude"]
  }
}'
```

工具调用：

```json
{
  "mcp_server_profiles": ["filesystem"],
  "task": {
    "title": "使用文件系统 profile",
    "goal": "完成指定分析"
  }
}
```

## 场景九：读取结果、部分输出和日志

查询当前状态或最终结果：

```json
{
  "task_id": "task_abc123",
  "include_events": false,
  "include_raw_output": false,
  "max_chars": 4000
}
```

如果任务仍在运行，`subagent_result` 会返回 `partial_output`。如果任务已经完成，会返回 `result`。

读取日志：

```json
{
  "task_id": "task_abc123",
  "log_type": "events",
  "max_bytes": 20000,
  "redacted": true
}
```

`log_type` 可选：

- `events`：ACP 事件流。
- `stderr`：子进程 stderr。
- `result`：最终 `result.json`。
- `prompt`：渲染后的 prompt。
- `task`：启动时的任务输入。

## 场景十：写任务并发与冲突策略

`conflict_policy` 控制同一 cwd 下多个潜在写任务如何并发。

| 策略 | 行为 | 适合场景 |
|---|---|---|
| `allow_readonly_parallel` | 只读任务并行；同 cwd 写任务互斥。 | 多个审查/分析任务。 |
| `single_writer_per_cwd` | 默认策略；同 cwd 同时只允许一个潜在写任务。 | 普通本地修改，避免互相覆盖。 |
| `sandbox_worktree` | 写任务使用独立 git worktree，完成后提取 patch 文件。 | 多个写任务并行试方案。 |

`mode` 和 `files[].action` 会影响任务是否被视为潜在写任务。`edit`、`implement`、`debug` 以及 `files[].action` 为 `edit/create/delete` 的任务通常会触发写者冲突控制。

使用 `sandbox_worktree` 前必须在配置中开启：

```toml
[worktree]
enabled = true
base_dir = ".subagents/worktrees"
keep_on_failure = true
keep_on_success = false
max_patch_bytes = 2000000
include_untracked = false
```

`sandbox_worktree` 会返回 patch 文件路径，但不会自动合并 patch。

## 场景十一：降低 token 消耗

默认输出是 `compact`，不会返回完整事件流、stderr、prompt、原始输出和完整 structured 副本。大内容写入 `.subagents/runs`，MCP 输出只返回摘要和路径。

需要更多细节时显式请求：

```json
{
  "output": {
    "mode": "full",
    "max_result_chars": 12000,
    "include_structured": true,
    "include_diagnostics": true
  }
}
```

建议：

- 日常编排用 `compact`。
- 主 agent 需要做精确合并时用 `standard` 或设置更大的 `max_result_chars`。
- 调试解析问题时才用 `full`、`include_structured` 和 `include_diagnostics`。

## 常见陷阱

1. `subagent_start_many` 返回 `started` 不代表任务完成，只代表启动成功。
2. 想让用户停止主 agent 时取消后台任务，必须让主 agent 正处在覆盖这些任务的 `subagent_wait` 中，或使用同步 `subagent_run`。
3. `keep_alive=true` 会保留 session，但任务失败、超时、取消时仍会清理。
4. `subagent_continue` 只能用于 `keep_alive=true` 且上一轮已经结束的任务。
5. 动态 `mcp_servers` 不允许出现在 tool input 中，只能引用受信 `mcp_server_profiles`。
6. 协议级权限不是 OS sandbox；生产环境需要配合容器、专用用户或文件系统隔离。
