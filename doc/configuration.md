# 配置文档：环境变量、agents.toml、安全与日志

本项目默认不需要配置文件。只有在需要自定义 agent、限制工作区、增加 MCP server profile、调整权限或强化安全策略时，才需要创建 `agents.toml` 或设置环境变量。

## 配置加载优先级

启动时按以下优先级加载配置：

1. 命令行 `--config /path/to/agents.toml`。
2. 环境变量 `ACP_SUBAGENT_CONFIG=/path/to/agents.toml`。
3. 当前目录下的 `agents.toml`。
4. 内置默认配置。

可以生成默认配置：

```bash
acp-subagent-mcp --print-default-config > agents.toml
```

## 默认配置概览

默认 agent：

```toml
[agents.claude]
description = "默认 Claude ACP 子代理。"
command = "claude-agent-acp"
args = []
capabilities = ["claude", "code", "review", "analysis", "edit"]
env_policy = "all"
install_hint = "请确认 claude-agent-acp 已在 PATH，或用 ACP_SUBAGENT_DEFAULT_AGENT_COMMAND 指定绝对路径。本包不会自动安装具体子代理 adapter。"
```

默认运行参数：

```toml
[defaults]
default_agent = "claude"
timeout_secs = 600
inactivity_timeout_secs = 120
max_depth = 2
max_prompt_chars = 120000
max_inline_file_chars = 30000
log_dir = ".subagents/runs"
session_ttl_secs = 1800
completed_session_ttl_secs = 600
max_active_sessions = 4
acp_cancel_grace_ms = 3000
process_kill_grace_ms = 2000
```

默认并发：

```toml
[concurrency]
max_parallel_tasks = 4
default_conflict_policy = "single_writer_per_cwd"
```

默认权限：

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

## 环境变量继承策略

子代理能看到哪些环境变量，由两层决定：

1. MCP Host 先决定哪些环境变量传给 `acp-subagent-mcp` 进程。
2. `acp-subagent-mcp` 再根据 `env_policy` 决定传给子代理进程。

默认：

```text
ACP_SUBAGENT_ENV_POLICY=all
```

含义：子代理继承 MCP Server 进程可见的全部环境变量，再叠加 agent 的显式 `env` 配置。

### 可选策略

| 策略 | 含义 | 适合场景 |
|---|---|---|
| `all` | 继承 MCP Server 进程可见的全部环境变量 | 默认；最容易复用 Claude Code / Codex / Gemini CLI 的登录、代理、证书和配置。 |
| `allowlist` | 只继承允许列表命中的变量 | 生产环境或更严格的本地安全策略。 |
| `none` | 不继承业务环境变量，只保留 PATH/HOME/TMP/PWD 等运行必需变量 | 高隔离任务、测试或不需要认证的子代理。 |

全局配置：

```bash
ACP_SUBAGENT_ENV_POLICY=all
```

只继承白名单变量：

```bash
ACP_SUBAGENT_ENV_POLICY=allowlist
ACP_SUBAGENT_ENV_ALLOWLIST='HOME,PATH,ANTHROPIC_*,CLAUDE_*,OPENAI_API_KEY,HTTPS_PROXY,HTTP_PROXY,NO_PROXY'
```

`ACP_SUBAGENT_ENV_ALLOWLIST` 支持：

```text
ANTHROPIC_API_KEY  # 精确变量名
ANTHROPIC_*        # 前缀通配
```

### 按 agent 单独配置

环境变量层只保留通用入口：`ACP_SUBAGENT_ENV_POLICY` 和 `ACP_SUBAGENT_ENV_ALLOWLIST`。

如果某个子代理需要不同继承策略，请在 `agents.toml` 或 `ACP_SUBAGENT_AGENTS_JSON` 中配置该 agent。

```toml
[agents.claude]
env_policy = "all" # all | allowlist | none
env_allowlist = ["HOME", "PATH", "ANTHROPIC_*", "CLAUDE_*"]

[agents.claude.env]
# 显式覆盖变量；from_env 未设置时不会写入空字符串。
# ANTHROPIC_API_KEY = { from_env = "ANTHROPIC_API_KEY" }
```

也可以用 JSON 添加或覆盖 agent：

```bash
ACP_SUBAGENT_AGENTS_JSON='{
  "claude": {
    "description": "Claude ACP 子代理",
    "command": "claude-agent-acp",
    "args": [],
    "capabilities": ["code", "review", "edit"],
    "env_policy": "allowlist",
    "env_allowlist": ["HOME", "PATH", "ANTHROPIC_*", "CLAUDE_*"]
  }
}'
```

注意：`all` 更方便，但也意味着子代理进程能看到 MCP Server 进程里的密钥和代理配置。需要严格控制时，请改用 `allowlist`。

## 工作区根目录

普通用户不需要设置工作区根目录环境变量。默认行为是：

1. 主 agent 调用工具时传入 `cwd`，这个 `cwd` 就被视为当前工作区。
2. 如果工具调用没有传 `cwd`，会依次尝试 `CLAUDE_PROJECT_DIR`、`INIT_CWD`、`PWD`、MCP Server 进程当前目录。
3. 只有要在生产环境做严格白名单限制时，才需要设置 `ACP_SUBAGENT_WORKSPACE_ROOTS`。

严格限制示例：

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
| `ACP_SUBAGENT_WORKSPACE_ROOTS` | 可选；严格限制子代理可使用的工作区根目录 | 空，表示自动信任本次 `cwd` |
| `ACP_SUBAGENT_AUTO_WORKSPACE_ROOTS` | 未设置严格根目录时，是否自动信任本次 `cwd` | `true` |
| `ACP_SUBAGENT_ALLOW_NETWORK` | 策略声明：是否允许网络 | `false` |
| `ACP_SUBAGENT_REQUIRE_ABSOLUTE_AGENT_COMMAND` | agent command 是否必须绝对路径 | `false` |
| `ACP_SUBAGENT_TIMEOUT_SECS` | 默认任务超时 | `600` |
| `ACP_SUBAGENT_INACTIVITY_TIMEOUT_SECS` | 默认无活动超时 | `120` |
| `ACP_SUBAGENT_MAX_ACTIVE_SESSIONS` | 最大活跃 session 数 | `4` |
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

## 添加自定义 agent

### 使用 `agents.toml`

```toml
[agents.codex]
description = "Codex ACP 子代理"
command = "codex-acp"
args = []
capabilities = ["code", "review", "edit"]
env_policy = "all"
install_hint = "请确认 codex-acp 已在 PATH 中。"

[permissions.codex]
read = "allow"
search = "allow"
edit = "allow"
execute = "deny"
network = "deny"
```

### 使用环境变量

```bash
ACP_SUBAGENT_AGENTS_JSON='{
  "codex": {
    "description": "Codex ACP 子代理",
    "command": "codex-acp",
    "args": [],
    "capabilities": ["code", "review", "edit"],
    "env_policy": "all"
  }
}'
```

## MCP server profiles

工具输入中不能直接传动态 MCP server command，只能引用预先配置的 profile。

### 使用环境变量添加 profile

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

### 使用 `agents.toml` 添加 profile

```toml
[mcp_servers.filesystem]
enabled = true
transport = "stdio"
command = "/absolute/path/to/filesystem-mcp"
args = ["--stdio"]
allowed_agents = ["claude"]

[mcp_servers.filesystem.env]
# API_KEY = { from_env = "FILESYSTEM_API_KEY" }
```

工具调用中只能引用 profile 名称：

```json
{
  "mcp_server_profiles": ["filesystem"],
  "task": {
    "title": "使用文件系统 profile",
    "goal": "完成指定分析"
  }
}
```

## Skill 桥接配置

默认行为：

1. 扫描项目级 `.claude/skills`。
2. 扫描用户级 `~/.claude/skills`。
3. 可通过 `ACP_SUBAGENT_SKILL_ROOTS` 增加额外目录。
4. 默认只把 Skill 名称和描述注入给子代理，避免 token 爆炸。
5. 只有显式请求 `mode=inline` 且指定 `names` 时，才内联对应 `SKILL.md`。

项目级 Skill 示例：

```text
my-project/
  .claude/
    skills/
      code-review/
        SKILL.md
```

`SKILL.md` 示例：

```markdown
---
name: code-review
description: 审查 TypeScript 代码中的高风险缺陷。
when_to_use: 当任务是代码审查、上线前检查或安全风险分析时使用。
---

请重点检查边界条件、错误处理、权限控制、并发风险和测试缺口。
```

TOML 配置：

```toml
[skills]
enabled = true
default_mode = "list"
include_project_skills = true
include_user_skills = true
discovery_roots = []
default_names = []
max_skills = 20
max_description_chars = 360
max_skill_chars = 8000
max_total_skill_chars = 20000
```

## 并发与冲突策略

```toml
[concurrency]
max_parallel_tasks = 4
default_conflict_policy = "single_writer_per_cwd"
```

| 策略 | 行为 |
|---|---|
| `allow_readonly_parallel` | 允许只读任务并行；同 cwd 写任务互斥。 |
| `single_writer_per_cwd` | 默认策略；同 cwd 同时只允许一个潜在写任务。 |
| `sandbox_worktree` | 写任务使用独立 git worktree，完成后提取 patch 文件。 |

使用 `sandbox_worktree` 前必须开启：

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

## 日志

每次运行生成一个目录：

```text
.subagents/runs/
  run_.../
    task.json
    rendered_prompt.md
    events.jsonl
    stderr.log
    result.json
```

默认日志会脱敏，并且 MCP 输出只返回路径。读取日志请使用 `subagent_logs`，该工具默认再次脱敏和截断。

TOML：

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

## 安全说明

权限策略首先是协议级控制：它决定向 ACP agent 声明哪些 client capabilities，并拦截 ACP `fs/*`、`terminal/*` 等请求。它不能替代操作系统级 sandbox。如果某个 ACP adapter 自己绕过 ACP client 方法直接访问磁盘或网络，MCP Server 不能单靠协议层完全阻止。生产环境建议配合容器、专用用户、git worktree 或文件系统 sandbox。

默认安全策略：

- `execute=deny`，不声明 ACP terminal capability。
- 动态 `mcp_servers` 禁用，只允许 `mcp_server_profiles`。
- 默认信任 tool 传入的 `cwd` 作为当前工作区；如设置 `ACP_SUBAGENT_WORKSPACE_ROOTS` 或 `allowed_cwd_roots`，则必须位于这些根目录内。
- 文件路径必须是相对路径，禁止路径穿越。
- inline/snippet、Skill inline 和 prompt 都有限制。
- 子进程默认 `env_policy=all`，会继承 MCP Server 进程可见的全部环境变量；生产环境可改用 `allowlist`。
- 日志默认脱敏。
- 超时、显式 `subagent_cancel`、`subagent_close(force=true)` 都会清理子进程树。
- Host 手动停止正在执行的 `subagent_run`、`subagent_run_many` 或 `subagent_wait` 时，MCP SDK 提供的 request `AbortSignal` 会触发 `forceCancelActiveTask()`：ACP `session/cancel` 只作为 best-effort，同时本地立即进入进程树清理。
- MCP transport 关闭、Node 收到 SIGINT/SIGTERM、进程即将退出时，会兜底关闭所有活跃子代理；Unix 下会同时清理 adapter 进程树、adapter process group 和可见孙进程自己的 process group。

## 已知边界

- Skill 桥接只能读取文件系统中的 Skill 定义，不能直接读取 MCP Host 私有运行时或 ChatGPT 内部 Skills。
- `sandbox_worktree` 只负责隔离和提取 patch，不负责自动合并。
- 网络禁用是策略声明，不是 OS 级防火墙。
- 真实 ACP agent 的兼容性仍需要逐个验证。
- MCP experimental Tasks 暂未接入；当前使用自定义 `subagent_start/wait/result/cancel` 工具面，兼容性更稳。
