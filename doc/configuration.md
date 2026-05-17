# 配置文档：环境变量、agents.toml、安全与日志

本项目默认不需要配置文件。只有在需要自定义 agent、限制工作区、增加 MCP server profile、调整权限或强化安全策略时，才需要创建 `agents.toml` 或设置环境变量。

## 配置加载优先级

1. 命令行 `--config /path/to/agents.toml`。
2. 环境变量 `ACP_SUBAGENT_CONFIG=/path/to/agents.toml`。
3. 当前目录下的 `agents.toml`。
4. 内置默认配置。

生成默认配置：

```bash
acp-subagent-mcp --print-default-config > agents.toml
```

## 默认运行参数

```toml
[defaults]
default_agent = "claude"
timeout_secs = 600
inactivity_timeout_secs = 15
max_depth = 2
max_prompt_chars = 120000
max_inline_file_chars = 30000
log_dir = ".subagents/runs"
mcp_request_heartbeat_ms = 1000
acp_cancel_grace_ms = 500
process_kill_grace_ms = 500
```

与停止和清理相关的值：

| 配置 | 作用 |
|---|---|
| `timeout_secs` | 单个子代理任务的总超时。 |
| `inactivity_timeout_secs` | 无 ACP 协议层活动时的兜底超时。 |
| `mcp_request_heartbeat_ms` | 长同步 tool call 期间向支持 progress 的 Host 发送心跳；发送失败会触发本地 abort。 |
| `acp_cancel_grace_ms` | request cancellation 后等待 ACP cancel 正常完成的时间。 |
| `process_kill_grace_ms` | 本地进程树 SIGTERM 后进入 SIGKILL 的等待时间。 |

同步版本没有后台任务保活或 session 保活配置。最大并发由 `[concurrency].max_parallel_tasks` 控制。

## 默认 agent

```toml
[agents.claude]
description = "默认 Claude ACP 子代理。"
command = "claude-agent-acp"
args = []
capabilities = ["claude", "code", "review", "analysis", "edit"]
env_policy = "all"
env_allowlist = ["ANTHROPIC_*", "CLAUDE_*", "PATH", "HOME", "USERPROFILE"]
install_hint = "请确认 claude-agent-acp 已在 PATH，或用 ACP_SUBAGENT_DEFAULT_AGENT_COMMAND 指定绝对路径。本包不会自动安装具体子代理 adapter。"
```

本 MCP 包不会自动安装具体 ACP adapter。请确保 `command` 在 MCP Server 进程的 `PATH` 中，或改成绝对路径。

## 环境变量继承策略

子代理能看到哪些环境变量，由两层决定：

1. MCP Host 先决定哪些环境变量传给 `@rvaim/acp-subagent-mcp` 进程。
2. 本服务再根据 agent 的 `env_policy` 决定传给子代理进程。

| 策略 | 含义 |
|---|---|
| `all` | 继承 MCP Server 进程可见的全部环境变量，再叠加 agent 显式 `env`。 |
| `allowlist` | 只继承 `env_allowlist` 命中的变量，再叠加显式 `env`。 |
| `none` | 只传最小运行环境和显式 `env`。 |

全局环境变量：

```bash
ACP_SUBAGENT_ENV_POLICY=allowlist
ACP_SUBAGENT_ENV_ALLOWLIST='HOME,PATH,ANTHROPIC_*,CLAUDE_*,OPENAI_API_KEY,HTTPS_PROXY,HTTP_PROXY,NO_PROXY'
```

`ACP_SUBAGENT_ENV_ALLOWLIST` 支持精确变量名和前缀通配。

## 常用环境变量

| 变量 | 作用 | 默认值 |
|---|---|---|
| `ACP_SUBAGENT_CONFIG` | 高级配置文件路径 | 自动查找 `agents.toml` |
| `ACP_SUBAGENT_DEFAULT_AGENT` | 默认子代理名称 | `claude` |
| `ACP_SUBAGENT_DEFAULT_AGENT_COMMAND` | 默认 ACP 子代理命令 | `claude-agent-acp` |
| `ACP_SUBAGENT_DEFAULT_AGENT_ARGS` | 默认 ACP 子代理参数，支持 JSON array | 空 |
| `ACP_SUBAGENT_DEFAULT_AGENT_ENV_JSON` | 默认 agent 显式 env 配置 | 空 |
| `ACP_SUBAGENT_ENV_POLICY` | 默认环境继承策略：`all/allowlist/none` | `all` |
| `ACP_SUBAGENT_ENV_ALLOWLIST` | `allowlist` 策略使用的变量名或前缀通配列表 | 空 |
| `ACP_SUBAGENT_AGENTS_JSON` | 用 JSON 添加或覆盖 agent 配置 | 空 |
| `ACP_SUBAGENT_MCP_SERVERS_JSON` | 用 JSON 添加 MCP server profile | 空 |
| `ACP_SUBAGENT_WORKSPACE_ROOTS` | 严格限制子代理可使用的工作区根目录 | 空 |
| `ACP_SUBAGENT_AUTO_WORKSPACE_ROOTS` | 未设置严格根目录时，是否自动信任本次 `cwd` | `true` |
| `ACP_SUBAGENT_ALLOW_NETWORK` | 策略声明：是否允许网络 | `false` |
| `ACP_SUBAGENT_REQUIRE_ABSOLUTE_AGENT_COMMAND` | agent command 是否必须绝对路径 | `false` |
| `ACP_SUBAGENT_TIMEOUT_SECS` | 默认任务总超时 | `600` |
| `ACP_SUBAGENT_INACTIVITY_TIMEOUT_SECS` | 默认无活动超时 | `15` |
| `ACP_SUBAGENT_MCP_REQUEST_HEARTBEAT_MS` | 长同步请求 heartbeat 间隔；`0` 表示关闭 | `1000` |
| `ACP_SUBAGENT_ACP_CANCEL_GRACE_MS` | ACP cancel 宽限时间 | `500` |
| `ACP_SUBAGENT_PROCESS_KILL_GRACE_MS` | SIGTERM 后 SIGKILL 宽限时间 | `500` |
| `ACP_SUBAGENT_MAX_PARALLEL_TASKS` | 最大并发任务数 | `4` |
| `ACP_SUBAGENT_LOG_DIR` | 日志目录 | `.subagents/runs` |
| `ACP_SUBAGENT_REDACT_LOGS` | 是否脱敏日志 | `true` |
| `ACP_SUBAGENT_WORKTREE_ENABLED` | 是否启用 worktree 沙箱 | `false` |
| `ACP_SUBAGENT_SKILLS` | Skill 配置 JSON | 空 |
| `ACP_SUBAGENT_SKILLS_ENABLED` | 是否启用 Skill 桥接 | `true` |
| `ACP_SUBAGENT_SKILL_MODE` | Skill 注入模式：`off/list/inline` | `list` |
| `ACP_SUBAGENT_SKILL_INCLUDE_PROJECT` | 是否扫描项目级 `.claude/skills` | `true` |
| `ACP_SUBAGENT_SKILL_INCLUDE_USER` | 是否扫描用户级 `~/.claude/skills` | `true` |
| `ACP_SUBAGENT_SKILL_ROOTS` | 额外 Skill 根目录 | 空 |
| `ACP_SUBAGENT_SKILL_NAMES` | inline 默认 Skill 名称 | 空 |
| `ACP_SUBAGENT_SKILL_MAX_SKILLS` | list 模式最多列出 Skill 数 | `20` |
| `ACP_SUBAGENT_SKILL_MAX_DESCRIPTION_CHARS` | 单个 Skill 描述最大字符数 | `360` |
| `ACP_SUBAGENT_SKILL_MAX_CHARS` | 单个内联 Skill 最大字符数 | `8000` |
| `ACP_SUBAGENT_SKILL_MAX_TOTAL_CHARS` | 单次 prompt 内联 Skill 总字符数 | `20000` |

## 工作区根目录

默认行为：主 agent 传入的 `cwd` 会被视为当前工作区。如果要做严格白名单限制：

```bash
ACP_SUBAGENT_WORKSPACE_ROOTS=/Users/you/workspace
```

多个目录可以用逗号分隔，也可以用 JSON 数组：

```bash
ACP_SUBAGENT_WORKSPACE_ROOTS='/Users/you/workspace,/tmp'
ACP_SUBAGENT_WORKSPACE_ROOTS='["/Users/you/workspace","/tmp"]'
```

对应 TOML：

```toml
[security]
allowed_cwd_roots = ["/Users/you/workspace"]
auto_workspace_roots = true
allow_network = false
max_read_file_bytes = 1048576
require_absolute_agent_command = false
```

## 并发配置

```toml
[concurrency]
max_parallel_tasks = 4
default_conflict_policy = "single_writer_per_cwd"
```

冲突策略：

| 策略 | 说明 |
|---|---|
| `allow_readonly_parallel` | 允许只读任务并行。 |
| `single_writer_per_cwd` | 同一工作区只允许一个写任务，默认策略。 |
| `sandbox_worktree` | 使用 git worktree 沙箱执行写任务；需要启用 worktree。 |

## 权限配置

```toml
[permissions.default]
read = "allow"
search = "allow"
edit = "deny"
execute = "deny"
network = "deny"

[permissions.claude]
read = "allow"
search = "allow"
edit = "allow"
execute = "deny"
network = "deny"
```

权限是传给 ACP 子代理的声明，不是 OS 级沙箱。需要强隔离时，应配合容器、受限用户或系统级 sandbox。

## Worktree 沙箱

```toml
[worktree]
enabled = false
base_dir = ".subagents/worktrees"
keep_on_failure = true
keep_on_success = false
max_patch_bytes = 2000000
include_untracked = false
```

启用后，`conflict_policy="sandbox_worktree"` 会在 git worktree 中执行写任务，结束后生成 patch artifact。

## 日志配置

```toml
[logs]
enabled = true
redact = true
retention_days = 7
max_event_bytes = 10485760
max_stderr_bytes = 1048576
save_rendered_prompt = "redacted"
file_mode = "0600"
```

运行结果中的 `artifacts` 会给出本地日志路径。当前版本不提供日志读取工具，避免重新暴露长日志到主 agent token 上下文。

## MCP server profiles

工具输入不能传动态 MCP server command。需要让子代理连接额外 MCP Server 时，先在配置中声明 profile，然后在工具输入里用 `mcp_server_profiles` 引用名称。

```toml
[mcp_servers.filesystem]
enabled = false
transport = "stdio"
command = "/absolute/path/to/filesystem-mcp"
args = ["--stdio"]
allowed_agents = ["claude"]
```
