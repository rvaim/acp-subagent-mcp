# MCP 工具 API 文档

本文说明本 MCP Server 对主代理暴露的工具。所有工具都返回 JSON 文本，同时尽量提供 `structuredContent`，方便 MCP Host 或主代理稳定消费。

## 通用约定

### `agent_type`

`agent_type` 必须是 `agents.toml` 中 `[agents.<name>]` 的 `<name>`。

工具调用者不能传 `command`、`args` 或 `env`。这样可以防止主代理或提示注入让 MCP Server 执行任意本地命令。

### `cwd`

`cwd` 是子代理处理项目时使用的工作目录。

要求：

- 必须是绝对路径。
- 必须位于 `[security].allowed_cwd_roots` 中任意根目录之下。
- 未传时使用 MCP Server 当前工作目录。

### `detail_level`

`detail_level` 控制返回给主代理的信息量：

| 值 | 含义 | 适合场景 |
|---|---|---|
| `summary` | 只返回摘要、结构化结果、错误和日志路径 | 默认模式，节省上下文 |
| `normal` | 返回工具调用摘要和更多文件信息 | 常规调试 |
| `verbose` | 尽量保留更多可见信息 | 排查子代理行为 |

完整 ACP 事件始终写入 `events.jsonl`，不会默认全部返回。

---

## 1. `subagent_list`

列出配置文件中可用的子代理。

### 输入

```json
{}
```

### 输出

```json
{
  "agents": [
    {
      "name": "fake",
      "description": "本地示例 ACP agent",
      "capabilities": ["analysis", "review", "demo"]
    }
  ]
}
```

### 安全说明

该工具不会返回：

- `command`
- `args`
- `env`
- token
- 本地敏感路径

---

## 2. `subagent_run`

同步运行一个子代理任务。工具会等待子代理完成后再返回结果。

### 输入

```json
{
  "agent_type": "fake",
  "cwd": "/absolute/path/to/project",
  "timeout_secs": 600,
  "inactivity_timeout_secs": 120,
  "heartbeat_timeout_secs": 3,
  "mode": "review",
  "session_pool_policy": "auto",
  "detail_level": "summary",
  "parent_agent_id": "main-agent-1",
  "task": {
    "title": "审查登录模块改动",
    "goal": "找出阻塞上线的问题",
    "background": "本次改动涉及登录和 session 续期。",
    "instructions": ["重点关注安全问题", "不要修改文件"],
    "files": [
      {
        "path": "src/auth/login.ts",
        "role": "primary",
        "action": "review",
        "content_mode": "path_only"
      }
    ],
    "constraints": ["不要修改文件", "只返回阻塞问题"],
    "expected_output": {
      "format": "structured",
      "required_sections": ["summary", "blocking_issues", "recommendation"],
      "include_risks": true,
      "include_next_steps": true
    },
    "success_criteria": ["列出所有阻塞问题", "给出是否可上线结论"],
    "parent_context": {
      "parent_agent": "main-agent-1",
      "conversation_summary": "用户要求检查登录模块是否可上线。",
      "previous_findings": ["refresh token 续期逻辑近期改过"]
    }
  }
}
```

### 输出

```json
{
  "status": "completed",
  "agent_type": "fake",
  "session_id": "fake_session_1",
  "summary": "示例 ACP agent 已完成任务",
  "result": "主要结论",
  "structured": {
    "status": "completed",
    "summary": "示例 ACP agent 已完成任务",
    "result": "主要结论",
    "findings": [],
    "files_changed": [],
    "risks": [],
    "next_steps": [],
    "errors": []
  },
  "stop_reason": "end_turn",
  "elapsed_ms": 1234,
  "reused_session": false,
  "files_touched": [],
  "raw_event_log_path": ".subagent-runs/run_xxx/events.jsonl",
  "errors": []
}
```

### 状态值

| 状态 | 含义 |
|---|---|
| `completed` | 子代理成功完成 |
| `partial` | 子代理部分完成 |
| `failed` | 子代理失败 |
| `timeout` | wall-clock 或 inactivity 超时 |
| `heartbeat_timeout` | 心跳超时 |
| `cancelled` | 任务被取消 |

---

## 3. `subagent_start`

启动一个有状态子代理任务，立即返回 `task_id`。适合长任务、多轮修正和异步等待。

### 输入

与 `subagent_run` 基本一致，额外支持：

```json
{
  "keep_alive": true
}
```

`keep_alive=true` 表示任务完成后保留 ACP session，后续可以用 `subagent_continue` 打回修正或继续处理。

### 输出

```json
{
  "status": "started",
  "task_id": "task_abc123",
  "agent_type": "fake",
  "session_id": "fake_session_1",
  "reused_session": false,
  "created_at": "2026-05-18T10:00:00.000Z"
}
```

说明：`session_id` 是可选字段。因为 `subagent_start` 会尽快返回，后台任务可能尚未完成 ACP 初始化和 `session/new`。

---

## 4. `subagent_start_many`

并行启动多个任务。

### 输入

```json
{
  "tasks": [
    {
      "agent_type": "fake",
      "cwd": "/absolute/path/to/project",
      "task": {
        "title": "审查模块 A",
        "goal": "检查模块 A 是否有阻塞问题"
      }
    },
    {
      "agent_type": "fake",
      "cwd": "/absolute/path/to/project",
      "task": {
        "title": "审查模块 B",
        "goal": "检查模块 B 是否有阻塞问题"
      }
    }
  ],
  "conflict_policy": "single_writer_per_cwd",
  "on_task_failure": "keep_others_running"
}
```

### 输出

```json
{
  "status": "started",
  "started": [
    {
      "status": "started",
      "task_id": "task_a",
      "agent_type": "fake",
      "created_at": "2026-05-18T10:00:00.000Z"
    }
  ],
  "failed": []
}
```

---

## 5. `subagent_wait`

等待一个或多个任务完成或更新。

### 输入

```json
{
  "task_ids": ["task_a", "task_b"],
  "return_when": "first_completed",
  "timeout_secs": 30,
  "on_timeout": "keep_running"
}
```

### `return_when`

| 值 | 行为 |
|---|---|
| `all_completed` | 等全部任务进入终态 |
| `first_completed` | 任意任务进入终态就返回 |
| `first_success` | 任意任务成功完成就返回 |
| `first_failure` | 任意任务失败就返回 |
| `any_update` | 当前实现中等价于有可见完成结果时返回 |
| `timeout_partial` | 超时后返回已有结果 |

### 输出

```json
{
  "status": "partial",
  "completed": [],
  "failed": [],
  "pending_task_ids": ["task_a"],
  "cancelled_task_ids": [],
  "elapsed_ms": 30000
}
```

---

## 6. `subagent_result`

查询某个任务当前状态。

### 输入

```json
{
  "task_id": "task_a",
  "detail_level": "summary"
}
```

### 输出

```json
{
  "task_id": "task_a",
  "agent_type": "fake",
  "status": "running",
  "latest_summary": "子代理正在处理",
  "partial_output": "部分可见输出",
  "raw_event_log_path": ".subagent-runs/run_xxx/events.jsonl"
}
```

任务完成后会包含 `result`。

---

## 7. `subagent_continue`

对同一个 ACP session 继续发消息。

### 前提

必须先用 `subagent_start` 启动，并设置 `keep_alive=true`。

### 输入

```json
{
  "task_id": "task_a",
  "mode": "fix",
  "message": "你刚才的修复不正确，请同时更新 refresh token 过期时间并补测试。",
  "correction": {
    "reason": "上一轮没有更新 refresh token expiry",
    "rejected_result": "只更新了 access token",
    "expected_change": "同时更新 refresh token 过期时间"
  },
  "additional_files": [
    {
      "path": "src/auth/session.ts",
      "role": "primary",
      "action": "edit"
    }
  ],
  "timeout_secs": 600,
  "detail_level": "normal"
}
```

### 输出

返回结构与 `subagent_run` 一致。

---

## 8. `subagent_cancel`

取消一个或多个任务。

### 输入

```json
{
  "task_ids": ["task_a", "task_b"],
  "reason": "用户停止任务"
}
```

### 行为

- 标记任务为 `cancelled`。
- 如果已有 ACP session，则发送 `session/cancel`。
- 终止子进程。
- 保留日志。

---

## 9. `subagent_close`

关闭任务和 session。

### 输入

```json
{
  "task_id": "task_a",
  "force": false
}
```

### 行为

- 任务运行中且 `force=false` 时拒绝关闭。
- `force=true` 时先取消，再清理进程。
- 尝试调用 ACP `session/close`，如果 agent 不支持则忽略。
- 保留日志。

---

## 10. `subagent_logs`

读取任务日志尾部。

### 输入

```json
{
  "task_id": "task_a",
  "kind": "events",
  "max_chars": 12000
}
```

### `kind`

| 值 | 文件 |
|---|---|
| `task` | `task.json` |
| `prompt` | `rendered_prompt.md` |
| `events` | `events.jsonl` |
| `stderr` | `stderr.log` |
| `result` | `result.json` |

### 输出

```json
{
  "task_id": "task_a",
  "path": ".subagent-runs/run_xxx/events.jsonl",
  "content": "...",
  "truncated": false
}
```
