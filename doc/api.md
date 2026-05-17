# API 文档：MCP tools 输入输出

本文描述 `@rvaim/acp-subagent-mcp` 暴露给主 agent 的 MCP tools。所有工具返回 JSON object，同时也会被包装为 MCP text content，便于不支持 output schema 的 Host 使用。

## 工具总览

| 工具 | 语义 |
|---|---|
| `subagent_list` | 列出可用 agent、默认 agent、Skill 桥接状态。 |
| `subagent_run` | 同步运行一个 ACP 子代理。 |
| `subagent_run_many` | 同步并行运行多个 ACP 子代理，全部完成后返回。 |
| `subagent_revise` | 同步打回重写一个结果。 |
| `subagent_revise_many` | 同步并行打回重写多个结果，全部完成后返回。 |
| `subagent_skills` | 查询可桥接给子代理的 Skills。 |

所有运行类工具都没有后台 pending 结果接口。返回时相关子代理已经完成、失败、超时、取消或被清理。

## 通用输入结构

### `agent_type`

可选。省略时使用配置中的默认 agent，默认是 `claude`。

### `cwd`

子代理运行时工作目录。未传时会按以下顺序推断：

1. `CLAUDE_PROJECT_DIR`
2. `INIT_CWD`
3. `PWD`
4. MCP Server 进程当前目录

如果配置了 `ACP_SUBAGENT_WORKSPACE_ROOTS` 或 `[security].allowed_cwd_roots`，`cwd` 必须位于允许根目录内。

### `task`

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

必填字段：`title`、`goal`。

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

| 值 | 说明 |
|---|---|
| `analyze` | 默认分析任务。 |
| `review` | 审查任务，通常不应修改文件。 |
| `edit` | 修改指定文件。 |
| `implement` | 实现功能或修复。 |
| `debug` | 调试问题。 |
| `custom` | 自定义任务。 |

### `output`

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

## `subagent_run`

同步运行一个子代理。

### 输入

| 字段 | 必填 | 说明 |
|---|---:|---|
| `task` | 是 | 结构化任务。 |
| `agent_type` | 否 | 子代理类型。 |
| `cwd` | 否 | 工作目录。 |
| `timeout_secs` | 否 | 任务总超时。 |
| `inactivity_timeout_secs` | 否 | 无活动超时。 |
| `mode` | 否 | 任务模式，默认 `analyze`。 |
| `mcp_server_profiles` | 否 | 只允许引用服务端配置中的 profile。 |
| `skills` | 否 | Skill 桥接选项。 |
| `output` | 否 | 输出压缩选项。 |
| `conflict_policy` | 否 | 冲突策略。 |

### 输出

返回 `SubagentRunOutput`。

```json
{
  "schema_version": 1,
  "task_id": "task_abc123",
  "title": "审查登录模块",
  "status": "completed",
  "agent_type": "claude",
  "session_id": "...",
  "summary": "一句话总结",
  "result": "主要结果，可能截断",
  "findings": [],
  "files_changed": [],
  "risks": [],
  "next_steps": [],
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
  "truncated": false,
  "errors": []
}
```

`status` 可能为：`completed`、`partial`、`failed`、`timeout`、`cancelled`。

## `subagent_run_many`

同步并行运行多个子代理。内部并发，全部子任务进入终态后返回。

### 输入

```json
{
  "conflict_policy": "allow_readonly_parallel",
  "on_task_failure": "keep_others_running",
  "tasks": [
    {
      "cwd": "/repo/app",
      "mode": "review",
      "task": { "title": "审查 auth", "goal": "审查 auth 目录。" }
    },
    {
      "cwd": "/repo/app",
      "mode": "review",
      "task": { "title": "审查 billing", "goal": "审查 billing 目录。" }
    }
  ]
}
```

| 字段 | 必填 | 说明 |
|---|---:|---|
| `tasks` | 是 | 1 到 32 个任务；每项与 `subagent_run` 基本相同，但不能单独设置 `conflict_policy`。 |
| `conflict_policy` | 否 | 批量级冲突策略。 |
| `on_task_failure` | 否 | 启动阶段单项失败后是否取消已启动任务：`keep_others_running` / `cancel_all`。 |

### 输出

```json
{
  "schema_version": 1,
  "status": "completed",
  "completed": [
    { "index": 0, "task_id": "task_a", "title": "审查 auth", "status": "completed" }
  ],
  "failed": [],
  "rejected": [],
  "cancelled_task_ids": [],
  "elapsed_ms": 4567,
  "summary": "同步批量运行完成：成功 2 个，失败 0 个，启动拒绝 0 个，取消 0 个。"
}
```

`status` 可能为：`completed`、`partial`、`failed`、`cancelled`。

## `subagent_revise`

同步打回重写一个结果。

### 输入

```json
{
  "task_id": "task_abc123",
  "correction": {
    "reason": "上一轮结果没有列出证据。",
    "rejected_result": "可选：主 agent 摘出的被拒绝内容。",
    "expected_change": "补充证据、风险等级和修复建议。"
  },
  "message": "直接重新输出完整结果。"
}
```

| 字段 | 必填 | 说明 |
|---|---:|---|
| `correction.reason` | 是 | 打回原因。 |
| `task_id` | 否 | 推荐传入；来自运行结果。 |
| `task` | 否 | 当 `task_id` 不可用或要覆盖原任务时传入。 |
| `previous_result` | 否 | 当 `task_id` 不可用或要覆盖上一轮结果时传入。 |
| `message` | 否 | 额外重写指令。 |
| `additional_files` | 否 | 本轮新增或覆盖的文件描述。 |
| 其他运行字段 | 否 | `cwd`、`agent_type`、`timeout_secs`、`mode`、`skills`、`output`、`conflict_policy` 等。 |

如果只传 `task_id`，MCP Server 会从本进程内存中的已完成任务记录里提取原任务和上一轮结果。若服务端重启导致记录不存在，请传 `task` + `previous_result`。

输出仍是 `SubagentRunOutput`，并额外包含：

```json
{
  "revision_of_task_id": "task_abc123"
}
```

## `subagent_revise_many`

同步并行打回重写多个结果。

### 输入

```json
{
  "conflict_policy": "allow_readonly_parallel",
  "revisions": [
    {
      "task_id": "task_a",
      "correction": { "reason": "遗漏测试建议。", "expected_change": "补充测试建议。" }
    },
    {
      "task_id": "task_b",
      "correction": { "reason": "结论太泛。", "expected_change": "给出可执行修改点。" }
    }
  ]
}
```

输出结构与 `subagent_run_many` 相同。每个成功或失败的重写结果会尽量包含 `revision_of_task_id`。

## `subagent_list`

输入为空对象：

```json
{}
```

输出包含默认 agent、agent 列表、配置来源和 Skill 桥接状态。

## `subagent_skills`

用于查看当前工作区和用户目录中可桥接给子代理的 Skills。它不执行子代理。

## 错误对象

```json
{
  "code": "timeout",
  "recoverable": true,
  "user_message": "任务超时",
  "debug_message": "本地调试信息"
}
```

常见错误码：

| code | 含义 |
|---|---|
| `unknown_agent_type` | 未知 agent。 |
| `unsafe_cwd` | 工作目录不在允许范围内。 |
| `path_traversal` | 文件路径不安全。 |
| `agent_spawn_failed` | 子代理命令启动失败。 |
| `acp_auth_required` | 子代理 adapter 需要登录或凭据。 |
| `timeout` | 任务总超时。 |
| `inactivity_timeout` | 无活动超时。 |
| `cancelled` | request cancellation 或本地取消。 |
| `concurrency_conflict` | 并发冲突。 |
| `mcp_server_profile_not_allowed` | MCP server profile 未配置或不允许该 agent 使用。 |
| `invalid_input` | 输入不合法。 |

## 迁移提示

旧的后台式启动、等待、结果查询、继续、取消、关闭、日志读取工具已经删除。需要“多轮修正”时，使用 `subagent_revise` / `subagent_revise_many`，它们通过新同步任务携带上一轮结果和审核意见，而不是保留旧 ACP session。
