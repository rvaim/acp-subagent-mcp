# API 文档：MCP tools 输入输出

本文描述 `acp-subagent-mcp` 暴露给主 agent 的 MCP tools。所有工具返回 JSON object，同时也会被包装为 MCP text content，便于不支持 output schema 的 Host 使用。

## 通用概念

### `agent_type`

`agent_type` 可选。省略时使用配置中的默认 agent，默认是 `claude`。

### `cwd`

`cwd` 是子代理运行时工作目录。未传时会按以下顺序推断：

1. `CLAUDE_PROJECT_DIR`
2. `INIT_CWD`
3. `PWD`
4. MCP Server 进程当前目录

如果配置了 `ACP_SUBAGENT_WORKSPACE_ROOTS` 或 `[security].allowed_cwd_roots`，`cwd` 必须位于允许根目录内。

### `task`

`task` 是结构化任务描述，`title` 和 `goal` 必填。

```json
{
  "title": "审查登录模块",
  "goal": "找出阻塞上线的问题",
  "background": "可选背景",
  "instructions": ["具体执行步骤"],
  "files": [
    {
      "path": "src/auth/login.ts",
      "role": "primary",
      "action": "review",
      "description": "登录逻辑",
      "line_ranges": [{ "start": 1, "end": 120 }],
      "content_mode": "path_only"
    }
  ],
  "constraints": ["不要修改文件"],
  "expected_output": {
    "format": "structured",
    "required_sections": ["summary", "risks"],
    "include_files_changed": true,
    "include_risks": true,
    "include_next_steps": true
  },
  "success_criteria": ["只返回高风险问题"],
  "parent_context": {
    "parent_agent": "claude",
    "conversation_summary": "前面对话摘要",
    "previous_findings": ["已知结论"]
  }
}
```

### `files[]`

| 字段 | 必填 | 说明 |
|---|---:|---|
| `path` | 是 | 相对 `cwd` 的安全路径；不能是绝对路径，不能路径穿越。 |
| `role` | 是 | `primary` / `reference` / `test` / `config` / `output` / `unknown`。 |
| `action` | 是 | `read` / `review` / `edit` / `create` / `delete` / `ignore`。 |
| `description` | 否 | 文件用途说明。 |
| `line_ranges` | 否 | 关注行号范围。 |
| `content` | 否 | 内联内容或片段。 |
| `content_mode` | 否 | `path_only` / `inline` / `snippet`，默认 `path_only`。 |

### `mode`

`subagent_run`、`subagent_run_many`、`subagent_start`、`subagent_start_many` 的任务模式：

| 值 | 说明 |
|---|---|
| `analyze` | 默认分析任务。 |
| `review` | 审查任务，通常不应修改文件。 |
| `edit` | 修改指定文件。 |
| `implement` | 实现功能或修复。 |
| `debug` | 调试问题。 |
| `custom` | 自定义任务。 |

`subagent_continue` 的继续模式：`revise` / `fix` / `clarify` / `continue` / `custom`。

### `output`

控制返回给主 agent 的内容量。

```json
{
  "mode": "compact",
  "max_result_chars": 4000,
  "max_findings": 8,
  "include_diagnostics": false,
  "include_structured": false
}
```

| 字段 | 默认 | 说明 |
|---|---|---|
| `mode` | `compact` | `compact` / `standard` / `full`。 |
| `max_result_chars` | `4000` | `result` 最大字符数，范围 200 到 50000。 |
| `max_findings` | `8` | 返回 findings 最大条数。 |
| `include_diagnostics` | `false` | 是否返回工具调用和触碰文件等诊断信息。 |
| `include_structured` | `false` | 是否返回完整 structured 字段。 |

### `skills`

控制父代理 Skill 桥接。

```json
{
  "mode": "list",
  "names": ["code-review"],
  "include_project": true,
  "include_user": true,
  "max_skill_chars": 8000,
  "max_total_chars": 20000
}
```

| 字段 | 说明 |
|---|---|
| `mode` | `off` 不注入；`list` 注入名称/描述；`inline` 内联指定 `SKILL.md`。 |
| `names` | 选择或内联的 Skill 名称。 |
| `include_project` | 是否扫描项目级 `.claude/skills`。 |
| `include_user` | 是否扫描用户级 `~/.claude/skills`。 |
| `max_skill_chars` | 单个内联 Skill 最大字符数。 |
| `max_total_chars` | 所有内联 Skill 总字符数上限。 |

### 任务状态

| 状态 | 含义 |
|---|---|
| `created` | 已创建但尚未启动。 |
| `starting` | 正在启动子进程、初始化 ACP 或创建 session。 |
| `running` | 当前 prompt turn 正在运行。 |
| `waiting_permission` | 预留状态，表示等待权限。 |
| `cancelling` | 正在取消。 |
| `completed` | 成功完成。 |
| `partial` | 部分完成。 |
| `failed` | 失败。 |
| `timeout` | 超时。 |
| `cancelled` | 已取消。 |
| `closed` | 任务/session 已关闭。 |

终态包括：`completed`、`partial`、`failed`、`timeout`、`cancelled`、`closed`。其中 `closed` 不再算可继续等待的运行结果状态。

### 运行结果 `SubagentRunOutput`

```json
{
  "schema_version": 1,
  "status": "completed",
  "agent_type": "claude",
  "session_id": "...",
  "summary": "一句话总结",
  "result": "主要结果，可能截断",
  "findings": [],
  "files_changed": [],
  "risks": [],
  "next_steps": [],
  "structured": {},
  "stop_reason": "end_turn",
  "metrics": {
    "elapsed_ms": 1234,
    "returned_result_chars": 1000,
    "original_result_chars": 2000
  },
  "artifacts": {
    "run_dir": ".subagents/runs/run_...",
    "event_log": ".subagents/runs/run_.../events.jsonl",
    "stderr_log": ".subagents/runs/run_.../stderr.log",
    "result_json": ".subagents/runs/run_.../result.json"
  },
  "skills": {
    "mode": "list",
    "names": ["code-review"],
    "truncated": false
  },
  "diagnostics": {
    "tool_calls": [],
    "files_touched": []
  },
  "truncated": false,
  "errors": []
}
```

## `subagent_list`

列出可用 ACP 子代理、默认 agent 和 Skill 桥接状态。

### 输入

无需参数。

```json
{}
```

### 输出

```json
{
  "default_agent": "claude",
  "config_source": "defaults",
  "skills": {
    "enabled": true,
    "default_mode": "list"
  },
  "agents": [
    {
      "name": "claude",
      "description": "默认 Claude ACP 子代理。",
      "capabilities": ["claude", "code", "review", "analysis", "edit"],
      "default": true,
      "install_hint": "..."
    }
  ]
}
```

### 使用场景

- 主 agent 不确定有哪些子代理可用。
- 启动任务前需要选择 `agent_type`。
- 排查默认 agent 或 Skill 桥接配置。

## `subagent_run`

同步运行一个子代理任务，等待第一轮 prompt 完成后返回结果。

### 输入

```json
{
  "agent_type": "claude",
  "cwd": "/Users/you/workspace/app",
  "mode": "review",
  "timeout_secs": 600,
  "inactivity_timeout_secs": 15,
  "mcp_server_profiles": ["filesystem"],
  "skills": { "mode": "list" },
  "output": { "mode": "compact", "max_result_chars": 4000 },
  "task": {
    "title": "审查登录模块",
    "goal": "找出阻塞上线的问题"
  }
}
```

### 输出

返回 `SubagentRunOutput`。

### 取消语义

`subagent_run` 会把当前 MCP request 的取消信号绑定到子代理任务。前提是 MCP Host 确实把用户停止当前响应传播为 request cancellation；满足该前提时，本服务会立即进入强制清理路径：ACP `session/cancel` 最多默认等待 500ms，随后清理本地进程树。如果 Host 没有发送 cancellation，默认 15 秒 `inactivity_timeout_secs` 会作为兜底。

### 使用场景

- 单个任务必须立即拿到结果。
- 希望用户手动停止主 agent 时同步停止子代理。
- 不需要多轮 session。

## `subagent_run_many`

同步批量运行多个子代理任务。它会在同一个 MCP tool call 中执行：

```text
subagent_start_many -> subagent_wait
```

与手动两步调用相比，`subagent_run_many` 的优势是取消绑定更强：用户停止当前 tool call 时，本服务可以取消本次已经启动的全部仍在运行任务，且没有 `start_many` 已返回、`wait` 尚未开始的窗口。

### 输入

```json
{
  "conflict_policy": "allow_readonly_parallel",
  "on_task_failure": "cancel_all",
  "return_when": "all_completed",
  "wait_timeout_secs": 900,
  "on_timeout": "cancel_pending",
  "tasks": [
    {
      "agent_type": "claude",
      "cwd": "/Users/you/workspace/app",
      "mode": "review",
      "timeout_secs": 600,
      "task": {
        "title": "架构审查",
        "goal": "检查架构风险"
      }
    },
    {
      "agent_type": "claude",
      "cwd": "/Users/you/workspace/app",
      "mode": "review",
      "timeout_secs": 600,
      "task": {
        "title": "测试审查",
        "goal": "检查测试缺口"
      }
    }
  ]
}
```

| 字段 | 默认 | 说明 |
|---|---|---|
| `tasks` | 必填 | 与 `subagent_start_many.tasks` 相同，1 到 32 个任务。 |
| `conflict_policy` | 配置默认值 | 批量任务的冲突策略。 |
| `on_task_failure` | `keep_others_running` | 某个任务启动失败后继续其他任务，或取消已启动任务。 |
| `return_when` | `all_completed` | 与 `subagent_wait.return_when` 相同。 |
| `wait_timeout_secs` | 未设置则使用 `subagent_wait` 默认 | 批量等待最大时间；不影响单个任务自己的 `timeout_secs`。 |
| `on_timeout` | `cancel_pending` | 等待超时后是否取消仍在运行的任务。 |

### 输出

```json
{
  "schema_version": 1,
  "status": "completed",
  "started": [],
  "rejected": [],
  "completed": [],
  "failed": [],
  "pending_task_ids": [],
  "cancelled_task_ids": [],
  "elapsed_ms": 1234,
  "summary": "已启动 2 个，拒绝 0 个；完成 2 个，失败 0 个，仍在运行 0 个。"
}
```

`status` 可能是：

- `completed`：等待条件满足，且没有仍在运行任务。
- `partial`：按 `return_when` 提前返回，例如 `first_completed`。
- `timeout`：等待超时。
- `failed`：没有任何任务成功启动。

### 取消语义

`subagent_run_many` 会把当前 MCP request cancellation 绑定到本次启动的所有任务。前提仍然是 MCP Host 确实发送 request cancellation。收到取消后，本服务会对所有仍在运行任务执行 best-effort ACP `session/cancel`，默认最多等待 500ms，然后继续本地强制清理进程树。如果 Host 未发送 cancellation，则默认 15 秒无 ACP 协议层活动会触发 `inactivity_timeout` 兜底清理。

### 使用场景

- 多个子代理 fan-out/fan-in，最终由主 agent 汇总。
- 用户手动停止当前回答时，要求本批子代理一起停止。
- 希望减少 `start_many` 与 `wait` 两步之间的取消盲区。

## `subagent_start`

异步启动一个子代理任务，返回 `task_id`。任务在后台继续运行。

### 输入

与 `subagent_run` 基本一致，额外支持：

| 字段 | 默认 | 说明 |
|---|---|---|
| `keep_alive` | `false` | 完成后是否保留 ACP session，以支持 `subagent_continue`。 |
| `conflict_policy` | 配置默认值 | 本任务冲突策略。 |

```json
{
  "cwd": "/Users/you/workspace/app",
  "keep_alive": true,
  "conflict_policy": "single_writer_per_cwd",
  "mode": "implement",
  "task": {
    "title": "实现登录限流",
    "goal": "实现登录失败限流并补测试"
  }
}
```

### 输出

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

### 取消语义

- 如果用户在 `subagent_start` 尚未返回前停止当前 request，任务会被取消。
- 如果 `subagent_start` 已经返回，后台任务不再绑定已结束 request。要让后续手动停止也取消任务，应立即调用 `subagent_wait` 覆盖该 `task_id`。多任务场景下优先使用 `subagent_run_many`。

### 使用场景

- 任务较长，需要后续查询或等待。
- 需要 `keep_alive=true` 进行多轮。
- 需要与其他任务一起等待或批量取消。

## `subagent_start_many`

批量启动多个子代理任务。启动阶段按输入顺序逐个创建任务；成功启动的任务会在后台并发运行。该工具不等待任务完成。

### 输入

```json
{
  "conflict_policy": "allow_readonly_parallel",
  "on_task_failure": "keep_others_running",
  "tasks": [
    {
      "agent_type": "claude",
      "cwd": "/Users/you/workspace/app",
      "mode": "review",
      "keep_alive": false,
      "task": {
        "title": "架构审查",
        "goal": "找出设计风险"
      }
    },
    {
      "cwd": "/Users/you/workspace/app",
      "mode": "review",
      "task": {
        "title": "实现审查",
        "goal": "找出实现缺陷"
      }
    }
  ]
}
```

| 字段 | 默认 | 说明 |
|---|---|---|
| `tasks` | 必填 | 1 到 32 个任务。每个元素与 `subagent_start` 输入相同，但不能单独设置 `conflict_policy`。 |
| `conflict_policy` | 配置默认值 | 应用于本批任务的冲突策略。 |
| `on_task_failure` | `keep_others_running` | 单个任务启动失败后，是继续保留其他任务，还是 `cancel_all`。 |

### 输出

```json
{
  "schema_version": 1,
  "status": "started",
  "started": [
    {
      "schema_version": 1,
      "status": "started",
      "task_id": "task_a",
      "agent_type": "claude",
      "session_id": "...",
      "created_at": "2026-05-17T00:00:00.000Z",
      "task_status": "running",
      "summary": "已启动子代理任务：task_a"
    }
  ],
  "rejected": [
    {
      "index": 1,
      "agent_type": "codex",
      "reason": "失败原因",
      "error_code": "agent_spawn_failed"
    }
  ],
  "summary": "已启动 1 个子代理任务，拒绝 1 个。"
}
```

`status` 为：

- `started`：全部启动成功。
- `partial`：至少一个任务启动失败或被拒绝。

### 取消语义

- `start_many` 未返回前被取消：已启动任务会被取消。
- `start_many` 返回后，后台任务不再绑定该 request。要让用户停止主 agent 时一起停止这些任务，应立即调用 `subagent_wait`，并把 `started[].task_id` 全部传入。

### 使用场景

- fan-out 并发分析。
- 多子代理给同一问题提供第二意见。
- 批量审查多个模块。

## `subagent_wait`

等待一个或多个任务完成、失败或产生更新。

### 输入

```json
{
  "task_ids": ["task_a", "task_b"],
  "return_when": "all_completed",
  "timeout_secs": 600,
  "on_timeout": "keep_running"
}
```

| 字段 | 默认 | 说明 |
|---|---|---|
| `task_ids` | 必填 | 1 到 64 个任务 ID。 |
| `return_when` | 必填 | 等待返回策略。 |
| `timeout_secs` | `30` | 本次等待最大时间，最长 24 小时。 |
| `on_timeout` | `keep_running` | 超时后保留未完成任务，或取消未完成任务。 |

### `return_when`

| 值 | 返回时机 |
|---|---|
| `all_completed` | 所有任务进入完成态、失败态、超时态或取消态。 |
| `first_completed` | 任意任务进入终态。 |
| `first_success` | 任意任务成功或部分成功。 |
| `first_failure` | 任意任务失败、超时或取消。 |
| `any_update` | 任意任务有新事件。 |
| `timeout_partial` | 全部完成或等待超时。 |

### `on_timeout`

| 值 | 行为 |
|---|---|
| `keep_running` | 超时返回已有状态，未完成任务继续运行。 |
| `cancel_pending` | 超时后取消仍在运行的任务。 |

### 输出

```json
{
  "schema_version": 1,
  "status": "partial",
  "completed": [
    { "task_id": "task_a", "schema_version": 1, "status": "completed", "agent_type": "claude", "summary": "...", "result": "...", "metrics": { "elapsed_ms": 1000 }, "errors": [] }
  ],
  "failed": [],
  "pending_task_ids": ["task_b"],
  "cancelled_task_ids": [],
  "elapsed_ms": 30000,
  "summary": "完成 1 个，失败 0 个，仍在运行 1 个。"
}
```

`status` 为：

- `completed`：没有 pending 任务。
- `partial`：满足返回条件但仍有 pending 任务。
- `timeout`：本次 wait 超时且仍有 pending 任务。

### 取消语义

`subagent_wait` 是异步任务编排中最重要的取消绑定点。用户手动停止当前 wait request 时，本服务会取消 `task_ids` 中仍在运行的任务。

### 使用场景

- `start` / `start_many` 后等待结果。
- “先完成先处理”。
- 用户手动停止主 agent 时取消一组后台任务。
- 短轮询后台任务状态。

## `subagent_result`

查询单个任务当前状态、最终结果或部分输出。

### 输入

```json
{
  "task_id": "task_abc123",
  "include_events": false,
  "include_raw_output": false,
  "max_chars": 4000
}
```

| 字段 | 默认 | 说明 |
|---|---|---|
| `task_id` | 必填 | 任务 ID。 |
| `include_events` | `false` | 是否返回事件日志尾部片段。 |
| `include_raw_output` | `false` | 是否保留 `structured.raw_output`。 |
| `max_chars` | `4000` | 部分输出或日志片段最大字符数，范围 200 到 50000。 |

### 输出

```json
{
  "schema_version": 1,
  "task_id": "task_abc123",
  "agent_type": "claude",
  "status": "running",
  "latest_summary": "...",
  "result": null,
  "partial_output": "当前已聚合的部分文本",
  "raw_event_log_path": ".subagents/runs/run_.../events.jsonl",
  "events_tail": "...",
  "summary": "任务 task_abc123 当前状态：running"
}
```

如果任务已完成，`result` 会包含 `SubagentRunOutput`；如果任务仍在运行，通常返回 `partial_output`。

### 使用场景

- 不想阻塞等待，只查询状态。
- wait 返回 `pending_task_ids` 后查看部分输出。
- 调试任务事件。

## `subagent_continue`

对 `keep_alive=true` 且上一轮已经结束的任务继续发送一轮 prompt。

### 输入

```json
{
  "task_id": "task_abc123",
  "message": "请根据上一轮结果继续修正。",
  "correction": {
    "reason": "上一轮遗漏了 refresh token",
    "rejected_result": "可选：上一轮结果摘要",
    "expected_change": "同时更新 refresh token 逻辑并补测试"
  },
  "additional_files": [
    { "path": "src/auth/session.ts", "role": "primary", "action": "edit" }
  ],
  "mode": "fix",
  "timeout_secs": 600,
  "inactivity_timeout_secs": 15,
  "skills": { "mode": "list" },
  "output": { "mode": "compact" }
}
```

| 字段 | 默认 | 说明 |
|---|---|---|
| `task_id` | 必填 | 初始 `keep_alive=true` 任务 ID。 |
| `message` | 必填 | 本轮新消息。 |
| `correction` | 否 | 对上一轮结果的纠正说明。 |
| `additional_files` | 否 | 本轮新增或重新指定的文件。 |
| `mode` | `continue` | `revise` / `fix` / `clarify` / `continue` / `custom`。 |
| `timeout_secs` | 配置默认值 | 本轮最大运行时间。 |
| `inactivity_timeout_secs` | 配置默认值 | 本轮无活动超时。 |
| `skills` | 否 | 本轮新增 Skill 桥接选项。 |
| `output` | 初始输出选项 | 本轮输出选项。 |

### 输出

```json
{
  "schema_version": 1,
  "status": "started",
  "task_id": "task_abc123",
  "turn_id": "turn_def456",
  "session_id": "...",
  "created_at": "2026-05-17T00:00:00.000Z",
  "summary": "已向子代理继续发送任务：task_abc123"
}
```

### 限制

- 只支持 `keep_alive=true` 的任务。
- 上一轮必须已经结束，不能同一个 session 同时运行两个 prompt turn。
- 任务失败、超时、取消后通常会清理，不再适合继续。

### 使用场景

- 主 agent 对子代理结果不满意，需要打回修改。
- 需要保持同一 ACP session 上下文。
- 多轮澄清或迭代实现。

## `subagent_cancel`

取消一个或多个任务。

### 输入

```json
{
  "task_ids": ["task_a", "task_b"],
  "reason": "已有足够结果，取消剩余任务"
}
```

| 字段 | 说明 |
|---|---|
| `task_ids` | 1 到 64 个任务 ID。 |
| `reason` | 可选取消原因，会写入错误和日志。 |

### 输出

```json
{
  "schema_version": 1,
  "status": "cancelled",
  "cancelled_task_ids": ["task_a"],
  "already_terminal_task_ids": ["task_b"],
  "failed": [],
  "summary": "已请求取消 1 个任务，失败 0 个。"
}
```

`status` 为：

- `cancelled`：没有失败项。
- `partial`：有成功取消也有失败。
- `failed`：全部失败。

### 使用场景

- 取消后台任务。
- `first_success` 拿到结果后取消剩余任务。
- 主 agent 主动释放资源。

## `subagent_close`

关闭任务和保留的 session。

### 输入

```json
{
  "task_id": "task_abc123",
  "force": false
}
```

| 字段 | 默认 | 说明 |
|---|---|---|
| `task_id` | 必填 | 任务 ID。 |
| `force` | `false` | 若任务仍在运行，是否先取消再关闭。 |

### 输出

```json
{
  "schema_version": 1,
  "status": "closed",
  "task_id": "task_abc123",
  "closed_at": "2026-05-17T00:00:00.000Z",
  "summary": "已关闭子代理任务：task_abc123"
}
```

### 使用场景

- `keep_alive=true` 多轮结束后释放 session。
- 强制关闭运行中任务。
- 清理并发锁、timer 和子进程。

## `subagent_logs`

读取脱敏且截断后的本地日志。

### 输入

```json
{
  "task_id": "task_abc123",
  "log_type": "events",
  "max_bytes": 20000,
  "redacted": true
}
```

| 字段 | 默认 | 说明 |
|---|---|---|
| `task_id` | 必填 | 任务 ID。 |
| `log_type` | `events` | `events` / `stderr` / `result` / `prompt` / `task`。 |
| `max_bytes` | `20000` | 最大读取字节数，范围 200 到 1000000。 |
| `redacted` | `true` | 是否二次脱敏。 |

### 输出

```json
{
  "schema_version": 1,
  "task_id": "task_abc123",
  "log_type": "events",
  "content": "...",
  "truncated": false,
  "summary": "已读取日志：events"
}
```

### 使用场景

- 调试 ACP 通信问题。
- 查看子代理 stderr。
- 获取完整 result JSON 或渲染 prompt。

## `subagent_skills`

列出可桥接给子代理的父代理 Skills 短清单。该工具只返回名称、描述、来源等轻量信息，不返回完整 `SKILL.md`。

### 输入

```json
{
  "cwd": "/Users/you/workspace/app",
  "include_project": true,
  "include_user": true,
  "limit": 20
}
```

| 字段 | 默认 | 说明 |
|---|---|---|
| `cwd` | 自动推断 | 用于发现项目级 `.claude/skills`。 |
| `include_project` | 配置默认值 | 是否扫描项目级 `.claude/skills`。 |
| `include_user` | 配置默认值 | 是否扫描用户级 `~/.claude/skills`。 |
| `limit` | 配置默认值 | 最多返回多少个 Skill，范围 1 到 100。 |

### 输出

```json
{
  "schema_version": 1,
  "enabled": true,
  "default_mode": "list",
  "skills": [
    {
      "name": "code-review",
      "description": "审查 TypeScript 代码中的高风险缺陷。",
      "when_to_use": "当任务是代码审查、上线前检查或安全风险分析时使用。",
      "source": "project",
      "disable_model_invocation": false
    }
  ],
  "summary": "发现 1 个可见 Skill。"
}
```

### 使用场景

- 启动任务前选择合适 Skill。
- 验证项目级 `.claude/skills` 是否被扫描到。
- 决定后续任务 input 的 `skills.mode` 使用 `list`、`inline` 还是 `off`。

## 错误码

常见 `errors[].code`：

| 错误码 | 含义 |
|---|---|
| `unknown_agent_type` | 未知子代理类型。 |
| `unsafe_cwd` | 工作目录不安全或不在允许根目录内。 |
| `path_traversal` | 文件路径越界。 |
| `prompt_too_large` | 渲染后的 prompt 超过上限。 |
| `inline_file_too_large` | 内联文件内容过大。 |
| `agent_spawn_failed` | 子代理命令不存在或启动失败。 |
| `acp_initialize_failed` | ACP initialize 失败。 |
| `acp_session_new_failed` | ACP session/new 失败。 |
| `acp_prompt_failed` | ACP session/prompt 失败。 |
| `acp_auth_required` | ACP agent 要求认证但当前未配置认证流程。 |
| `permission_denied` | 权限策略拒绝。 |
| `timeout` | 任务 wall-clock 超时。 |
| `inactivity_timeout` | 长时间无 ACP 协议层活动；默认 15 秒，也用于 Host 未发送 cancellation 时的快速兜底。 |
| `cancelled` | 任务被取消。 |
| `process_exit_nonzero` | 子进程非零退出。 |
| `result_parse_failed` | 结果解析失败。 |
| `unauthorized_file_change` | 检测到未授权文件变更。 |
| `concurrency_conflict` | 并发或写冲突。 |
| `mcp_server_profile_not_allowed` | MCP profile 不允许当前 agent 使用。 |
| `invalid_input` | 输入非法。 |
| `internal_error` | 内部错误。 |

## API 组合建议

| 需求 | 组合 |
|---|---|
| 单任务同步且可被用户停止 | `subagent_run` |
| 单任务异步但用户停止 wait 时取消 | `subagent_start` -> `subagent_wait(task_ids=[id])` |
| 多任务全部完成后汇总且用户停止时全部取消 | 优先 `subagent_run_many(return_when="all_completed")`；兼容两步为 `subagent_start_many` -> `subagent_wait(...)` |
| 多任务先完成先处理 | `subagent_run_many(return_when="first_completed")` 或 `subagent_start_many` -> 循环 `subagent_wait(...)` |
| 多任务后台轮询 | `subagent_start_many` -> `subagent_wait(return_when="timeout_partial", timeout_secs=短, on_timeout="keep_running")` |
| 多轮修正 | `subagent_start(keep_alive=true)` -> `subagent_wait` -> `subagent_continue` -> `subagent_wait` -> `subagent_close` |
| 提前终止剩余任务 | `subagent_cancel` |
| 释放 session | `subagent_close` |
| 调试失败 | `subagent_result(include_events=true)` 或 `subagent_logs` |
